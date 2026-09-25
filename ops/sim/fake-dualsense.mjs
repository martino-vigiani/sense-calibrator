// DualSense virtuale al livello WebHID: input report 0x01 a ~250 Hz, feature
// report 0x82/0x83 con un modello firmware della calibrazione del centro.
// Unità interne: LSB del byte di report (1 LSB = 0.784% di deflessione).
//
// Portato dal prototipo di analisi. Vincolo: la sequenza di chiamate al
// generatore casuale sul percorso Quick è identica al prototipo (report,
// latenze, campioni), altrimenti i risultati a parità di seed cambierebbero e
// l'equivalenza con l'harness pre-refactor non sarebbe più dimostrabile.
// Le aggiunte (NVS, unplug, guasti, contatori) non consumano numeri casuali
// finché non vengono usate.
const gauss = r => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
export function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export { gauss };

// Parole di stato NVS lette da DS5.queryNvStatus (getUint32 dal byte 1).
const NV_WORDS = { locked: 0x03030201, unlocked: 0x03030200, pending_reboot: 0x15010100 };
const OPS = { 1: 'begin', 2: 'end', 3: 'sample' };

// Dati di calibrazione "module" (0x80 [12,2] lettura / [12,1] scrittura), solo
// per la ricerca R1 (ops/hw-probe). Ordine dei 12 uint16 come in upstream
// (finetune-modal.js): 8 bordi del range, poi i 4 centri.
export const MODULE_FIELDS = ['LL', 'LT', 'RL', 'RT', 'LR', 'LB', 'RR', 'RB', 'LX', 'LY', 'RX', 'RY'];
// Tutto qui è un'IPOTESI, non una misura: la scala unità/LSB, il segno, i
// valori di base e il comportamento dei casi limite sono esattamente ciò che il
// protocollo R1 deve misurare sull'hardware. I default servono solo a dare al
// probe un firmware plausibile contro cui girare; ogni opzione ha un'alternativa
// così i test possono verificare che il probe distingua le ipotesi.
export const MODULE_DEFAULTS = {
  // Unità del valore a 16 bit per 1 LSB del byte di report (segno incluso).
  // Segnaposto: il report protocollo stima "circa 256× più fine", mai misurato.
  unitsPerLsb: 64,
  // Valori di partenza: 8 bordi plausibili e i centri a metà scala.
  range: [2400, 2400, 2400, 2400, 63100, 63100, 63100, 63100],
  centerBase: [32768, 32768, 32768, 32768],
  // p2 della risposta a [12,2]: upstream accetta 2 o 4 senza spiegare il 4.
  readP2: 2,
  // [12,1] ha effetto sui centri in RAM (true) o viene ignorato (false).
  writeApplies: true,
  // Una scrittura (calibEnd o [12,1]) con NVS aperta finisce subito anche in
  // memoria permanente: è l'etichetta "unlocked = permanent" di upstream (F2).
  unlockedWritesPersist: true,
  // calibEnd senza campioni: 'keep' (centro invariato, il comportamento storico
  // del fake) oppure 'raw' (centro azzerato: l'uscita torna alla posizione grezza).
  zeroSampleEnd: 'keep',
  // Aggregazione dei calibSample: 0 = media di tutti; N > 0 = media degli ultimi N.
  lastN: 0,
  // calibBegin con una sessione già aperta: 'reopen' (il fake storico riparte
  // da capo) oppure 'refuse' (risposta con codice 3, sessione di prima intatta:
  // il firmware come lo descrive DS5.calibBegin). Serve ai test del blocco di
  // spegnimento: con 'reopen' una riparazione che committa un parziale non si vede.
  beginWhileOpen: 'reopen',
};

export class FakeDualSense {
  // stick: [{ drift:[dx,dy] (LSB, posizione a riposo meno centro firmware),
  //           noise: sigma LSB, bias:{axis,B} errore di cattura persistente }]
  // faults: funzioni ({ id, buf, op, counts }) → Error | null, controllate
  //         prima di ogni feature report in uscita (solo per i test).
  // module: override di MODULE_DEFAULTS (ricerca R1). Senza scritture [12,x]
  //         non cambia nulla del comportamento né della sequenza casuale.
  constructor({ clock, seed, sticks, fw, timing, hand = {}, faults = [], name = 'Virtual DualSense', module = {} }) {
    this.clock = clock; this.r = rng(seed);
    this.opened = true; this.productName = name;
    this.vendorId = 0x054c; this.productId = 0x0ce6;
    this.collections = [{ inputReports: [{ reportId: 0x01 }], featureReports: [
      { reportId: 0x80, items: [{ reportCount: 63 }] }, { reportId: 0x81, items: [{ reportCount: 63 }] },
      { reportId: 0x82, items: [{ reportCount: 63 }] }, { reportId: 0x83, items: [{ reportCount: 63 }] }] }];
    this.oninputreport = null;
    this.sticks = sticks.map(s => ({ ...s, rest: [...s.drift], center: [0, 0] }));
    this.fw = fw; this.timing = timing; this.hand = hand;
    this.cal = null; this.response = [0x83, 0, 0, 0];
    this.touches = hand.schedule ?? [];
    this.stopped = false; this.reports = 0; this.calibEnds = 0;
    this.faults = faults;
    this.nvState = 'locked';
    // Ultima risposta preparata per 0x81 (stato NVS o dati [12,2]): come nel
    // firmware, 0x81 risponde all'ultimo comando 0x80.
    this.nvResponse = null;
    this.unplugged = false;
    // Contatori per le verifiche di sicurezza (comandi inviati, per opcode).
    this.counts = { begin: 0, sample: 0, end: 0, range: 0, other: 0, nvs: 0 };
    // Contatori separati per [12,x]: `counts` entra nei golden di equivalenza
    // (deepEqual), quindi non gli si aggiungono chiavi.
    this.moduleCounts = { read: 0, write: 0 };
    this.module = { ...MODULE_DEFAULTS, ...module };
    this.moduleRange = [...this.module.range];
    // Copia "in NVS" dei centri e dei bordi: la RAM riparte da qui a ogni
    // spegnimento (powerCycle). Un ciclo unlock → lock la aggiorna.
    this.stored = this.snapshotCal();
    this.commandLog = [];
    // Campioni di ogni sessione committata da un calibEnd (0 = riparazione).
    this.committedSamples = [];
    this.schedule();
  }
  // posizione fisica (LSB, rispetto al centro fisico) di un asse al tempo t
  pos(si, ax, t) {
    const s = this.sticks[si];
    let v = s.rest[ax] + s.noise * gauss(this.r);
    for (const h of this.touches) {
      if (h.stick !== si || t < h.t0 || t > h.t0 + h.dur + h.tail) continue;
      const a = t <= h.t0 + h.dur ? 1 : Math.exp(-(t - h.t0 - h.dur) / (h.tail / 4));
      // `at(t, ax)`: spostamento variabile nel tempo (scenari "moving"/"noisy"
      // di ops/sim/scenarios). Usa il proprio generatore, non this.r: gli
      // scenari non devono spostare la sequenza casuale del modello.
      v += a * (h.at ? h.at(t, ax) : h.amp[ax]);
    }
    return v;
  }
  byte(si, ax, t) { const x = this.pos(si, ax, t) - this.sticks[si].center[ax]; return Math.max(0, Math.min(255, Math.floor(128 + x))); }
  schedule() {
    if (this.stopped) return;
    const { period, jitter, gapProb, gapMs } = this.timing;
    let dt = period + jitter * gauss(this.r);
    if (this.r() < gapProb) dt += gapMs[0] + this.r() * (gapMs[1] - gapMs[0]);
    this.clock.setTimeout(() => { if (this.stopped) return; this.emit(); this.schedule(); }, Math.max(0.5, dt));
  }
  emit() {
    const t = this.clock.now();
    const buf = new Uint8Array(63);
    buf[0] = this.byte(0, 0, t); buf[1] = this.byte(0, 1, t); buf[2] = this.byte(1, 0, t); buf[3] = this.byte(1, 1, t);
    buf[52] = 0x08; // batteria
    this.reports++;
    this.oninputreport?.({ reportId: 0x01, data: new DataView(buf.buffer), device: this });
  }
  latency() { return this.fw.cmdMs[0] + this.r() * (this.fw.cmdMs[1] - this.fw.cmdMs[0]); }
  closedError() { return Object.assign(new Error('The device is not opened.'), { name: 'InvalidStateError' }); }
  sendFeatureReport(id, buf) {
    if (this.unplugged || !this.opened) return Promise.reject(this.closedError());
    const op = id === 0x82 && buf[2] === 1 ? OPS[buf[0]] ?? 'other' : id === 0x82 && buf[2] === 2 ? 'range'
      : id === 0x80 && buf[0] === 12 ? (buf[1] === 1 ? 'moduleWrite' : buf[1] === 2 ? 'moduleRead' : 'other')
      : id === 0x80 ? 'nvs' : 'other';
    for (const fault of this.faults) {
      const error = fault({ id, buf, op, counts: this.counts });
      if (error) return Promise.reject(error);
    }
    if (op === 'moduleRead') this.moduleCounts.read += 1;
    else if (op === 'moduleWrite') this.moduleCounts.write += 1;
    else this.counts[op] += 1;
    this.commandLog.push({ t: this.clock.now(), id, op, bytes: [...buf.slice(0, 6)] });
    return new Promise((res, rej) => this.clock.setTimeout(() => {
      if (this.unplugged) { rej(this.closedError()); return; }
      this.command(id, buf); res();
    }, this.latency()));
  }
  receiveFeatureReport(id) {
    if (this.unplugged || !this.opened) return Promise.reject(this.closedError());
    return new Promise((res, rej) => this.clock.setTimeout(() => {
      if (this.unplugged) { rej(this.closedError()); return; }
      const b = new Uint8Array(63);
      b.set(id === 0x81 && this.nvResponse ? this.nvResponse : this.response);
      res(new DataView(b.buffer));
    }, this.latency()));
  }
  // Modello firmware (FITTED, vedi fit.mjs): il centro nuovo è la media delle
  // posizioni campionate + errore di cattura = bias persistente su un asse
  // (per stick, per sessione) + errore fresco per passata.
  command(id, buf) {
    if (id === 0x80) { this.nvsCommand(buf); return; }
    if (id !== 0x82) return;
    const [op, , tgt] = buf;
    const t = this.clock.now();
    // Range (target 2): solo lo stato di risposta, il modello non simula la corsa.
    if (tgt === 2) { this.response = op === 1 || op === 2 ? [0x83, 1, 2, op] : [0x83, 0, 0, 0]; return; }
    if (tgt !== 1) { this.response = [0x83, 0, 0, 0]; return; }
    if (op === 1) {
      if (this.cal && this.module.beginWhileOpen === 'refuse') { this.response = [0x83, 1, 1, 3]; return; }
      this.cal = this.sticks.map(() => [[], []]); this.response = [0x83, 1, 1, 1];
    }
    else if (op === 3) {
      if (!this.cal) { this.response = [0x83, 1, 1, 3]; return; }
      this.sticks.forEach((s, i) => { for (const ax of [0, 1]) this.cal[i][ax].push(this.pos(i, ax, t)); });
      this.response = [0x83, 1, 1, 1];
    } else if (op === 2) {
      if (this.cal) {
        this.committedSamples.push(this.cal[0][0].length);
        this.sticks.forEach((s, i) => {
          for (const ax of [0, 1]) {
            let xs = this.cal[i][ax];
            if (!xs.length) {
              // calibEnd senza campioni (percorso di riparazione di calibBegin):
              // cosa scriva il firmware è ignoto (H-d), qui è un'opzione.
              if (this.module.zeroSampleEnd === 'raw') s.center[ax] = 0;
              continue;
            }
            if (this.module.lastN > 0) xs = xs.slice(-this.module.lastN);
            const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
            const bias = s.bias.axis === ax ? s.bias.B : 0;
            s.center[ax] = mean + bias + this.fw.sf * gauss(this.r);
          }
        });
        this.calibEnds++;
        this.persistIfUnlocked();
      }
      this.cal = null; this.response = [0x83, 1, 1, 2];
    }
  }
  // NVS minimale: [3,3] stato, [3,2,…] unlock, [3,1] lock. Serve all'harness
  // del ciclo di vita (adopt, flash), non al modello di calibrazione.
  nvsCommand(buf) {
    const [a, b] = buf;
    if (a === 12) { this.moduleCommand(buf); return; }
    // Il lock che chiude un ciclo unlock → lock è il "salva" (flash): la RAM
    // diventa la copia permanente.
    if (a === 3 && b === 2) this.nvState = 'unlocked';
    else if (a === 3 && b === 1) {
      if (this.nvState === 'unlocked') this.stored = this.snapshotCal();
      this.nvState = 'locked';
    }
    const word = NV_WORDS[this.nvState];
    this.nvResponse = [0x81, (word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff];
  }
  // Centri correnti (LSB) e bordi, per la copia in NVS e per powerCycle.
  snapshotCal() {
    return { centers: this.sticks.map(s => [...s.center]), range: [...this.moduleRange] };
  }
  persistIfUnlocked() {
    if (this.nvState === 'unlocked' && this.module.unlockedWritesPersist) this.stored = this.snapshotCal();
  }
  // I 12 uint16 come li restituirebbe [12,2]: bordi, poi LX LY RX RY.
  moduleValues() {
    const { unitsPerLsb, centerBase } = this.module;
    const centers = [this.sticks[0].center[0], this.sticks[0].center[1], this.sticks[1].center[0], this.sticks[1].center[1]];
    const clamp = v => Math.max(0, Math.min(0xffff, Math.round(v)));
    return [...this.moduleRange.map(clamp), ...centers.map((c, k) => clamp(centerBase[k] + unitsPerLsb * c))];
  }
  // [12,2]: prepara la risposta 0x81 (validata dal probe come in upstream).
  // [12,1, lo0, hi0, …]: scrive i 12 valori in RAM, senza risposta (upstream
  // non legge alcun ack). Nessun numero casuale consumato.
  moduleCommand(buf) {
    const [, b] = buf;
    if (b === 2) {
      const reply = [0x81, 12, this.module.readP2, 2];
      for (const v of this.moduleValues()) reply.push(v & 0xff, v >> 8);
      this.nvResponse = reply;
      return;
    }
    if (b !== 1 || !this.module.writeApplies) return;
    const values = Array.from({ length: 12 }, (_, i) => buf[2 + 2 * i] | (buf[3 + 2 * i] << 8));
    this.moduleRange = values.slice(0, 8);
    const { unitsPerLsb, centerBase } = this.module;
    [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(([si, ax], k) => {
      this.sticks[si].center[ax] = (values[8 + k] - centerBase[k]) / unitsPerLsb;
    });
    this.persistIfUnlocked();
  }
  // Spegnimento e riaccensione (tenere PS 10 s): la RAM torna alla copia in
  // NVS, la sessione aperta si perde, la NVS riparte bloccata. La pagina vede
  // una disconnessione e deve ricostruire DS5: qui il dispositivo resta aperto.
  powerCycle() {
    this.sticks.forEach((s, i) => { s.center = [...this.stored.centers[i]]; });
    this.moduleRange = [...this.stored.range];
    this.cal = null;
    this.nvState = 'locked';
    this.response = [0x83, 0, 0, 0];
    this.nvResponse = null;
  }
  // Cavo staccato: niente più report, ogni comando fallisce come in WebHID.
  unplug() { this.unplugged = true; this.stopped = true; this.opened = false; }
  close() { this.stopped = true; this.opened = false; return Promise.resolve(); }
  open() { this.opened = true; return Promise.resolve(); }
}

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

export class FakeDualSense {
  // stick: [{ drift:[dx,dy] (LSB, posizione a riposo meno centro firmware),
  //           noise: sigma LSB, bias:{axis,B} errore di cattura persistente }]
  // faults: funzioni ({ id, buf, op, counts }) → Error | null, controllate
  //         prima di ogni feature report in uscita (solo per i test).
  constructor({ clock, seed, sticks, fw, timing, hand = {}, faults = [], name = 'Virtual DualSense' }) {
    this.clock = clock; this.r = rng(seed);
    this.opened = true; this.productName = name;
    this.vendorId = 0x054c; this.productId = 0x0ce6;
    this.collections = [{ inputReports: [{ reportId: 0x01 }], featureReports: [
      { reportId: 0x82, items: [{ reportCount: 63 }] }, { reportId: 0x83, items: [{ reportCount: 63 }] }] }];
    this.oninputreport = null;
    this.sticks = sticks.map(s => ({ ...s, rest: [...s.drift], center: [0, 0] }));
    this.fw = fw; this.timing = timing; this.hand = hand;
    this.cal = null; this.response = [0x83, 0, 0, 0];
    this.touches = hand.schedule ?? [];
    this.stopped = false; this.reports = 0; this.calibEnds = 0;
    this.faults = faults;
    this.nvState = 'locked';
    this.nvResponse = null;
    this.unplugged = false;
    // Contatori per le verifiche di sicurezza (comandi inviati, per opcode).
    this.counts = { begin: 0, sample: 0, end: 0, range: 0, other: 0, nvs: 0 };
    this.commandLog = [];
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
    const op = id === 0x82 && buf[2] === 1 ? OPS[buf[0]] ?? 'other' : id === 0x82 && buf[2] === 2 ? 'range' : id === 0x80 ? 'nvs' : 'other';
    for (const fault of this.faults) {
      const error = fault({ id, buf, op, counts: this.counts });
      if (error) return Promise.reject(error);
    }
    this.counts[op] += 1;
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
    if (op === 1) { this.cal = this.sticks.map(() => [[], []]); this.response = [0x83, 1, 1, 1]; }
    else if (op === 3) {
      if (!this.cal) { this.response = [0x83, 1, 1, 3]; return; }
      this.sticks.forEach((s, i) => { for (const ax of [0, 1]) this.cal[i][ax].push(this.pos(i, ax, t)); });
      this.response = [0x83, 1, 1, 1];
    } else if (op === 2) {
      if (this.cal) {
        this.sticks.forEach((s, i) => {
          for (const ax of [0, 1]) {
            const xs = this.cal[i][ax]; if (!xs.length) continue;
            const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
            const bias = s.bias.axis === ax ? s.bias.B : 0;
            s.center[ax] = mean + bias + this.fw.sf * gauss(this.r);
          }
        });
        this.calibEnds++;
      }
      this.cal = null; this.response = [0x83, 1, 1, 2];
    }
  }
  // NVS minimale: [3,3] stato, [3,2,…] unlock, [3,1] lock. Serve all'harness
  // del ciclo di vita (adopt, flash), non al modello di calibrazione.
  nvsCommand(buf) {
    const [a, b] = buf;
    if (a === 3 && b === 2) this.nvState = 'unlocked';
    else if (a === 3 && b === 1) this.nvState = 'locked';
    const word = NV_WORDS[this.nvState];
    this.nvResponse = [0x81, (word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff];
  }
  // Cavo staccato: niente più report, ogni comando fallisce come in WebHID.
  unplug() { this.unplugged = true; this.stopped = true; this.opened = false; }
  close() { this.stopped = true; this.opened = false; return Promise.resolve(); }
  open() { this.opened = true; return Promise.resolve(); }
}

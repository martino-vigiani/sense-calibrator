'use strict';

// Protocollo DualSense (DS5) via WebHID.
// Sequenze di calibrazione e NVS derivate da dualshock-tools
// (https://github.com/dualshock-tools/dualshock-tools.github.io, MIT).

export const SONY_VID = 0x054c;
export const DS5_PID = 0x0ce6;

export const HID_FILTERS = [{ vendorId: SONY_VID, productId: DS5_PID }];

const DS5_COLOR_MAP = {
  '00': 'White',
  '01': 'Midnight Black',
  '02': 'Cosmic Red',
  '03': 'Nova Pink',
  '04': 'Galactic Purple',
  '05': 'Starlight Blue',
  '06': 'Grey Camouflage',
  '07': 'Volcanic Red',
  '08': 'Sterling Silver',
  '09': 'Cobalt Blue',
  '10': 'Chroma Teal',
  '11': 'Chroma Indigo',
  '12': 'Chroma Pearl',
  '30': '30th Anniversary',
  'Z1': 'God of War Ragnarok',
  'Z2': 'Spider-Man 2',
  'Z3': 'Astro Bot',
  'Z4': 'Fortnite',
  'Z6': 'The Last of Us',
  'ZB': 'Icon Blue',
};

export function buf2hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ');
}

// Una risposta HID che non arriva mai (clone, firmware bloccato a metà
// sessione) lasciava la calibrazione appesa con `busy` alzato per sempre.
// 1 s è due ordini di grandezza sopra la latenza reale di un feature report.
export const HID_REPLY_TIMEOUT_MS = 1000;

// Testo mostrato quando il controller smette di rispondere. Finché le verifiche
// hardware H10/H11 non dicono cosa sopravvive a uno scollegamento USB, l'unica
// istruzione sicura è spegnerlo davvero.
export const POISONED_MESSAGE = 'The controller stopped responding. Turn it off (hold PS for 10 s), then reconnect it.';
export const NV_UNKNOWN_MESSAGE = 'Memory state unknown: turn the controller off (hold PS for 10 s), then reconnect it.';

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};

// Data di build del firmware ("Jun 24 2021", report 0x20). Analizzata solo in
// locale: non entra mai nella telemetria (contratto v1 a nove campi).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function parseBuildDate(text) {
  const m = /^\s*([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]) + 1;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (!month || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
  return { year, month, day };
}

// Firmware dei primi due anni: upstream (dualshock-tools) li blocca del tutto.
// Il nostro piccolo campione non mostra fallimenti, quindi qui è solo un
// avviso con conferma (piano C2-10), mai un blocco.
export function isOldFirmware(buildDate) {
  const parsed = parseBuildDate(buildDate);
  return parsed !== null && parsed.year >= 2020 && parsed.year <= 2021;
}

function timeoutError(what) {
  return Object.assign(new Error(`Controller not responding (${what} timed out)`), { name: 'TimeoutError', timeout: true });
}

export class DS5 {
  // options.timers: { setTimeout, clearTimeout } per il timeout delle risposte
  //   (nella pagina i timer del browser, nel simulatore l'orologio virtuale).
  // options.onPoison(error): chiamata una volta, quando il dispositivo diventa
  //   inutilizzabile; `error.committed` dice se il comando appeso era un commit.
  constructor(device, logger = null, { timers = defaultTimers, timeoutMs = HID_REPLY_TIMEOUT_MS, onPoison = null } = {}) {
    this.device = device;
    this.logger = logger;
    this.timers = timers;
    this.timeoutMs = timeoutMs;
    this.onPoison = onPoison;
    // Dopo un timeout la prossima risposta letta potrebbe essere quella del
    // comando scaduto: nessun altro comando su questa connessione. Solo una
    // nuova istanza (riconnessione) riparte pulita.
    this.poisoned = null;
    // Mutex: 0x80/0x81 e 0x82/0x83 sono coppie richiesta/risposta su feature
    // report condivisi. Due coppie interlacciate (doppio flash, due cicli) fanno
    // leggere a una la risposta dell'altra.
    this.queue = Promise.resolve();
  }

  log(msg) {
    if (this.logger) this.logger(msg);
  }

  get opened() {
    return this.device?.opened === true;
  }

  // Il DS5 via Bluetooth espone l'input report 0x31: i feature report di
  // calibrazione funzionano in modo affidabile solo via USB.
  isBluetooth() {
    return this.device.collections.some(c =>
      (c.inputReports || []).some(r => r.reportId === 0x31));
  }

  // Il buffer del feature report va riempito fino alla dimensione dichiarata
  // dal descrittore HID, altrimenti il firmware scarta il comando.
  allocReq(reportId, data) {
    let maxLen = data.length;
    for (const col of this.device.collections) {
      const fr = (col.featureReports || []).find(r => r.reportId === reportId);
      const [item] = fr?.items || [];
      if (item?.reportCount) { maxLen = item.reportCount; break; }
    }
    const out = new Uint8Array(maxLen);
    out.set(data.slice(0, maxLen));
    return out;
  }

  poisonedError() {
    return Object.assign(new Error(POISONED_MESSAGE, { cause: this.poisoned }), {
      name: 'PoisonedError',
      poisoned: true,
    });
  }

  poison(error) {
    if (this.poisoned) return;
    this.poisoned = error;
    this.log(`Controller not responding (${error.message}): no further commands until it is reconnected.`);
    try { this.onPoison?.(error); } catch { /* il callback UI non deve mascherare l'errore HID */ }
  }

  // Esegue `fn` da solo sul dispositivo. Un dispositivo avvelenato rifiuta
  // subito, prima di inviare qualunque byte.
  exclusive(fn) {
    const run = this.queue.then(() => {
      if (this.poisoned) throw this.poisonedError();
      return fn();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // Una promessa WebHID con un tetto di tempo. La risposta che arriva dopo lo
  // scadere viene ignorata (la promessa esterna è già rifiutata): non può
  // essere letta come risposta al comando successivo.
  withTimeout(promise, what) {
    return new Promise((resolve, reject) => {
      const id = this.timers.setTimeout(() => reject(timeoutError(what)), this.timeoutMs);
      promise.then(
        value => { this.timers.clearTimeout(id); resolve(value); },
        error => { this.timers.clearTimeout(id); reject(error); },
      );
    });
  }

  async sendFeature(reportId, data) {
    const buf = this.allocReq(reportId, data);
    this.log(`→ 0x${reportId.toString(16)} [${buf2hex(buf.slice(0, Math.max(data.length, 8)))}…]`);
    let pending;
    try {
      pending = this.device.sendFeatureReport(reportId, buf);
    } catch (error) {
      pending = Promise.reject(error);
    }
    try {
      await this.withTimeout(pending, `sendFeatureReport 0x${reportId.toString(16)}`);
    } catch (error) {
      if (error.timeout) throw error;
      throw new Error(`sendFeatureReport 0x${reportId.toString(16)} failed: ${error.message || error}`);
    }
  }

  async recvFeature(reportId) {
    let pending;
    try {
      pending = this.device.receiveFeatureReport(reportId);
    } catch (error) {
      pending = Promise.reject(error);
    }
    const view = await this.withTimeout(pending, `receiveFeatureReport 0x${reportId.toString(16)}`);
    this.log(`← 0x${reportId.toString(16)} [${buf2hex(view.buffer.slice(view.byteOffset, view.byteOffset + 12))}…]`);
    return view;
  }

  // Un errore dopo che il comando è partito (o un timeout, di cui non si sa se
  // il firmware l'abbia ricevuto) su un comando che committa va trattato come
  // commit: la RAM o la NVS possono essere cambiate. Ogni timeout avvelena.
  settleFailure(error, commits, sent) {
    if (commits && (sent || error.timeout)) error.committed = true;
    if (error.timeout) {
      this.poison(error);
      error.poisoned = true;
    }
    return error;
  }

  // Coppia richiesta/risposta sotto mutex e timeout.
  request(reportId, data, replyId, { commits = false } = {}) {
    return this.exclusive(async () => {
      let sent = false;
      try {
        await this.sendFeature(reportId, data);
        sent = true;
        return await this.recvFeature(replyId);
      } catch (error) {
        throw this.settleFailure(error, commits, sent);
      }
    });
  }

  receiveOnly(reportId) {
    return this.exclusive(async () => {
      try {
        return await this.recvFeature(reportId);
      } catch (error) {
        throw this.settleFailure(error, false, false);
      }
    });
  }

  // Invia un comando 0x82 e verifica la risposta su 0x83.
  // Ritorna { ok, word, code } — code è il byte di stato finale.
  async calibCommand(payload, expected, options = {}) {
    const data = await this.request(0x82, payload, 0x83, options);
    const word = data.getUint32(0, false);
    const code = data.getUint8(3);
    return { ok: word === expected, word, code };
  }

  // Se una calibrazione precedente si è interrotta a metà (controller scollegato,
  // comando rifiutato), la sessione resta aperta nel firmware e ogni avvio
  // successivo fallisce finché il controller non viene riavviato. Non esiste un
  // opcode di annullamento: l'unico modo di chiudere è committare. Qui si tenta
  // la chiusura e si riprova UNA volta, invece di scrivere una calibrazione
  // parziale sul percorso di errore.
  // `committed` segnala che la riparazione ha scritto in RAM: `calibEnd` è un
  // commit, quindi anche un avvio fallito può aver cambiato la calibrazione del
  // controller. Chi chiama deve alzare comunque lo stato "non salvato", o
  // l'utente crederebbe che non sia successo nulla.
  // Un calibEnd di riparazione scaduto conta come commit (non si sa se il
  // firmware l'abbia applicato), e il `committed` sopravvive anche se è il
  // secondo avvio a lanciare.
  // `repair: false` quando il chiamante sa o sospetta che la sessione aperta
  // sia un parziale di questa pagina (uno stallo, un errore a metà passata, uno
  // spegnimento dichiarato dall'utente ma non provato): allora niente calibEnd
  // di riparazione, che committerebbe quel parziale senza consenso. L'avvio
  // rifiutato lancia con `openSession: true` e nulla viene scritto.
  async calibBegin({ repair = true } = {}) {
    let r = await this.calibCommand([1, 1, 1], 0x83010101);
    let committed = false;
    if (!r.ok && !repair) {
      this.log('Center calibration refused: a calibration session may still be open. Not closing it (that would commit a partial calibration).');
      const error = new Error(`Center calibration refused: the controller still has a calibration session open (0x${r.word.toString(16)}). Restart it before calibrating again`);
      error.openSession = true;
      error.committed = false;
      throw error;
    }
    if (!r.ok) {
      this.log('Center calibration refused: closing a possibly stale session and retrying.');
      committed = await this.calibEnd().then(() => true, error => error?.committed === true);
      try {
        r = await this.calibCommand([1, 1, 1], 0x83010101);
      } catch (error) {
        if (committed) error.committed = true;
        throw error;
      }
    }
    if (!r.ok) {
      const error = new Error(`Failed to start center calibration (0x${r.word.toString(16)})`);
      error.committed = committed;
      throw error;
    }
    return { committed };
  }

  async calibSample() {
    const r = await this.calibCommand([3, 1, 1], 0x83010101);
    if (!r.ok) throw new Error(`Sampling failed (0x${r.word.toString(16)})`);
  }

  async calibEnd() {
    const r = await this.calibCommand([2, 1, 1], 0x83010102, { commits: true });
    if (!r.ok) throw new Error(`Failed to write center calibration (0x${r.word.toString(16)})`);
  }

  async rangeBegin() {
    const r = await this.calibCommand([1, 1, 2], 0x83010201);
    if (!r.ok) throw new Error(`Failed to start range calibration (0x${r.word.toString(16)})`);
  }

  // code 3 = sessione range già chiusa: non è un errore, ma questo rangeEnd non
  // ha committato nulla. Lo si dice a chi chiama invece di tacerlo, così la UI
  // non segna "non salvato" per una scrittura mai avvenuta.
  async rangeEnd() {
    const r = await this.calibCommand([2, 1, 2], 0x83010202, { commits: true });
    if (r.ok) return { alreadyClosed: false };
    if (r.code === 3) return { alreadyClosed: true };
    throw new Error(`Failed to close range calibration (0x${r.word.toString(16)})`);
  }

  // Sola lettura: nessuna scrittura alla connessione. Il lock automatico di
  // upstream resta rimandato finché la verifica hardware H3 non lo giustifica.
  async queryNvStatus() {
    try {
      const data = await this.request(0x80, [3, 3], 0x81);
      const ret = data.getUint32(1, false);
      if (ret === 0x15010100) return { status: 'pending_reboot', raw: ret };
      if (ret === 0x03030201) return { status: 'locked', raw: ret };
      if (ret === 0x03030200) return { status: 'unlocked', raw: ret };
      return { status: 'unknown', raw: ret };
    } catch (error) {
      return { status: 'error', error };
    }
  }

  // Una risposta 0x81 che non porta il proprio report id non è la risposta a
  // questo comando: meglio fallire che dichiarare riuscito un ciclo NVS.
  checkNvReply(view, what) {
    if (view.byteLength < 1 || view.getUint8(0) !== 0x81)
      throw new Error(`${what}: unexpected reply (${buf2hex(view.buffer.slice(view.byteOffset, view.byteOffset + 8))})`);
    return view;
  }

  async nvsUnlock() {
    const view = await this.request(0x80, [3, 2, 101, 50, 64, 12], 0x81, { commits: true });
    return this.checkNvReply(view, 'NVS unlock');
  }

  async nvsLock() {
    const view = await this.request(0x80, [3, 1], 0x81, { commits: true });
    return this.checkNvReply(view, 'NVS lock');
  }

  // Rende permanente la calibrazione corrente: ciclo unlock → lock della NVS,
  // identico al "Save changes" di dualshock-tools.
  // - Un timeout (dispositivo avvelenato) lascia lo stato della memoria ignoto:
  //   nessun nuovo tentativo, `nvUnknown` per la UI.
  // - L'unlock non si ripete mai: una seconda apertura della NVS è proprio la
  //   scrittura che non si vuole.
  // - Se il lock fallisce dopo un unlock riuscito la NVS può restare aperta,
  //   e ogni calibrazione "temporanea" successiva diventerebbe permanente:
  //   si ritenta il SOLO lock, una volta.
  async flash() {
    const unknown = cause => Object.assign(new Error(NV_UNKNOWN_MESSAGE, { cause }), {
      nvUnknown: true, poisoned: true, committed: true,
    });
    try {
      await this.nvsUnlock();
    } catch (error) {
      if (error.poisoned) throw unknown(error);
      await new Promise(r => this.timers.setTimeout(r, 500));
      throw new Error('NVS unlock failed', { cause: error });
    }
    try {
      await this.nvsLock();
    } catch (error) {
      if (error.poisoned) throw unknown(error);
      this.log(`NVS lock failed after unlock (${error.message}): retrying the lock once.`);
      try {
        await this.nvsLock();
      } catch (retryError) {
        if (retryError.poisoned) throw unknown(retryError);
        throw new Error('NVS lock failed: the memory may still be unlocked', { cause: retryError });
      }
    }
  }

  async reboot() {
    try {
      await this.exclusive(() => this.sendFeature(0x80, [1, 1]));
    } catch {
      // Il controller si disconnette subito: l'errore di I/O è atteso.
    }
  }

  async getSystemInfo(base, num, length, decode = true) {
    const data = await this.request(0x80, [base, num], 0x81);
    if (data.getUint8(1) !== base || data.getUint8(2) !== num || data.getUint8(3) !== 2)
      return null;
    const slice = data.buffer.slice(data.byteOffset + 4, data.byteOffset + 4 + length);
    return decode ? new TextDecoder().decode(slice) : buf2hex(slice);
  }

  async getSerial() {
    return await this.getSystemInfo(1, 19, 17);
  }

  colorFromSerial(serial) {
    if (!serial || serial.length < 6) return null;
    return DS5_COLOR_MAP[serial.slice(4, 6)] || null;
  }

  boardModel(hwinfo) {
    const a = (hwinfo >> 8) & 0xff;
    if (a === 0x03) return 'BDM-010';
    if (a === 0x04) return 'BDM-020';
    if (a === 0x05) return 'BDM-030';
    if (a === 0x06) return 'BDM-040';
    if (a === 0x07 || a === 0x08) return 'BDM-050';
    if (a === 0x09) return 'BDM-060R';
    if (a === 0x11) return 'BDM-060M';
    if (a === 0x13) return 'BDM-060X';
    return null;
  }

  async getInfo() {
    const info = {};
    try {
      const view = await this.receiveOnly(0x20);
      if (view.getUint8(0) === 0x20 && view.byteLength === 64) {
        const bytes = view.buffer.slice(view.byteOffset, view.byteOffset + 64);
        info.buildDate = new TextDecoder().decode(bytes.slice(1, 12)).replace(/\0/g, '').trim();
        info.buildTime = new TextDecoder().decode(bytes.slice(12, 20)).replace(/\0/g, '').trim();
        info.buildYear = parseBuildDate(info.buildDate)?.year ?? null;
        info.hwinfo = view.getUint32(24, true);
        info.fwversion = view.getUint32(28, true);
        info.board = this.boardModel(info.hwinfo);
      }
    } catch { /* non bloccante */ }
    try {
      info.serial = await this.getSerial();
      info.color = this.colorFromSerial(info.serial);
    } catch { /* non bloccante */ }
    return info;
  }

  parseBattery(data) {
    if (data.byteLength <= 52) return null;
    const bat = data.getUint8(52);
    const charge = bat & 0x0f;
    const status = bat >> 4;
    switch (status) {
      case 0: return { level: Math.min(charge * 10 + 5, 100), charging: false };
      case 1: return { level: Math.min(charge * 10 + 5, 100), charging: true };
      case 2: return { level: 100, charging: false, full: true };
      case 15: return { level: 0, charging: true };
      default: return null;
    }
  }

  async close() {
    if (this.device?.opened) await this.device.close();
  }
}

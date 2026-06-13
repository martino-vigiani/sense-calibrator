'use strict';

// Protocollo DualSense (DS5) via WebHID.
// Sequenze di calibrazione e NVS derivate da dualshock-tools
// (https://github.com/dualshock-tools/dualshock-tools.github.io, GPL-3.0).

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

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class DS5 {
  constructor(device, logger = null) {
    this.device = device;
    this.logger = logger;
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

  async sendFeature(reportId, data) {
    const buf = this.allocReq(reportId, data);
    this.log(`→ 0x${reportId.toString(16)} [${buf2hex(buf.slice(0, Math.max(data.length, 8)))}…]`);
    try {
      await this.device.sendFeatureReport(reportId, buf);
    } catch (error) {
      throw new Error(`sendFeatureReport 0x${reportId.toString(16)} failed: ${error.message || error}`);
    }
  }

  async recvFeature(reportId) {
    const view = await this.device.receiveFeatureReport(reportId);
    this.log(`← 0x${reportId.toString(16)} [${buf2hex(view.buffer.slice(0, 12))}…]`);
    return view;
  }

  // Invia un comando 0x82 e verifica la risposta su 0x83.
  // Ritorna { ok, word, code } — code è il byte di stato finale.
  async calibCommand(payload, expected) {
    await this.sendFeature(0x82, payload);
    const data = await this.recvFeature(0x83);
    const word = data.getUint32(0, false);
    const code = data.getUint8(3);
    return { ok: word === expected, word, code };
  }

  async calibBegin() {
    const r = await this.calibCommand([1, 1, 1], 0x83010101);
    if (!r.ok) throw new Error(`Failed to start center calibration (0x${r.word.toString(16)})`);
  }

  async calibSample() {
    const r = await this.calibCommand([3, 1, 1], 0x83010101);
    if (!r.ok) throw new Error(`Sampling failed (0x${r.word.toString(16)})`);
  }

  async calibEnd() {
    const r = await this.calibCommand([2, 1, 1], 0x83010102);
    if (!r.ok) throw new Error(`Failed to write center calibration (0x${r.word.toString(16)})`);
  }

  async rangeBegin() {
    const r = await this.calibCommand([1, 1, 2], 0x83010201);
    if (!r.ok) throw new Error(`Failed to start range calibration (0x${r.word.toString(16)})`);
  }

  async rangeEnd() {
    const r = await this.calibCommand([2, 1, 2], 0x83010202);
    // code 3 = calibrazione già chiusa: non è un errore reale.
    if (!r.ok && r.code !== 3)
      throw new Error(`Failed to close range calibration (0x${r.word.toString(16)})`);
  }

  async queryNvStatus() {
    try {
      await this.sendFeature(0x80, [3, 3]);
      const data = await this.recvFeature(0x81);
      const ret = data.getUint32(1, false);
      if (ret === 0x15010100) return { status: 'pending_reboot', raw: ret };
      if (ret === 0x03030201) return { status: 'locked', raw: ret };
      if (ret === 0x03030200) return { status: 'unlocked', raw: ret };
      return { status: 'unknown', raw: ret };
    } catch (error) {
      return { status: 'error', error };
    }
  }

  async nvsUnlock() {
    await this.sendFeature(0x80, [3, 2, 101, 50, 64, 12]);
    await this.recvFeature(0x81);
  }

  async nvsLock() {
    await this.sendFeature(0x80, [3, 1]);
    await this.recvFeature(0x81);
  }

  // Rende permanente la calibrazione corrente: ciclo unlock → lock della NVS,
  // identico al "Save changes" di dualshock-tools.
  async flash() {
    try {
      await this.nvsUnlock();
    } catch (error) {
      await sleep(500);
      throw new Error('NVS unlock failed', { cause: error });
    }
    await this.nvsLock();
  }

  async reboot() {
    try {
      await this.sendFeature(0x80, [1, 1]);
    } catch {
      // Il controller si disconnette subito: l'errore di I/O è atteso.
    }
  }

  async getSystemInfo(base, num, length, decode = true) {
    await this.sendFeature(0x80, [base, num]);
    const data = await this.recvFeature(0x81);
    if (data.getUint8(1) !== base || data.getUint8(2) !== num || data.getUint8(3) !== 2)
      return null;
    const slice = data.buffer.slice(4, 4 + length);
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
    if (a === 0x11) return 'BDM-060M';
    if (a === 0x13) return 'BDM-060X';
    return null;
  }

  async getInfo() {
    const info = {};
    try {
      const view = await this.recvFeature(0x20);
      if (view.getUint8(0) === 0x20 && view.buffer.byteLength === 64) {
        info.buildDate = new TextDecoder().decode(view.buffer.slice(1, 12)).trim();
        info.buildTime = new TextDecoder().decode(view.buffer.slice(12, 20)).trim();
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

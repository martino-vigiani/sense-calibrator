'use strict';

// Lettura e scrittura della calibrazione "module" del DualSense in RAM:
// 0x80 [12,2] → 0x81 (lettura) e 0x80 [12,1, 12 × uint16 LE] (scrittura).
// Sequenze e validazione da dualshock-tools (ds5-controller.js,
// getInMemoryModuleData / writeFinetuneData, MIT).
//
// SOLO RICERCA (R1). Questo file vive in ops/hw-probe e non deve mai essere
// importato da js/: la pagina pubblica non ha e non deve avere un percorso di
// scrittura [12,1] (piano C0-13, test/hw-probe-public-surface.test.js). Nessuna
// di queste funzioni è verificata sul nostro hardware: è ciò che il protocollo
// docs/hw-probe-protocol.md deve stabilire.

// Ordine dei 12 valori (upstream finetune-modal.js): 8 bordi del range, poi i
// centri per asse.
export const MODULE_FIELDS = ['LL', 'LT', 'RL', 'RT', 'LR', 'LB', 'RR', 'RB', 'LX', 'LY', 'RX', 'RY'];
export const RANGE_INDEXES = [0, 1, 2, 3, 4, 5, 6, 7];
export const CENTER_INDEXES = [8, 9, 10, 11];
export const CENTER_AXES = ['lx', 'ly', 'rx', 'ry'];

const READ_CMD = [12, 2];
const WRITE_CMD = [12, 1];
// Upstream aspetta 100 ms tra la richiesta [12,2] e la lettura di 0x81.
export const MODULE_READ_DELAY_MS = 100;

export function isModuleValues(values) {
  return Array.isArray(values) && values.length === 12
    && values.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffff);
}

// Payload di scrittura. Rifiuta tutto ciò che non è esattamente 12 interi a 16
// bit: un valore troncato o negativo finirebbe nei bordi o nei centri come un
// numero qualsiasi, senza errore dal firmware (non c'è ack).
export function encodeModuleWrite(values) {
  if (!isModuleValues(values)) throw new RangeError('module calibration must be 12 integers in 0..65535');
  const out = [...WRITE_CMD];
  for (const v of values) out.push(v & 0xff, v >> 8);
  return out;
}

// Risposta 0x81 a [12,2]. Stessa validazione di upstream: cmd 0x81, p1 12,
// p2 2 o 4 (il 4 non è spiegato: lo si registra), p3 2. Altrimenti null:
// una risposta che non porta queste intestazioni non è la nostra (per esempio
// una parola di stato NVS) e non va mai interpretata come calibrazione.
export function decodeModuleRead(view) {
  if (!view || view.byteLength < 4 + 24) return null;
  const cmd = view.getUint8(0);
  const [p1, p2, p3] = [1, 2, 3].map(i => view.getUint8(i));
  if (cmd !== 0x81 || p1 !== 12 || (p2 !== 2 && p2 !== 4) || p3 !== 2) return null;
  const values = Array.from({ length: 12 }, (_, i) => view.getUint16(4 + i * 2, true));
  return { values, p2 };
}

export function centersOf(values) {
  return Object.fromEntries(CENTER_INDEXES.map((idx, k) => [CENTER_AXES[k], values[idx]]));
}

export function sameValues(a, b) {
  return isModuleValues(a) && isModuleValues(b) && a.every((v, i) => v === b[i]);
}

// Differenza campo per campo (b − a), con i nomi: il diario del probe la
// registra così com'è, per capire quali campi tocca ogni comando.
export function diffValues(a, b) {
  const out = {};
  MODULE_FIELDS.forEach((name, i) => { if (a[i] !== b[i]) out[name] = b[i] - a[i]; });
  return out;
}

const sleepOn = (ds5, ms) => new Promise(resolve => ds5.timers.setTimeout(resolve, ms));

// Lettura sotto il mutex di DS5 (0x80/0x81 è una coppia condivisa con lo stato
// NVS): invio, attesa di 100 ms, lettura. Un timeout avvelena l'istanza come
// ogni altro comando. Ritorna { values, p2, raw } oppure null se la risposta
// non passa la validazione.
export async function readModuleCal(ds5) {
  const view = await ds5.exclusive(async () => {
    let sent = false;
    try {
      await ds5.sendFeature(0x80, READ_CMD);
      sent = true;
      await sleepOn(ds5, MODULE_READ_DELAY_MS);
      return await ds5.recvFeature(0x81);
    } catch (error) {
      throw ds5.settleFailure(error, false, sent);
    }
  });
  const decoded = decodeModuleRead(view);
  if (!decoded) return null;
  const raw = [...new Uint8Array(view.buffer, view.byteOffset, 4 + 24)];
  return { ...decoded, raw };
}

// Scrittura grezza in RAM. Il firmware non risponde: qualunque errore (anche
// prima che si sappia se i byte sono partiti) conta come scrittura avvenuta,
// perché la RAM può essere cambiata. Chi chiama deve aver già superato
// safety.mjs (armamento, NVS bloccata, valori ammessi).
export async function writeModuleCal(ds5, values) {
  const payload = encodeModuleWrite(values);
  return ds5.exclusive(async () => {
    try {
      await ds5.sendFeature(0x80, payload);
    } catch (error) {
      throw ds5.settleFailure(error, true, true);
    }
  });
}

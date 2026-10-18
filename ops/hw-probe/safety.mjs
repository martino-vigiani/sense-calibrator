'use strict';

// Regole di sicurezza del probe R1. Pure, senza DOM né HID: la pagina e i test
// usano le stesse funzioni.
//
// Il probe scrive in modo grezzo nella calibrazione del controller. Per questo:
// - gira solo su localhost (la cartella ops/ è comunque pubblicata da GitHub
//   Pages, quindi la pagina deve rifiutarsi di funzionare altrove);
// - non scrive nulla finché la persona non dichiara, su QUESTA connessione, che
//   il controller è uno di riserva (casella + parola digitata);
// - prima di ogni scrittura rilegge lo stato NVS e rifiuta se non è `locked`:
//   con la NVS aperta una scrittura "temporanea" potrebbe essere permanente;
// - scrive solo valori già letti dal controller, con scostamenti limitati sui
//   soli centri: mai un bordo del range inventato, mai un numero arbitrario;
// - non apre mai la NVS (niente unlock, niente flash).

export const LOCAL_PROBE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalProbeHost(hostname) {
  return LOCAL_PROBE_HOSTS.has(String(hostname ?? '').toLowerCase());
}

// La parola va digitata, non incollata da un suggerimento: serve a far leggere
// l'avvertenza, non a sembrare sicuri.
export const SPARE_PHRASE = 'SPARE';

// Scostamento massimo di un centro rispetto a un valore letto, in unità del
// valore a 16 bit. La scala unità/LSB è sconosciuta (è H-e a misurarla): 512 è
// 1/128 della scala intera, abbastanza per vedere la pendenza anche se servissero
// centinaia di unità per LSB, e abbastanza poco da restare lontano dai bordi.
export const MAX_CENTER_DELTA = 512;

// Passi che scrivono nella calibrazione del controller (RAM). H-c e H-d sono
// trattati come possibilmente permanenti (piano R1) e chiedono una seconda
// conferma esplicita.
export const WRITE_STEPS = new Set(['H-b', 'H-c', 'H-d', 'H-e', 'AB', 'restore', 'X-pass', 'X-fix']);
export const POSSIBLY_PERMANENT_STEPS = new Set(['H-c', 'H-d']);

// Stato di armamento legato a una connessione: una riconnessione (nuovo DS5)
// crea un nuovo stato, quindi disarma.
export function createArming(connectionId) {
  return { connectionId, spareChecked: false, phrase: '', armedAt: null };
}

export function arm(arming, { spareChecked, phrase, now = Date.now() }) {
  arming.spareChecked = spareChecked === true;
  arming.phrase = String(phrase ?? '');
  arming.armedAt = isArmed(arming, arming.connectionId) ? now : null;
  return arming.armedAt !== null;
}

export function isArmed(arming, connectionId) {
  return !!arming
    && arming.connectionId === connectionId
    && arming.spareChecked === true
    && arming.phrase.trim() === SPARE_PHRASE;
}

// Motivi per cui un passo di scrittura NON può partire. Lista vuota = permesso.
// `nv` è lo stato NVS appena riletto (non quello letto alla connessione).
export function writeRefusal({ step, hostname, arming, connectionId, nv, baseline, poisoned, needsPowerCycle }) {
  const reasons = [];
  if (!isLocalProbeHost(hostname)) reasons.push('the probe only runs on localhost');
  if (!isArmed(arming, connectionId)) reasons.push(`not armed: tick "spare controller" and type ${SPARE_PHRASE} on this connection`);
  if (poisoned) reasons.push('the controller stopped responding: reconnect it first');
  if (needsPowerCycle) reasons.push('a calibration session was left open or an X-pass stopped with RAM changed: power-cycle the controller first');
  if (!baseline) reasons.push('no valid [12,2] baseline read on this connection');
  if (nv?.status !== 'locked') reasons.push(`NVS is not locked (${nv?.status ?? 'not read'}): a write could become permanent`);
  if (!WRITE_STEPS.has(step)) reasons.push(`unknown write step ${step}`);
  return reasons;
}

// Controllo dei valori prima di [12,1]. `snapshots` sono le letture valide di
// questa connessione. I bordi (LL…RB) devono coincidere esattamente con quelli
// di una lettura; ogni centro deve stare entro `maxCenterDelta` dal centro
// della stessa lettura. Si sceglie la lettura più vicina che soddisfa tutto.
export function checkWriteValues(values, snapshots, { maxCenterDelta = MAX_CENTER_DELTA } = {}) {
  if (!Array.isArray(values) || values.length !== 12 || !values.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffff))
    return { ok: false, reason: 'values must be 12 integers in 0..65535' };
  if (!snapshots?.length) return { ok: false, reason: 'no snapshot read on this connection' };
  let sameRange = false;
  for (const snap of snapshots) {
    if (!snap.slice(0, 8).every((v, i) => v === values[i])) continue;
    sameRange = true;
    if (snap.slice(8).every((v, i) => Math.abs(values[8 + i] - v) <= maxCenterDelta)) return { ok: true, base: snap };
  }
  return {
    ok: false,
    reason: sameRange
      ? `a center moves more than ${maxCenterDelta} units from every value read`
      : 'range fields (LL…RB) differ from every value read: the probe never writes a range it did not read',
  };
}

// Regola di scrittura di X-fix (R1-X, docs/hw-probe-bdm040.md). La correzione
// di un errore di cattura di ~20 LSB può superare MAX_CENTER_DELTA a una scala
// sconosciuta, quindi X-fix ha una regola sua, separata e più stretta su tutto
// il resto: solo LX/LY, solo con la pendenza misurata da H-e su QUESTA
// connessione (R² ≥ 0.9, |u| ≥ 2 unità per LSB), solo fino a 24 LSB × |u|, e
// bordi del range e centri destri identici alla lettura da cui la correzione è
// stata calcolata. Ogni altro passo resta su checkWriteValues (±512): questa
// funzione rifiuta qualunque passo che non sia X-fix.
export const FIX_STEP = 'X-fix';
export const FIX_MAX_LSB = 24;
export const FIX_MIN_R2 = 0.9;
export const FIX_MIN_UNITS = 2;
const FIX_AXES = [['lx', 'LX', 8], ['ly', 'LY', 9]];

const isValues = v => Array.isArray(v) && v.length === 12 && v.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffff);

// La pendenza di H-e su un asse è adatta a una correzione? null = sì,
// altrimenti il motivo. `fit` è perAxis[axis] di H-e ({ unitsPerLsb, r2 }).
export function fixFitRefusal(fit, name) {
  if (!fit || !Number.isFinite(fit.unitsPerLsb) || !Number.isFinite(fit.r2) || fit.r2 < FIX_MIN_R2)
    return `H-e on this connection did not fit ${name} with R² ≥ ${FIX_MIN_R2}`;
  if (Math.abs(fit.unitsPerLsb) < FIX_MIN_UNITS) return `H-e on this connection found under ${FIX_MIN_UNITS} units per LSB on ${name}`;
  return null;
}

// step: il passo che chiede la scrittura. values: i 12 valori da scrivere.
// snapshot: la lettura [12,2] da cui sono stati calcolati; snapshots: le
// letture valide di questa connessione (snapshot deve essere una di esse).
// he: { connection, perAxis } della H-e usata; connectionId: questa connessione.
export function checkFixWrite({ step, values, snapshot, snapshots, he, connectionId }) {
  const refuse = reason => ({ ok: false, reason });
  if (step !== FIX_STEP) return refuse(`only ${FIX_STEP} may use the center-correction rule; ${step} keeps the ±${MAX_CENTER_DELTA} limit`);
  if (!isValues(values)) return refuse('values must be 12 integers in 0..65535');
  if (!isValues(snapshot) || !snapshots?.some(s => isValues(s) && s.every((v, i) => v === snapshot[i])))
    return refuse('the correction must start from a [12,2] read on this connection');
  if (!he || he.connection !== connectionId || !he.perAxis) return refuse('no H-e on this connection: the scale (units per LSB) is unknown');
  if (!snapshot.slice(0, 8).every((v, i) => v === values[i])) return refuse('range fields (LL…RB) must stay identical to the read');
  if (values[10] !== snapshot[10] || values[11] !== snapshot[11]) return refuse('right-stick centers (RX, RY) must stay identical to the read');
  for (const [axis, name, idx] of FIX_AXES) {
    const delta = values[idx] - snapshot[idx];
    if (delta === 0) continue;
    const fit = he.perAxis[axis];
    const why = fixFitRefusal(fit, name);
    if (why) return refuse(why);
    const max = FIX_MAX_LSB * Math.abs(fit.unitsPerLsb);
    if (Math.abs(delta) > max) return refuse(`${name} moves ${Math.abs(delta)} units, more than ${FIX_MAX_LSB} LSB × |u| = ${Math.round(max)}`);
  }
  return { ok: true };
}

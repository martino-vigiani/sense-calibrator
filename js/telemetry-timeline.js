'use strict';

// Cronologia di una visita per la telemetria v2: da quanto è stata fatta
// l'ultima calibrazione, cosa è successo da allora e dove si sono fermati gli
// stick a ogni rilascio. Pura: niente DOM, timer o HID; i tempi sono quelli di
// chi chiama (performance.now nella pagina), in ms, e restano qui dentro. I
// builder di js/telemetry-v2.js li arrotondano a 10 s prima che escano.
//
// Serve a separare due storie dietro "lo stick è di nuovo fuori centro poco
// dopo la calibrazione": la calibrazione persa (un Range, un riavvio, uno
// scollegamento in mezzo) e lo stick usurato che si ferma ogni volta in un
// punto diverso (dispersione dei rilasci, js/calib/landing.js).
//
// L'ancora è l'ultima calibrazione Quick o Guided che ha cambiato la RAM. Un
// controller diverso (chiave salata leggibile e diversa) la cancella: il suo
// stato non ha niente a che fare con la calibrazione dell'altro. Con una
// chiave illeggibile resta, e conta come 'reconnect'.

export const TIMELINE_DEFAULTS = Object.freeze({
  sendAt: 20,      // rilasci dopo una calibrazione che fanno partire l'evento 'count'
  maxSends: 2,     // eventi landing per caricamento di pagina
  maxStored: 500,  // rilasci tenuti per stick (i più recenti) per mediana e dispersione
});

const ANCHORS = new Set(['quick', 'guided']);
const OPS = new Set(['range', 'flash', 'reconnect', 'power-cycle']);

export function createCalTimeline(options = {}) {
  const p = { ...TIMELINE_DEFAULTS, ...options };
  let anchor = null;    // { at, ref, ops: [tipo, …] }
  let segment = null;   // rilasci dall'ancora (o dal caricamento)
  let key = null;       // chiave del controller collegato (o dell'ultimo)
  let wasDisconnected = false;
  let sends = 0;

  // `n` conta tutti i rilasci per stick, le liste tengono solo i più recenti.
  const newSegment = () => ({ count: 0, n: { left: 0, right: 0 }, left: [], right: [], countSent: false, sentAtCount: 0 });
  segment = newSegment();

  function op(type) {
    if (!anchor || !OPS.has(type) || anchor.ops.includes(type)) return;
    anchor.ops.push(type);
  }

  return {
    params: p,
    // Un evento di calibrazione (quick, guided, range). `ref` è il suo seq v2,
    // o null se non è partito (condivisione spenta, tetto per pagina).
    calibration({ type, committed, ref = null }, now) {
      if (committed !== true) return;
      if (ANCHORS.has(type)) {
        anchor = { at: now, ref: Number.isInteger(ref) ? ref : null, ops: [type] };
        segment = newSegment();
      } else if (type === 'range') op('range');
    },
    op(type) { op(type); },
    disconnected() { wasDisconnected = true; },
    // Collegamento (anche il primo). Un controller diverso azzera ancora e
    // rilasci; lo stesso, o uno che non si può distinguere, è un 'reconnect'.
    connected(nextKey) {
      const other = key !== null && nextKey !== null && nextKey !== undefined && nextKey !== key;
      if (other) {
        anchor = null;
        segment = newSegment();
      } else if (wasDisconnected) op('reconnect');
      if (nextKey !== null && nextKey !== undefined) key = nextKey;
      wasDisconnected = false;
    },
    // Un rilascio di createLandingDetector. Ritorna true quando, dopo una
    // calibrazione, i rilasci arrivano a `sendAt` e c'è ancora un invio.
    landing(l, now) {
      if (!l || (l.stick !== 'left' && l.stick !== 'right') || !Array.isArray(l.landAxes)) return false;
      const list = segment[l.stick];
      list.push({ stick: l.stick, landAxes: l.landAxes, sinceMs: anchor ? now - anchor.at : null });
      if (list.length > p.maxStored) list.shift();
      segment.n[l.stick] += 1;
      segment.count += 1;
      return !!anchor && !segment.countSent && segment.count >= p.sendAt && sends < p.maxSends;
    },
    // Campi dell'evento rest: null senza calibrazione.
    rest(now) {
      if (!anchor) return { sinceMs: null, ops: null, landings: null };
      return { sinceMs: now - anchor.at, ops: [...anchor.ops], landings: segment.count };
    },
    // Ciò che serve a buildLandingEvent, o null se non si può o non serve
    // inviare: budget finito, nessun rilascio, o niente di nuovo dall'ultimo
    // invio dello stesso segmento. Chi chiama, se l'evento parte, chiama sent().
    pending(trigger, now) {
      if (sends >= p.maxSends || !segment.count) return null;
      if (trigger === 'count' && (!anchor || segment.countSent)) return null;
      if (trigger === 'left' && segment.sentAtCount === segment.count) return null;
      return {
        trigger,
        ref: anchor?.ref ?? null,
        sinceMs: anchor ? now - anchor.at : null,
        ops: anchor ? [...anchor.ops] : null,
        counts: { ...segment.n },
        landings: [...segment.left, ...segment.right],
      };
    },
    sent(trigger) {
      sends += 1;
      if (trigger === 'count') segment.countSent = true;
      segment.sentAtCount = segment.count;
    },
    // Revoca del consenso: i rilasci raccolti non partiranno più.
    clearLandings() { segment = newSegment(); },
    get sends() { return sends; },
    get anchored() { return !!anchor; },
  };
}

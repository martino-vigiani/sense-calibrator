'use strict';

// Rumore degli stick a riposo, riassunto per finestra (telemetria v2, evento
// `rest`). Puro: niente DOM, niente timer, niente HID. La pagina chiama `push`
// a ogni input report (~250 Hz) solo quando la raccolta è ammessa (pagina
// visibile, nessuna calibrazione, nessun modale, consenso non negato) e
// `reset` appena smette di esserlo; il collettore non sa nulla di queste
// condizioni.
//
// Unità: LSB, cioè passi del byte di un asse (1 LSB = 0,784%). Il rumore a
// riposo di un DualSense è di 0–3 LSB: in percentuale sarebbe una frazione
// scomoda, in LSB è il numero che si vede nel byte.
//
// Una finestra dura `windowMs` di report continui. Si scarta se uno stick si
// allontana dalla mediana più di `touchLsb` (8%, DRIFT_MOVE_SPREAD: la soglia
// oltre cui la pagina chiama "movimento" lo spread): quella è una mano, non
// rumore. Un buco nei report oltre `gapResetMs` (cavo, tab congelata) la
// riavvia senza contarla fra le scartate. Nessun campione esce dal
// collettore: solo il riassunto.

import { DRIFT_MOVE_SPREAD } from './measure.js';

const STICK_SCALE = 127.5; // unità normalizzate di parseSticks → LSB

export const REST_DEFAULTS = Object.freeze({
  windowMs: 30_000,
  maxPerLoad: 8,
  maxSamples: 20_000, // ~80 s a 250 Hz: una finestra non lo raggiunge mai
  touchLsb: DRIFT_MOVE_SPREAD * STICK_SCALE, // ≈10,2 LSB
  gapResetMs: 1000,
  gapMs: 100,
  excursionLsb: [1, 2, 4],
});

const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
// Rango più vicino su un array già ordinato.
const rank = (sorted, p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))];
function medianOf(values) {
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarizeStick(xs, ys, n, excursionLsb) {
  const x = xs.subarray(0, n);
  const y = ys.subarray(0, n);
  const mx = medianOf(x);
  const my = medianOf(y);
  const dist = new Float64Array(n);
  let sumX = 0; let sumY = 0;
  for (let i = 0; i < n; i++) { sumX += x[i]; sumY += y[i]; }
  const meanX = sumX / n; const meanY = sumY / n;
  let varX = 0; let varY = 0;
  const ex = excursionLsb.map(() => 0);
  const above = excursionLsb.map(() => false);
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(x[i] - mx, y[i] - my);
    dist[i] = d;
    varX += (x[i] - meanX) ** 2;
    varY += (y[i] - meanY) ** 2;
    // Un'escursione è una corsa di report consecutivi a ≥k LSB dalla mediana:
    // si conta una volta, all'ingresso.
    for (let k = 0; k < excursionLsb.length; k++) {
      const out = d >= excursionLsb[k] - 1e-9;
      if (out && !above[k]) ex[k] += 1;
      above[k] = out;
    }
  }
  dist.sort();
  return {
    off: round(Math.min(200, (Math.hypot(mx, my) / STICK_SCALE) * 100), 2),
    p50: round(rank(dist, 0.5), 2),
    p95: round(rank(dist, 0.95), 2),
    max: round(dist[n - 1], 2),
    sx: round(Math.sqrt(varX / n), 2),
    sy: round(Math.sqrt(varY / n), 2),
    ex,
  };
}

export function createRestNoiseCollector(options = {}) {
  const p = { ...REST_DEFAULTS, ...options };
  const buf = {
    lx: new Float32Array(p.maxSamples), ly: new Float32Array(p.maxSamples),
    rx: new Float32Array(p.maxSamples), ry: new Float32Array(p.maxSamples),
    t: new Float64Array(p.maxSamples),
  };
  let n = 0;
  let drift = false;
  let emitted = 0;
  let discarded = 0;
  // Primo campione della finestra: un salto oltre il doppio della soglia di
  // tocco scarta subito, senza aspettare 30 s per scoprirlo dalla mediana.
  let first = null;

  const restart = () => { n = 0; drift = false; first = null; };
  const discard = () => { discarded += 1; restart(); };

  function summarize() {
    const intervals = new Float64Array(n - 1);
    let gaps = 0;
    for (let i = 1; i < n; i++) {
      const dt = buf.t[i] - buf.t[i - 1];
      intervals[i - 1] = dt;
      if (dt > p.gapMs) gaps += 1;
    }
    intervals.sort();
    const left = summarizeStick(buf.lx, buf.ly, n, p.excursionLsb);
    const right = summarizeStick(buf.rx, buf.ry, n, p.excursionLsb);
    return {
      durMs: buf.t[n - 1] - buf.t[0],
      reports: n,
      intervalMs: [round(rank(intervals, 0.5), 1), round(rank(intervals, 0.95), 1), round(intervals[intervals.length - 1], 1)],
      gaps,
      drift,
      sticks: [left, right],
    };
  }

  return {
    get done() { return emitted >= p.maxPerLoad; },
    get emitted() { return emitted; },
    get discarded() { return discarded; },
    get samples() { return n; },
    // Interrompe la finestra in corso: non è rumore scartato, la raccolta non
    // era ammessa (tab nascosta, calibrazione, modale, controller scollegato).
    reset: restart,
    // Un report. Ritorna il riassunto quando una finestra valida si chiude,
    // altrimenti null. `discarded` nel riassunto conta le finestre scartate
    // per movimento dall'ultimo riassunto.
    push(sticks, now, { drift: driftRunning = false } = {}) {
      if (emitted >= p.maxPerLoad || !sticks) return null;
      if (n > 0 && now - buf.t[n - 1] > p.gapResetMs) restart();
      if (n > 0 && now < buf.t[n - 1]) restart();
      const v = [sticks.lx * STICK_SCALE, sticks.ly * STICK_SCALE, sticks.rx * STICK_SCALE, sticks.ry * STICK_SCALE];
      if (!v.every(Number.isFinite)) return null;
      if (first && v.some((value, i) => Math.abs(value - first[i]) > 2 * p.touchLsb)) { discard(); return null; }
      if (!first) first = v;
      buf.lx[n] = v[0]; buf.ly[n] = v[1]; buf.rx[n] = v[2]; buf.ry[n] = v[3]; buf.t[n] = now;
      n += 1;
      drift = drift || driftRunning;
      if (now - buf.t[0] < p.windowMs && n < p.maxSamples) return null;
      if (n < 2) { restart(); return null; }
      const summary = summarize();
      if (summary.sticks.some(s => s.max > p.touchLsb)) { discard(); return null; }
      summary.discarded = discarded;
      discarded = 0;
      emitted += 1;
      restart();
      return summary;
    },
  };
}

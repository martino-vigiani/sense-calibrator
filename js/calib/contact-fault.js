'use strict';

// Contatto instabile di un potenziometro: un asse che, con lo stick fermo e
// centrato, salta avanti e indietro fra due livelli di qualche LSB, mentre
// l'altro asse dello stesso stick resta immobile. Puro: niente DOM, niente
// timer, niente HID. La pagina chiama `push` a ogni input report (~250 Hz)
// quando l'osservazione è ammessa e `reset` quando smette di esserlo.
//
// Da dove viene: un DualSense di quattro anni (BDM-030, 16/10/2026) con
// microscatti sull'asse X sinistro. Otto minuti di report grezzi a riposo:
// gli altri tre assi zero cambi su oltre 120.000 report; l'X sinistro di
// norma fra 126 e 127, ma a tratti (da 0,3 s a oltre un minuto, in media una
// raffica ogni 27 s) salta di colpo 127 ↔ 130/131, migliaia di volte, senza
// mai passare da 129. Un drift vero scorre; qui si salta fra due livelli: è
// lo schema di una spazzola del potenziometro sporca o consumata. La
// calibrazione sposta il centro e non può fermare i salti.
//
// Una finestra dura `windowMs` di report continui (un buco oltre `gapMs` la
// riavvia). Un asse è positivo in una finestra se:
//   - lo stick è entro `centerRadiusLsb` dal centro (non è tenuto da parte);
//   - l'escursione dell'asse è al più `maxSpanLsb` (oltre è movimento);
//   - l'altro asse dello stesso stick si muove al più di `otherAxisMaxLsb`
//     (un pollice sposta anche lui);
//   - ci sono almeno `minJumps` salti fra report consecutivi di almeno
//     `jumpLsb`, e almeno `minEachWay` in ciascuna direzione (va e torna).
// Il normale rumore a riposo (0–2 LSB fra report) non fa mai un salto da 3.
// Un asse è confermato dopo `confirmWindows` finestre positive: è descrizione
// di una misura, non un verdetto validato su una popolazione di controller.

const STICK_SCALE = 127.5; // unità normalizzate di parseSticks → LSB
// Stesso raggio di QUICK_CENTER_RADIUS (js/quick-center-guard.js, 0.15): oltre
// lo stick è tenuto da parte o fermo lontano, e lì non si giudica il contatto.
const CENTER_RADIUS = 0.15;
const toByte = v => Math.round(v * STICK_SCALE + STICK_SCALE);

export const CONTACT_DEFAULTS = Object.freeze({
  windowMs: 1000,
  minReports: 100,
  gapMs: 100,
  jumpLsb: 3,
  minJumps: 6,
  minEachWay: 3,
  otherAxisMaxLsb: 2,
  centerRadiusLsb: CENTER_RADIUS * STICK_SCALE, // 15% ≈ 19 LSB
  maxSpanLsb: 16,
  confirmWindows: 2,
  maxSamples: 2000, // 8 s a 250 Hz: una finestra da 1 s non lo raggiunge
});

const AXES = [
  { stick: 'left', axis: 'x', key: 'lx', other: 'ly' },
  { stick: 'left', axis: 'y', key: 'ly', other: 'lx' },
  { stick: 'right', axis: 'x', key: 'rx', other: 'ry' },
  { stick: 'right', axis: 'y', key: 'ry', other: 'rx' },
];

function medianOf(values, n) {
  const s = Array.from(values.subarray(0, n)).sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function spanOf(values, n) {
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return hi - lo;
}

// Esame di un asse su una finestra chiusa: null se negativo.
function judgeAxis(buf, spec, n, p) {
  const v = buf[spec.key];
  const o = buf[spec.other];
  const mv = medianOf(v, n);
  const mo = medianOf(o, n);
  if (Math.hypot(mv - STICK_SCALE, mo - STICK_SCALE) > p.centerRadiusLsb) return null;
  const span = spanOf(v, n);
  if (span < p.jumpLsb || span > p.maxSpanLsb) return null;
  if (spanOf(o, n) > p.otherAxisMaxLsb) return null;
  let up = 0; let down = 0;
  const sizes = [];
  for (let i = 1; i < n; i++) {
    const d = v[i] - v[i - 1];
    if (d >= p.jumpLsb) { up++; sizes.push(d); } else if (d <= -p.jumpLsb) { down++; sizes.push(-d); }
  }
  if (up + down < p.minJumps || up < p.minEachWay || down < p.minEachWay) return null;
  sizes.sort((a, b) => a - b);
  // Distanza massima dal centro: la deadzone deve coprire questa, non solo
  // l'escursione fra i due livelli (uno stick che riposa al 12% e salta di 4
  // LSB ha bisogno di ~13%, non di 5%).
  let maxAbs = 0;
  for (let i = 0; i < n; i++) maxAbs = Math.max(maxAbs, Math.abs(v[i] - STICK_SCALE));
  return { jumps: up + down, jumpLsb: sizes[sizes.length >> 1], spanLsb: span, maxAbsLsb: maxAbs };
}

export function createContactFaultDetector(options = {}) {
  const p = { ...CONTACT_DEFAULTS, ...options };
  const buf = Object.fromEntries(AXES.map(a => [a.key, new Int16Array(p.maxSamples)]));
  let n = 0;
  let start = null;
  let last = null;
  // Prove accumulate per asse, finché la pagina non chiama `clear`.
  const evidence = new Map();

  function resetWindow() { n = 0; start = null; last = null; }

  function finding(spec, e) {
    return {
      stick: spec.stick,
      axis: spec.axis,
      windows: e.windows,
      jumps: e.jumps,
      jumpLsb: e.jumpLsb,
      spanLsb: e.spanLsb,
      spanPct: Math.round((e.spanLsb / STICK_SCALE) * 1000) / 10,
      maxPct: Math.round((e.maxAbsLsb / STICK_SCALE) * 1000) / 10,
      firstT: e.firstT,
      lastT: e.lastT,
    };
  }

  function closeWindow(t) {
    const changed = [];
    if (n >= p.minReports) {
      for (const spec of AXES) {
        const hit = judgeAxis(buf, spec, n, p);
        if (!hit) continue;
        const prev = evidence.get(spec.key) ?? { windows: 0, jumps: 0, jumpLsb: 0, spanLsb: 0, maxAbsLsb: 0, firstT: start, lastT: t };
        const next = {
          windows: prev.windows + 1,
          jumps: prev.jumps + hit.jumps,
          jumpLsb: Math.max(prev.jumpLsb, hit.jumpLsb),
          spanLsb: Math.max(prev.spanLsb, hit.spanLsb),
          maxAbsLsb: Math.max(prev.maxAbsLsb, hit.maxAbsLsb),
          firstT: prev.firstT,
          lastT: t,
        };
        evidence.set(spec.key, next);
        const confirmedNow = next.windows === p.confirmWindows;
        const grew = next.windows > p.confirmWindows
          && (next.spanLsb > prev.spanLsb || next.jumpLsb > prev.jumpLsb || next.maxAbsLsb > prev.maxAbsLsb);
        if (confirmedNow || grew) changed.push(finding(spec, next));
      }
    }
    resetWindow();
    return changed;
  }

  return {
    params: p,
    // Restituisce gli assi appena confermati o la cui ampiezza è cresciuta.
    push(sticks, t) {
      if (last !== null && (t < last || t - last > p.gapMs)) resetWindow();
      if (start === null) start = t;
      if (n < p.maxSamples) {
        for (const spec of AXES) buf[spec.key][n] = toByte(sticks[spec.key]);
        n++;
      }
      last = t;
      return t - start >= p.windowMs ? closeWindow(t) : [];
    },
    // Solo la finestra in corso: le prove restano (il difetto è intermittente).
    reset: resetWindow,
    // Nuovo controller: si dimentica tutto.
    clear() { resetWindow(); evidence.clear(); },
    findings() {
      return AXES.filter(s => (evidence.get(s.key)?.windows ?? 0) >= p.confirmWindows)
        .map(s => finding(s, evidence.get(s.key)));
    },
  };
}

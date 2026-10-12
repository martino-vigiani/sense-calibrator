'use strict';

// Dove si ferma lo stick a ogni rilascio. Puro come il resto di js/calib:
// niente DOM, niente timer, niente HID. Chi lo usa chiama `push` a ogni input
// report (~250 Hz) con gli stick di parseSticks e il tempo del report, e
// `reset` quando i report smettono di essere continui per un motivo noto
// (controller scollegato, registrazione ferma).
//
// Serve a separare due cause dello stesso sintomo ("poco dopo la calibrazione
// lo stick è di nuovo fuori centro"):
//   - calibrazione persa (spegnimento senza Write, un Range che sposta il
//     centro): gli arrivi restano raccolti, ma intorno a un punto lontano da 0;
//   - stick usurato: ogni rilascio si ferma in un punto diverso, quindi la
//     dispersione degli arrivi è grande anche se la loro mediana è vicina a 0.
// Il modulo misura e basta: non decide quale delle due sia, perché le soglie
// per farlo non sono ancora state validate su controller veri.
//
// Un rilascio è: lo stick si allontana dal suo ultimo punto fermo più di
// DRIFT_MOVE_SPREAD (8%, la soglia oltre cui la pagina chiama "movimento" lo
// spread), raggiunge un picco di almeno `minPeak` dal centro, poi torna fermo:
// una finestra di QUICK_STABLE_MS (300 ms, almeno 10 report, nessun buco oltre
// MAX_REPORT_GAP_MS) con escursione per asse entro QUICK_STABLE_SPREAD, la
// stessa regola di waitForStable. Il punto d'arrivo è la media della finestra,
// nel frame degli input report (cioè quello calibrato dal firmware).
//
// Un pollice fermo oltre `maxLand` (15%, il raggio del guard di Quick) è una
// tenuta, non un arrivo: diventa il nuovo punto fermo e il picco continua.
// Un pollice appoggiato fermo DENTRO il 15% non è distinguibile da uno stick
// che si ferma lì: `settleMs` lungo è l'unico indizio, e si riporta senza
// filtrare.

import { DRIFT_MOVE_SPREAD } from './measure.js';
import { MAX_REPORT_GAP_MS, QUICK_STABLE_MS, QUICK_STABLE_SPREAD } from './sampling.js';
import { QUICK_CENTER_RADIUS } from '../quick-center-guard.js';

const STICK_SCALE = 127.5; // unità normalizzate di parseSticks → LSB
const LSB_PCT = 100 / STICK_SCALE;

export const LANDING_DEFAULTS = Object.freeze({
  moveSpread: DRIFT_MOVE_SPREAD,     // uscita dal punto fermo (unità normalizzate)
  stableSpread: QUICK_STABLE_SPREAD, // escursione massima per asse nella finestra ferma
  holdMs: QUICK_STABLE_MS,
  minReports: 10,
  gapMs: MAX_REPORT_GAP_MS,          // un buco più lungo fa ripartire la finestra
  gapResetMs: 1000,                  // un buco più lungo dimentica il rilascio in corso
  minPeak: 0.25,                     // picco minimo dal centro: sotto è un tocco, non un rilascio
  maxLand: QUICK_CENTER_RADIUS,      // oltre è una tenuta, non un arrivo
  maxHistory: 1500,                  // ~6 s di report del movimento in corso, per settleMs
});

export const STICKS = Object.freeze(['left', 'right']);
const AXES = [['lx', 'ly'], ['rx', 'ry']];

const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};

function createStickTracker(stick, p) {
  // phase: 'unknown' (nessun punto fermo ancora), 'rest', 'held', 'moving'.
  let phase = 'unknown';
  let ref = null;
  let peak = 0;
  let moveStart = null;
  let lastT = null;
  let win = [];
  let history = [];
  // Primo report della corsa continua (senza buchi oltre gapMs), come
  // `continuousStart` in waitForStable.
  let runStart = null;

  const forget = () => {
    phase = 'unknown'; ref = null; peak = 0; moveStart = null;
    win = []; history = []; runStart = null; lastT = null;
  };

  // Media della finestra se è ferma e lunga abbastanza, altrimenti null.
  // Stessa regola di waitForStable: almeno minReports report negli ultimi
  // holdMs, holdMs di report continui, escursione per asse entro stableSpread.
  function stableCenter(t) {
    if (win.length < p.minReports || t - runStart < p.holdMs) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, sx = 0, sy = 0;
    for (const s of win) {
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.y < minY) minY = s.y;
      if (s.y > maxY) maxY = s.y;
      sx += s.x; sy += s.y;
    }
    if (maxX - minX > p.stableSpread || maxY - minY > p.stableSpread) return null;
    return { x: sx / win.length, y: sy / win.length };
  }

  function push(x, y, t) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) return null;
    if (lastT !== null && (t < lastT || t - lastT > p.gapResetMs)) forget();
    if (lastT !== null && t - lastT > p.gapMs) { win = []; runStart = null; }
    lastT = t;

    const r = Math.hypot(x, y);
    if (phase !== 'moving' && ref && Math.hypot(x - ref.x, y - ref.y) > p.moveSpread) {
      phase = 'moving';
      moveStart = t;
      history = [];
    }
    if (phase === 'moving') {
      if (r > peak) peak = r;
      history.push({ x, y, t });
      if (history.length > p.maxHistory) history.shift();
    }

    if (runStart === null) runStart = t;
    win.push({ x, y, t });
    while (win.length && win[0].t < t - p.holdMs) win.shift();
    // Fermo o tenuto: la finestra serve solo a chi aspetta un arrivo.
    if (phase === 'rest' || phase === 'held') return null;
    const center = stableCenter(t);
    if (!center) return null;

    if (phase === 'unknown') {
      ref = center;
      const rc = Math.hypot(center.x, center.y);
      phase = rc <= p.maxLand ? 'rest' : 'held';
      peak = phase === 'held' ? rc : 0;
      return null;
    }

    const rc = Math.hypot(center.x, center.y);
    ref = center;
    if (rc > p.maxLand) {
      // Tenuta: il picco resta, il rilascio vero arriverà dopo.
      phase = 'held';
      if (rc > peak) peak = rc;
      history = [];
      return null;
    }
    phase = 'rest';
    // La finestra copre gli ultimi holdMs: il suo primo report è il momento
    // in cui lo stick si è fermato.
    const landedAt = win[0].t;
    const wasPeak = peak;
    peak = 0;
    if (wasPeak < p.minPeak) { history = []; return null; }
    // Tempo di assestamento: dall'ultimo report ancora lontano dall'arrivo
    // (oltre moveSpread) all'inizio della finestra ferma.
    let leftAt = moveStart;
    for (let i = history.length - 1; i >= 0; i--) {
      const s = history[i];
      if (s.t >= landedAt) continue;
      if (Math.hypot(s.x - center.x, s.y - center.y) > p.moveSpread) { leftAt = s.t; break; }
    }
    history = [];
    return {
      t: landedAt,
      stick,
      peak: round(Math.min(200, wasPeak * 100), 1),
      landAxes: [round(center.x * STICK_SCALE, 1), round(center.y * STICK_SCALE, 1)],
      landPct: round(rc * 100, 2),
      settleMs: Math.max(0, Math.round(landedAt - leftAt)),
    };
  }

  return {
    push,
    reset: forget,
    get phase() { return phase; },
    get ref() { return ref; },
  };
}

// Rilevatore per i due stick. `push(sticks, t)` ritorna la lista (spesso
// vuota) dei rilasci chiusi da questo report:
//   { t, stick: 'left'|'right', peak (% dal centro), landAxes: [x, y] (LSB con
//     segno, frame calibrato, 0,1), landPct (% dal centro), settleMs }
// `t` è il primo report della finestra ferma, nello stesso orologio di chi chiama.
export function createLandingDetector(options = {}) {
  const p = { ...LANDING_DEFAULTS, ...options };
  const trackers = STICKS.map(stick => createStickTracker(stick, p));
  return {
    params: p,
    push(sticks, t) {
      if (!sticks) return [];
      const out = [];
      for (let i = 0; i < 2; i++) {
        const [ax, ay] = AXES[i];
        const landing = trackers[i].push(sticks[ax], sticks[ay], t);
        if (landing) out.push(landing);
      }
      return out;
    },
    reset() { for (const tr of trackers) tr.reset(); },
    phase(stick) { return trackers[STICKS.indexOf(stick)]?.phase ?? null; },
  };
}

// Rango più vicino su un array già ordinato.
const rank = (sorted, q) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))];
function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const EMPTY_SUMMARY = Object.freeze({
  count: 0, median: null, medianPct: null,
  spreadLsb: null, spreadPct: null, driftLsb: null, driftPct: null, settleMs: null,
});

// Riassunto per stick di una lista di rilasci (quelli di createLandingDetector):
//   count       numero di rilasci
//   median      [x, y] mediana per asse dei punti d'arrivo, LSB con segno
//   medianPct   distanza di quella mediana dal centro, %
//   spreadLsb   [p50, p95] della distanza di ogni arrivo dalla mediana, LSB
//   spreadPct   gli stessi in %
//   driftLsb    distanza media degli arrivi dal centro, LSB
//   driftPct    la stessa in %
//   settleMs    mediana di settleMs
// Uno stick senza rilasci ha count 0 e tutti gli altri campi null.
export function summarizeLandings(list) {
  const out = {};
  for (const stick of STICKS) {
    const mine = (list ?? []).filter(l => l && l.stick === stick && Array.isArray(l.landAxes));
    if (!mine.length) { out[stick] = { ...EMPTY_SUMMARY }; continue; }
    const mx = medianOf(mine.map(l => l.landAxes[0]));
    const my = medianOf(mine.map(l => l.landAxes[1]));
    const dist = mine.map(l => Math.hypot(l.landAxes[0] - mx, l.landAxes[1] - my)).sort((a, b) => a - b);
    const drift = mine.reduce((sum, l) => sum + Math.hypot(l.landAxes[0], l.landAxes[1]), 0) / mine.length;
    const p50 = rank(dist, 0.5);
    const p95 = rank(dist, 0.95);
    out[stick] = {
      count: mine.length,
      median: [round(mx, 1), round(my, 1)],
      medianPct: round(Math.hypot(mx, my) * LSB_PCT, 2),
      spreadLsb: [round(p50, 2), round(p95, 2)],
      spreadPct: [round(p50 * LSB_PCT, 2), round(p95 * LSB_PCT, 2)],
      driftLsb: round(drift, 2),
      driftPct: round(drift * LSB_PCT, 2),
      settleMs: Math.round(medianOf(mine.map(l => l.settleMs))),
    };
  }
  return out;
}

'use strict';

/* ============================================================
   Test di precisione v4 — tre prove diagnostiche di calibrazione.
   Legge solo la posizione degli stick via deps, non tocca l'HID e non
   conosce lo stato di app.js.

   Ogni prova misura una proprietà del controller, non l'abilità
   dell'utente:
     Center -> offset a riposo (ciò che la calibrazione corregge) e rumore
               (Stability: ciò che la calibrazione non corregge)
     Return -> dove si ferma lo stick lasciato dopo un flick prescritto
     Range  -> copertura e circolarità del fondo corsa
   Solo Center e Stability entrano nei due numeri del titolo. Return e Range
   sono informativi finché dati locali non tarano le loro ancore (piano WS8):
   oggi nessuno sa quanto torna al centro un DualSense sano.

   Campionamento: tutto si accumula per input report HID (deps.subscribe),
   mai per frame. rAF disegna e basta, più il controllo "nessun report da
   100 ms" (un buco nei report non genera report che lo segnalino). A 60 Hz
   rAF vedeva un quarto dei ~250 report/s, duplicava campioni e in una tab
   in background si fermava con la fase che finiva quasi senza dati.

   Struttura: createPrecisionTest() è la macchina a stati pura (niente DOM,
   niente timer, il tempo lo passa il chiamante), così test e simulatore
   (ops/sim/precision-user.mjs) la guidano con report sceneggiati.
   initGame() è il guscio DOM.

   initGame(deps)
     deps.getSticks   -> () => ({ lx, ly, rx, ry })   (-1..1, y giù)
     deps.subscribe   -> (fn(sticks, t)) => unsubscribe, un callback per report
     deps.getSerial   -> () => string|null  (solo per la chiave locale salata)
     deps.isAvailable -> () => bool                   (gate apertura)
     deps.onReport    -> (res) => void  opzionale: evento locale a fine test
   ============================================================ */

import { analyzeDrift, DRIFT_MOVE_SPREAD, DRIFT_WINDOW } from './calib/measure.js';
import { CIRCULARITY_NORMAL, RANGE_DEFAULTS, createRangeTracker } from './calib/range-coverage.js';
import { GUIDED_ONLY_MIN, LSB_PCT, centerScoreFor, formatOffset, tierForOffset } from './calib/lattice.js';
import { STICK_LSB } from './calib/sampling.js';
import { QUICK_NOISE_WORN } from './calib/quick.js';
import { HANDS_OFF_LABELS, createHandsOffMeter, renderHandsOff } from './ui/hands-off.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------- parametri (fissi: punteggi stabili) ---------------- */

export const PRECISION_DEFAULTS = Object.freeze({
  // Buco massimo tra due report durante una prova: oltre, la misura non è più
  // quella di una finestra continua (stessa regola del guard della rapida).
  gapMs: 100,
  // Senza report da così tanto, in attesa, si dice che il controller tace.
  silentMs: 500,

  // "Pronto appena rilasci": la prova parte da sola quando il misuratore
  // mani-lontane resta verde per readyGreenMs. Uno stick rumoroso non diventa
  // mai verde: dopo readyAmberMs fermo (verde o ambra) si parte lo stesso,
  // perché l'ambra sta ancora sotto DRIFT_MOVE_SPREAD, la soglia con cui
  // Center scarta le finestre toccate.
  readyGreenMs: 400,
  readyAmberMs: 1500,
  // Mai fermi per così tanto: con le mani lontane è il sensore stesso che
  // balla (usura, sporco). Si smette di aspettare e lo si dice, invece di
  // restare in attesa per sempre.
  readyTimeoutMs: 12000,

  // Center: finestre di DRIFT_WINDOW (30) report, scartate se l'escursione di
  // uno stick supera DRIFT_MOVE_SPREAD. Ne deve sopravvivere il 60%, altrimenti
  // la corsa è "toccata" e riparte (al massimo 2 volte da sola): un punteggio
  // non viene mai da una corsa toccata.
  centerMs: 3000,
  centerWindow: DRIFT_WINDOW,
  centerMinSurvival: 0.6,
  centerMaxRetries: 2,
  // Sotto queste finestre (≈1.2 s di report a 250 Hz) la misura è troppo corta.
  centerMinWindows: 10,
  // Per quanto resta il messaggio dopo una finestra scartata.
  touchNoteMs: 1200,

  // Return: 4 flick prescritti, un giro solo.
  returnDirs: Object.freeze(['up', 'right', 'down', 'left']),
  armRadius: 0.75,
  releaseRadius: 0.25,
  // Dal bordo al centro in ≤80 ms: la molla lo fa in poche decine di ms, una
  // mano che accompagna no. È una stima da tarare sui dati locali.
  releaseMaxMs: 80,
  // Un flick conta solo entro ±45° dalla direzione chiesta.
  aimToleranceRad: Math.PI / 4,
  // Assestamento: 20 report consecutivi entro 2 LSB per asse. La molla si
  // ferma in poche decine di ms, quindi dopo 1 s ciò che resta è rumore del
  // sensore: basta restare sotto DRIFT_MOVE_SPREAD, la soglia del movimento.
  // Dopo 3 s il flick non conta e si ripete.
  settleReports: 20,
  settleSpread: 2 * STICK_LSB,
  settleFallbackMs: 1000,
  settleTimeoutMs: 3000,
  restReports: 50,
  // Un punto di riposo oltre il raggio del guard (15%) non è una molla: è un
  // pollice rimasto sullo stick.
  restMaxPct: GUIDED_ONLY_MIN,
  returnCapMs: 30000,
  noteMs: 2500,

  // Range: gli stessi 36 settori della calibrazione range; un settore conta
  // da 0.7 di raggio, basta il 90% dei settori, al massimo 25 s.
  rangeReach: 0.7,
  rangeCoverage: 0.9,
  rangeCapMs: 25000,
  // Senza settori nuovi da così tanto si dice che cosa manca.
  rangeStallMs: 1000,
});

// Fasi nell'ordine in cui girano: l'intro in index.html le elenca con gli
// stessi nomi (test/public-surface.test.js lo verifica).
export const GAME_PHASES = Object.freeze(['Center', 'Return', 'Range']);

// v4: prove e punteggi nuovi, i v3 non sono confrontabili.
export const STORAGE_KEY = 'senseGameLastScore.v4';
export const SALT_KEY = 'senseGameSalt.v1';
const LEGACY_KEYS = ['senseGameLastScore.v3'];
// Controller ricordati al massimo (i più vecchi escono).
const MAX_REMEMBERED = 8;

// Stability dal rumore p95 (%): 1 LSB costa 5 punti, QUICK_NOISE_WORN (1.5%,
// la soglia "sensore consumato" della rapida) vale 75, 4% vale 0.
export const STABILITY_SCORE_ANCHORS = Object.freeze([
  Object.freeze([0, 100]),
  Object.freeze([LSB_PCT, 95]),
  Object.freeze([QUICK_NOISE_WORN, 75]),
  Object.freeze([4, 0]),
]);

const DIR_VEC = Object.freeze({ up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] });
const STICKS = Object.freeze([
  Object.freeze({ key: 'L', name: 'left', x: 'lx', y: 'ly' }),
  Object.freeze({ key: 'R', name: 'right', x: 'rx', y: 'ry' }),
]);

/* ---------------- punteggi e statistiche (puri) ---------------- */

// Interpolazione lineare a tratti su ancore [x, y] crescenti in x.
export function lerpAnchors(anchors, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (v <= x1) {
      const [x0, y0] = anchors[i - 1];
      return Math.round(y0 + (y1 - y0) * (v - x0) / (x1 - x0));
    }
  }
  return anchors[anchors.length - 1][1];
}

// Center passa da GRID_TABLE (lattice.js), unica fonte di verità: 0.555→100,
// 1.24→90, poi lineare fino a 3.5→60 e 8→0.
export const centerScore = centerScoreFor;
export const stabilityScoreFor = noise => lerpAnchors(STABILITY_SCORE_ANCHORS, noise);

function spreadOf(samples, kx, ky) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const s of samples) {
    const x = s[kx], y = s[ky];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.max(maxX - minX, maxY - minY);
}

function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Una finestra è ferma se nessuno dei due stick si muove oltre
// DRIFT_MOVE_SPREAD: la stessa soglia con cui il test drift separa un drift
// (anche grande, ma fermo) da una mano sullo stick.
export function windowIsStill(win) {
  return spreadOf(win, 'lx', 'ly') <= DRIFT_MOVE_SPREAD && spreadOf(win, 'rx', 'ry') <= DRIFT_MOVE_SPREAD;
}

// Una spinta lenta del pollice (0.3 in un secondo) resta sotto
// DRIFT_MOVE_SPREAD in ogni finestra da 120 ms: lo spread da solo non la
// vede. Per questo si confrontano anche le mediane delle finestre ferme con
// la loro mediana comune: un riposo vero è lo stesso punto per tutti i 3 s,
// entro 4 LSB (la tolleranza della rapida). Resta invisibile solo un pollice
// fermo per tutta la corsa, come in ogni altra misura della pagina.
export const CENTER_CREEP_TOL = 4 * STICK_LSB;

function windowMedian(win) {
  return ['lx', 'ly', 'rx', 'ry'].map(a => medianOf(win.map(s => s[a])));
}

// Center da finestre chiuse: { total, kept, survival, touched, tooShort,
// drift } dove drift è analyzeDrift (mediana per asse, rumore p95) dei soli
// campioni delle finestre ferme, cioè le statistiche del test drift. drift è
// null se la corsa è corta o toccata: un punteggio non esce mai da lì.
export function analyzeCenter(windows, {
  minSurvival = PRECISION_DEFAULTS.centerMinSurvival,
  minWindows = PRECISION_DEFAULTS.centerMinWindows,
} = {}) {
  const still = windows.filter(windowIsStill);
  const meds = still.map(windowMedian);
  const ref = [0, 1, 2, 3].map(i => medianOf(meds.map(m => m[i])));
  const keptWins = still.filter((w, k) => meds[k].every((v, i) => Math.abs(v - ref[i]) <= CENTER_CREEP_TOL));
  const total = windows.length;
  const kept = keptWins.length;
  const creeping = still.length - kept;
  const survival = total ? kept / total : 0;
  const tooShort = total < minWindows;
  // Un riposo che si sposta di oltre 4 LSB in 3 s non è un riposo: basta una
  // finestra così e la corsa è toccata, anche se il 60% sopravvive.
  const touched = !tooShort && (survival < minSurvival || creeping > 0);
  return {
    total,
    kept,
    creeping,
    survival,
    touched,
    tooShort,
    drift: tooShort || touched ? null : analyzeDrift(keptWins.flat()),
  };
}

// Punteggi di uno stick misurato da Center (analyzeDrift: offset e noise in
// %, x/y normalizzati).
export function scoreStick(m) {
  if (!m) return null;
  return {
    offset: m.offset,
    noise: m.noise,
    x: m.x,
    y: m.y,
    center: centerScore(m.offset),
    stability: stabilityScoreFor(m.noise),
  };
}

// Metriche Return di uno stick dai punti di riposo misurati. `ref` è la
// posizione a riposo di Center (stesso frame, stessi report): H è la mediana
// delle distanze da lì, B lo sbilanciamento lungo la direzione del flick
// (positivo = si ferma dalla parte da cui arriva, la firma di una molla con
// gioco). null se nessun flick è stato misurato: "Not measured", mai 0.
export function returnMetrics(flicks, ref) {
  if (!flicks.length || !ref) return null;
  const hs = flicks.map(f => Math.hypot(f.x - ref.x, f.y - ref.y) * 100);
  const bias = flicks.reduce((a, f) => {
    const [ux, uy] = DIR_VEC[f.dir];
    return a + ((f.x - ref.x) * ux + (f.y - ref.y) * uy) * 100;
  }, 0) / flicks.length;
  return {
    n: flicks.length,
    dirs: flicks.map(f => f.dir),
    H: medianOf(hs),
    maxH: Math.max(...hs),
    B: bias,
    settleMs: medianOf(flicks.map(f => f.settleMs)),
  };
}

// Range di uno stick dai settori (raggio massimo con il riempimento a corda di
// range-coverage.js). Circolarità RMS come upstream (distanza da 1.0) ma sui
// soli settori raggiunti: una copertura parziale non diventa un errore enorme.
export function rangeMetrics(bins, reach = PRECISION_DEFAULTS.rangeReach) {
  const covered = bins.filter(v => v >= reach);
  const coverage = covered.length / bins.length;
  if (!covered.length) return { coverage, circ: null, under: 0, over: 0, meanR: null };
  const circ = Math.sqrt(covered.reduce((a, v) => a + (v - 1) ** 2, 0) / covered.length) * 100;
  return {
    coverage,
    circ,
    under: covered.filter(v => v < 0.95).length / covered.length,
    over: covered.filter(v => v > 1.05).length / covered.length,
    meanR: covered.reduce((a, v) => a + v, 0) / covered.length,
  };
}

// Regola di significatività di 1 LSB per il confronto prima/dopo. L'offset
// radiale non basta: dal pavimento al primo gradino cambia di 0.685 punti, due
// assi a 5 LSB che diventano 6+5 di 0.58, quindi una soglia sul raggio
// sbaglierebbe in un verso o nell'altro. Si guarda il byte: la mediana di
// almeno un asse deve essersi spostata di un LSB intero. Una mediana a mezzo
// byte (sfarfallio 127/128) che passa a 127 non è un cambiamento.
export function stepsMoved(prev, cur) {
  if (!prev || !cur) return null;
  return Math.max(Math.abs(cur.x - prev.x), Math.abs(cur.y - prev.y)) * 127.5;
}

export function compareStick(prev, cur) {
  if (!prev || !cur || typeof prev.x !== 'number' || typeof cur.x !== 'number') return null;
  const moved = stepsMoved(prev, cur);
  let center = 'same';
  if (moved >= 1 - 1e-6) {
    if (cur.offset < prev.offset - 1e-6) center = 'better';
    else if (cur.offset > prev.offset + 1e-6) center = 'worse';
    else center = 'moved';
  }
  let stability = 'same';
  const dn = cur.noise - prev.noise;
  if (Math.abs(dn) >= LSB_PCT - 1e-6) stability = dn < 0 ? 'better' : 'worse';
  return { center, stability, moved };
}

/* ---------------- testi (puri) ---------------- */

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// Parte "passi" di formatOffset ("at floor", "2 steps"), per i confronti.
function stepsText(off) {
  const f = formatOffset(off);
  const i = f.indexOf(' · ');
  return i >= 0 ? f.slice(i + 3) : f;
}

// Riga Return per uno stick.
export function returnText(ret, of = 4) {
  if (!ret) return 'Not measured';
  const steps = Math.round(ret.H / LSB_PCT);
  const where = steps <= 1 ? 'Springs back to rest (within 1 step)' : `Stops ${steps} steps from rest`;
  return `${where} · ${ret.n} of ${of} flicks`;
}

// Riga Range per uno stick.
export function rangeText(rng) {
  if (!rng || !Number.isFinite(rng.coverage) || rng.coverage <= 0) return 'Not measured';
  // La circolarità dei soli settori raggiunti non descrive la metà non vista.
  if (rng.coverage < PRECISION_DEFAULTS.rangeCoverage)
    return `Partial result: ${Math.round(rng.coverage * 100)}% of the edge measured`;
  if (rng.circ == null) return 'Not measured';
  const pct = `${Math.round(rng.circ)}%`;
  if (rng.circ <= CIRCULARITY_NORMAL.max) return `Reaches the edge all around (${pct}, typical ${CIRCULARITY_NORMAL.min}–${CIRCULARITY_NORMAL.max}%)`;
  if (rng.under > rng.over) return `Falls short of the edge in places (${pct})`;
  return `Hits its limit before the edge, square-ish (${pct})`;
}

// La frase del titolo: una sola, in linguaggio semplice. Prima la
// calibrazione (è ciò che si corregge qui), poi l'hardware.
export function headlineSentence(res) {
  const L = res.L.score, R = res.R.score;
  const calSide = L.center <= R.center ? 'left' : 'right';
  const calStick = calSide === 'left' ? L : R;
  const hwSide = L.stability <= R.stability ? 'left' : 'right';
  const hwStick = hwSide === 'left' ? L : R;
  const calIssue = res.calibration < 90;
  const hwIssue = res.hardware < 75;
  const guided = tierForOffset(calStick.offset)?.id === 'guided-only';
  const jitter = `±${hwStick.noise.toFixed(1)}%`;
  if (calIssue && hwIssue) {
    return `The ${calSide} stick rests ${formatOffset(calStick.offset)} off center (${guided ? 'Guided calibration' : 'calibration'} can fix that), and the ${hwSide} stick jitters by ${jitter}, which calibration can't fix.`;
  }
  if (calIssue) {
    return `The ${calSide} stick rests ${formatOffset(calStick.offset)} off center: ${guided ? 'too far for Quick calibration, so use Guided calibration' : 'a Quick calibration should fix that'}.`;
  }
  if (hwIssue) return `Both sticks rest centered, but the ${hwSide} stick jitters by ${jitter}: that's wear or dirt in the sensor, which calibration can't fix.`;
  if (res.calibration >= 100) return 'Both sticks rest dead center and hold steady: nothing to fix.';
  return 'Both sticks rest within one step of center and hold steady: nothing worth fixing.';
}

/* ---------------- macchina a stati (pura) ---------------- */

// createPrecisionTest(params) → { start, feed, tick, interrupt, retry, skip,
// view, reset, phase, result }. Il tempo arriva sempre dal chiamante: `feed`
// a ogni report (t = arrivo del report), `tick` dal disegno solo per
// accorgersi dei buchi. Nessuna prova avanza su `tick`.
export function createPrecisionTest(params = {}) {
  const P = { ...PRECISION_DEFAULTS, ...params };
  const meter = createHandsOffMeter();
  const ACTIVE = new Set(['center', 'return', 'range']);

  let phase = 'idle';
  let st = null;          // stato della fase corrente
  let lastT = null;       // arrivo dell'ultimo report
  let level = 'unknown';  // livello mani-lontane
  let run = null;         // dati raccolti nella sequenza
  let resultCache = null;

  function reset() {
    phase = 'idle';
    st = null;
    lastT = null;
    level = 'unknown';
    run = null;
    resultCache = null;
    meter.reset();
  }

  function start(t) {
    reset();
    run = {
      startedAt: t,
      finishedAt: null,
      centerRetries: 0,
      interruptions: 0,
      center: null,         // { L, R } da analyzeDrift
      centerRun: null,      // { total, kept, survival }
      returnStart: null,
      flicks: { L: [], R: [] },
      attempts: { guided: 0, wrong: 0, unsettled: 0, heldRest: 0 },
      returnSkipped: false,
      returnTimedOut: false,
      range: null,
      rangeSkipped: false,
      rangeTimedOut: false,
    };
    enterReady(t, null);
  }

  /* --- Pronto: parte da sola quando gli stick sono fermi --- */

  function enterReady(t, note) {
    phase = 'ready';
    meter.reset();
    level = 'unknown';
    st = { since: t, greenSince: null, stillSince: null, note };
  }

  function feedReady(t) {
    if (level === 'green') {
      if (st.greenSince == null) st.greenSince = t;
      if (st.stillSince == null) st.stillSince = t;
    } else if (level === 'amber') {
      st.greenSince = null;
      if (st.stillSince == null) st.stillSince = t;
    } else {
      st.greenSince = null;
      st.stillSince = null;
    }
    const green = st.greenSince != null && t - st.greenSince >= P.readyGreenMs;
    const still = st.stillSince != null && t - st.stillSince >= P.readyAmberMs;
    if (green || still) enterCenter(t);
    else if (t - st.since >= P.readyTimeoutMs) {
      phase = 'center-failed';
      st = { at: t, reason: 'never-still' };
    }
  }

  /* --- Center --- */

  function enterCenter(t) {
    phase = 'center';
    st = { start: t, win: [], windows: [], dropped: 0, lastDropAt: null };
  }

  function feedCenter(s, t) {
    st.win.push({ lx: s.lx, ly: s.ly, rx: s.rx, ry: s.ry });
    if (st.win.length >= P.centerWindow) {
      const w = st.win;
      st.win = [];
      st.windows.push(w);
      if (!windowIsStill(w)) { st.dropped += 1; st.lastDropAt = t; }
    }
    const elapsed = t - st.start;
    // Toccata senza rimedio: le finestre scartate superano già il 40% di
    // quelle attese nell'intera corsa. Si riparte subito invece di far
    // aspettare la fine di una misura che non verrà usata.
    if (st.dropped && elapsed > 300) {
      const expected = Math.max(st.windows.length, (st.windows.length * P.centerMs) / elapsed);
      if (st.dropped > (1 - P.centerMinSurvival) * expected) { centerTouched(t); return; }
    }
    if (elapsed >= P.centerMs) {
      const a = analyzeCenter(st.windows, { minSurvival: P.centerMinSurvival, minWindows: P.centerMinWindows });
      if (a.tooShort) { interrupt('few', t); return; }
      if (!a.drift) { centerTouched(t); return; }
      run.center = { L: a.drift.left, R: a.drift.right };
      run.centerRun = { total: a.total, kept: a.kept, survival: a.survival };
      enterReturn(t, 0);
    }
  }

  function centerTouched(t) {
    if (run.centerRetries < P.centerMaxRetries) {
      run.centerRetries += 1;
      enterReady(t, 'touched');
    } else {
      phase = 'center-failed';
      st = { at: t, reason: 'touched' };
    }
  }

  /* --- Return --- */

  function stickReturnState() {
    return { stage: 'aim', done: false, tArm: 0, tRel: 0, buf: [], rest: [], settleMs: 0, note: null, noteAt: 0, wrongDir: null };
  }

  function enterReturn(t, index) {
    phase = 'return';
    if (run.returnStart == null) run.returnStart = t;
    st = { index, L: stickReturnState(), R: stickReturnState() };
  }

  function dirOf(x, y) {
    // y giù: su è −90°
    const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
    if (deg >= 45 && deg < 135) return 'down';
    if (deg >= 135 && deg < 225) return 'left';
    if (deg >= 225 && deg < 315) return 'up';
    return 'right';
  }

  function aimed(x, y, dir) {
    const [ux, uy] = DIR_VEC[dir];
    const r = Math.hypot(x, y);
    return r > 0 && (x * ux + y * uy) / r >= Math.cos(P.aimToleranceRad);
  }

  function note(S, kind, t) { S.note = kind; S.noteAt = t; }

  function feedReturnStick(S, x, y, t, dir, key) {
    const r = Math.hypot(x, y);
    switch (S.stage) {
      case 'aim':
        if (r >= P.armRadius) {
          if (aimed(x, y, dir)) { S.stage = 'armed'; S.tArm = t; }
          else {
            run.attempts.wrong += 1;
            S.wrongDir = dirOf(x, y);
            note(S, 'wrong', t);
            S.stage = 'wrong';
          }
        }
        break;
      case 'wrong':
        // un flick nella direzione sbagliata non conta: si aspetta il ritorno
        if (r <= P.releaseRadius) S.stage = 'aim';
        break;
      case 'armed':
        if (r >= P.armRadius) { S.tArm = t; break; }
        if (r <= P.releaseRadius) {
          if (t - S.tArm <= P.releaseMaxMs) {
            S.stage = 'settling'; S.tRel = t; S.buf = [];
          } else {
            run.attempts.guided += 1;
            note(S, 'guided', t);
            S.stage = 'aim';
          }
        }
        break;
      case 'settling': {
        if (r >= P.armRadius) { S.stage = aimed(x, y, dir) ? 'armed' : 'wrong'; S.tArm = t; break; }
        S.buf.push({ t, x, y });
        if (S.buf.length > P.settleReports) S.buf.shift();
        const since = t - S.tRel;
        if (S.buf.length === P.settleReports && r <= P.releaseRadius) {
          const limit = since > P.settleFallbackMs ? DRIFT_MOVE_SPREAD : P.settleSpread;
          if (spreadOf(S.buf, 'x', 'y') <= limit) {
            S.stage = 'measuring';
            S.settleMs = S.buf[0].t - S.tRel;
            S.rest = [];
            break;
          }
        }
        if (since > P.settleTimeoutMs) {
          run.attempts.unsettled += 1;
          note(S, 'unsettled', t);
          S.stage = 'aim';
        }
        break;
      }
      case 'measuring': {
        if (r >= P.armRadius) { S.stage = aimed(x, y, dir) ? 'armed' : 'wrong'; S.tArm = t; break; }
        S.rest.push({ x, y });
        if (spreadOf(S.rest, 'x', 'y') > DRIFT_MOVE_SPREAD) {
          // si è mosso di nuovo: si torna ad aspettare che si fermi
          S.stage = 'settling'; S.buf = []; S.rest = [];
          break;
        }
        if (S.rest.length >= P.restReports) {
          const px = medianOf(S.rest.map(p => p.x));
          const py = medianOf(S.rest.map(p => p.y));
          const ref = run.center[key];
          if (Math.hypot(px - ref.x, py - ref.y) * 100 > P.restMaxPct) {
            run.attempts.heldRest += 1;
            note(S, 'held', t);
            S.stage = 'aim';
            break;
          }
          run.flicks[key].push({ dir, x: px, y: py, settleMs: S.settleMs });
          S.done = true;
          S.note = null;
          S.stage = 'done';
        }
        break;
      }
      default:
        break;
    }
  }

  function feedReturn(s, t) {
    const dir = P.returnDirs[st.index];
    for (const m of STICKS) {
      const S = st[m.key];
      if (!S.done) feedReturnStick(S, s[m.x], s[m.y], t, dir, m.key);
    }
    if (st.L.done && st.R.done) {
      if (st.index + 1 < P.returnDirs.length) enterReturn(t, st.index + 1);
      else enterRange(t);
      return;
    }
    if (t - run.returnStart >= P.returnCapMs) {
      run.returnTimedOut = true;
      enterRange(t);
    }
  }

  /* --- Range --- */

  function enterRange(t) {
    phase = 'range';
    st = {
      start: t,
      tracker: createRangeTracker({ bins: RANGE_DEFAULTS.bins }),
      covered: 0,
      lastGrowth: t,
    };
  }

  const coveredBins = bins => bins.filter(v => v >= P.rangeReach).length;

  function feedRange(s, t) {
    st.tracker.push(s);
    const cl = coveredBins(st.tracker.left.bins), cr = coveredBins(st.tracker.right.bins);
    if (cl + cr > st.covered) { st.covered = cl + cr; st.lastGrowth = t; }
    const need = P.rangeCoverage * st.tracker.left.bins.length;
    if (cl >= need && cr >= need) { finishRange(t); return; }
    if (t - st.start >= P.rangeCapMs) {
      run.rangeTimedOut = true;
      finishRange(t);
    }
  }

  function finishRange(t) {
    run.range = {
      L: rangeMetrics(st.tracker.left.bins, P.rangeReach),
      R: rangeMetrics(st.tracker.right.bins, P.rangeReach),
    };
    run.finishedAt = t;
    phase = 'done';
    st = null;
  }

  /* --- interruzioni, riprova, salto --- */

  function interrupt(reason, t) {
    if (!ACTIVE.has(phase) && !(phase === 'ready' && reason === 'hidden')) return false;
    run.interruptions += 1;
    const of = phase === 'ready' ? 'center' : phase;
    const index = phase === 'return' ? st.index : 0;
    phase = 'interrupted';
    st = { reason, of, index, at: t };
    return true;
  }

  function retry(t) {
    if (phase === 'interrupted') {
      const { of, index } = st;
      lastT = null;
      if (of === 'center') enterReady(t, null);
      else if (of === 'return') {
        // La direzione interrotta si rifà da capo per entrambe le leve: se una
        // l'aveva già chiusa, il suo flick va tolto, altrimenti la riprova lo
        // registra due volte (5 di 4 flick, mediana, bias e assestamento
        // falsati). Le direzioni sono in ordine: restano solo le prime `index`.
        for (const m of STICKS) run.flicks[m.key].length = Math.min(run.flicks[m.key].length, index);
        run.returnStart = null;
        enterReturn(t, index);
      }
      else enterRange(t);
      return true;
    }
    if (phase === 'center-failed') {
      run.centerRetries = 0;
      lastT = null;
      enterReady(t, null);
      return true;
    }
    return false;
  }

  // Return e Range sono informativi: si possono saltare, e allora il report
  // dice "Not measured", mai un punteggio basso.
  function skip(t) {
    if (phase === 'return') { run.returnSkipped = true; enterRange(t); return true; }
    if (phase === 'range') { run.rangeSkipped = true; finishRange(t); return true; }
    return false;
  }

  /* --- ingressi --- */

  function feed(s, t) {
    if (phase === 'idle' || phase === 'done') return;
    const gap = lastT != null ? t - lastT : 0;
    lastT = t;
    if (ACTIVE.has(phase) && gap > P.gapMs) { interrupt('gap', t); return; }
    level = meter.push(s, t);
    if (phase === 'ready') feedReady(t);
    else if (phase === 'center') feedCenter(s, t);
    else if (phase === 'return') feedReturn(s, t);
    else if (phase === 'range') feedRange(s, t);
  }

  // Dal disegno: se i report si fermano, nessun report arriva a dirlo.
  function tick(t) {
    if (ACTIVE.has(phase) && lastT != null && t - lastT > P.gapMs) interrupt('gap', t);
  }

  /* --- risultato --- */

  function result() {
    if (phase !== 'done' || !run) return null;
    if (resultCache) return resultCache;
    const out = {
      durationMs: Math.round(run.finishedAt - run.startedAt),
      centerRetries: run.centerRetries,
      interruptions: run.interruptions,
      center: run.centerRun,
      attempts: { ...run.attempts },
      returnSkipped: run.returnSkipped,
      returnTimedOut: run.returnTimedOut,
      rangeSkipped: run.rangeSkipped,
      rangeTimedOut: run.rangeTimedOut,
      flicksPerStick: P.returnDirs.length,
    };
    for (const m of STICKS) {
      const c = run.center[m.key];
      out[m.key] = {
        score: scoreStick(c),
        ret: returnMetrics(run.flicks[m.key], c),
        range: run.range?.[m.key] ?? null,
      };
    }
    out.calibration = Math.min(out.L.score.center, out.R.score.center);
    out.hardware = Math.min(out.L.score.stability, out.R.score.stability);
    resultCache = out;
    return out;
  }

  /* --- vista per la UI (e per lo strumento delle attese) --- */

  const COMPASS = ['left', 'up-left', 'up', 'up-right', 'right', 'down-right', 'down', 'down-left'];
  // Direzioni (8 da 45°, y giù) con almeno un settore ancora vuoto.
  function missingSectors(bins) {
    const out = [];
    for (let i = 0; i < bins.length; i++) {
      if (bins[i] >= P.rangeReach) continue;
      const deg = ((i + 0.5) / bins.length) * 360; // da −180°
      const name = COMPASS[Math.round(deg / 45) % 8];
      if (!out.includes(name)) out.push(name);
    }
    return out;
  }

  const stickName = k => (k === 'L' ? 'left' : 'right');

  // `why` è la ragione di un'attesa: ogni volta che la prova non avanza per
  // più di 2 s deve esserci (test/game-scoring.test.js lo strumenta).
  function view(t) {
    const v = { phase, step: 0, title: 'Precision test', instr: '', why: null, progress: 0, level, retries: run?.centerRetries ?? 0 };
    const silent = lastT == null ? (st?.since != null && t - st.since > P.silentMs) : t - lastT > P.silentMs;
    switch (phase) {
      case 'ready': {
        v.step = 1;
        v.title = 'Center';
        v.instr = st.note === 'touched'
          ? `Movement detected, so that run didn't count. Let go of both sticks to try again (retry ${run.centerRetries} of ${P.centerMaxRetries}).`
          : 'Let go of both sticks. The check starts by itself as soon as they rest.';
        if (silent) v.why = 'No input from the controller. Is it still connected?';
        else if (level === 'red') v.why = 'Waiting: the sticks are moving.';
        else if (level === 'amber') v.why = 'Waiting for the sticks to settle.';
        else v.why = 'Checking that both sticks are at rest…';
        break;
      }
      case 'center': {
        v.step = 1;
        v.title = 'Center';
        v.instr = 'Hands off. Measuring where each stick rests…';
        v.progress = clamp((t - st.start) / P.centerMs, 0, 1);
        v.touched = st.lastDropAt != null && t - st.lastDropAt < P.touchNoteMs;
        if (v.touched) v.why = 'Movement detected: keep your hands off the controller.';
        break;
      }
      case 'return': {
        v.step = 2;
        v.title = 'Return';
        const dir = P.returnDirs[st.index];
        const n = P.returnDirs.length;
        v.target = { index: st.index, dir, of: n };
        v.sticks = { L: { done: st.L.done, stage: st.L.stage }, R: { done: st.R.done, stage: st.R.stage } };
        v.progress = (st.index + (st.L.done ? 0.5 : 0) + (st.R.done ? 0.5 : 0)) / n;
        const pairs = STICKS.map(m => [m.key, st[m.key]]);
        const noted = pairs.find(([, S]) => S.note && t - S.noteAt < P.noteMs);
        if (noted) {
          const [k, S] = noted;
          const name = stickName(k);
          if (S.note === 'guided') v.instr = `That looked guided. Flick the ${name} stick ${dir} and let it spring back on its own.`;
          else if (S.note === 'wrong') v.instr = `That was ${S.wrongDir}. Flick the ${name} stick ${dir}.`;
          else if (S.note === 'unsettled') v.instr = `The ${name} stick didn't come to rest. Flick it ${dir} again and keep your thumb off.`;
          else v.instr = `Your thumb seems to be still on the ${name} stick. Flick it ${dir} and let go completely.`;
        } else if (st.L.done !== st.R.done) {
          v.instr = `Now the ${st.L.done ? 'right' : 'left'} stick: flick it ${dir} and let go (${st.index + 1} of ${n}).`;
        } else {
          v.instr = `Flick both sticks ${dir} and let go (${st.index + 1} of ${n}).`;
        }
        const waiting = pairs.filter(([, S]) => !S.done);
        const slow = waiting.find(([, S]) => (S.stage === 'settling' || S.stage === 'measuring') && t - S.tRel > P.settleFallbackMs);
        if (silent) v.why = 'No input from the controller.';
        else if (slow) v.why = `Waiting for the ${stickName(slow[0])} stick to come to rest.`;
        else if (waiting.some(([, S]) => S.stage === 'aim' || S.stage === 'wrong' || S.stage === 'armed')) v.why = `Waiting for your flick ${dir}.`;
        v.rests = { L: run.flicks.L.map(f => ({ x: f.x, y: f.y })), R: run.flicks.R.map(f => ({ x: f.x, y: f.y })) };
        v.ref = run.center;
        v.skippable = true;
        break;
      }
      case 'range': {
        v.step = 3;
        v.title = 'Range';
        v.instr = 'Roll both sticks slowly around the edge until both rings are full.';
        const need = P.rangeCoverage * st.tracker.left.bins.length;
        const cl = coveredBins(st.tracker.left.bins), cr = coveredBins(st.tracker.right.bins);
        v.progress = clamp(Math.min(cl, cr) / need, 0, 1);
        v.bins = { L: st.tracker.left.bins, R: st.tracker.right.bins };
        v.reach = P.rangeReach;
        if (silent) v.why = 'No input from the controller.';
        else if (t - st.lastGrowth > P.rangeStallMs) {
          const parts = [];
          if (cl < need) parts.push(`left stick ${missingSectors(st.tracker.left.bins).join(', ')}`);
          if (cr < need) parts.push(`right stick ${missingSectors(st.tracker.right.bins).join(', ')}`);
          v.why = `Waiting for the rings to fill${parts.length ? `: ${parts.join('; ')}` : ''}.`;
        }
        v.skippable = true;
        break;
      }
      case 'interrupted': {
        v.step = st.of === 'center' ? 1 : st.of === 'return' ? 2 : 3;
        v.title = GAME_PHASES[v.step - 1];
        v.instr = 'Interrupted. Press Retry to run this check again.';
        v.why = st.reason === 'hidden'
          ? 'The page was in the background, so the timing can’t be trusted.'
          : st.reason === 'few'
            ? 'Too few readings arrived from the controller to measure.'
            : 'The controller stopped sending data for a moment.';
        v.retry = 'Retry';
        break;
      }
      case 'center-failed': {
        v.step = 1;
        v.title = 'Center';
        v.instr = 'Couldn’t measure the center: the sticks kept moving. Rest the controller on a table, then press Try again.';
        v.why = st.reason === 'never-still'
          ? `The sticks never came to rest in ${Math.round(P.readyTimeoutMs / 1000)} seconds. If nobody was touching them, the sensor itself is jittering (wear or dirt), which calibration can’t fix.`
          : `Movement was detected in ${P.centerMaxRetries + 1} runs in a row, and a touched run never gets a score.`;
        v.retry = 'Try again';
        break;
      }
      case 'done':
        v.step = 4;
        v.title = 'Result';
        v.progress = 1;
        break;
      default:
        break;
    }
    return v;
  }

  return {
    start,
    feed,
    tick,
    interrupt,
    retry,
    skip,
    view,
    reset,
    result,
    get phase() { return phase; },
    params: P,
  };
}

/* ---------------- "Previous": chiave locale del controller ---------------- */

// "Previous" appartiene a un controller: la chiave è SHA-256(sale ‖ seriale),
// con un sale casuale conservato in questo browser. Né il seriale né la chiave
// lasciano il browser, e senza il sale la chiave non riporta al seriale.
export async function controllerKey(rawSerial, saltHex, subtle = globalThis.crypto?.subtle) {
  const serial = String(rawSerial ?? '').replace(/\0/g, '').trim();
  if (!serial || !saltHex || !subtle) return null;
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const text = new TextEncoder().encode(serial);
  const buf = new Uint8Array(salt.length + text.length);
  buf.set(salt);
  buf.set(text, salt.length);
  const digest = new Uint8Array(await subtle.digest('SHA-256', buf));
  return Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
}

// Senza seriale leggibile il risultato va in uno slot "non identificato" e il
// confronto lo dice: potrebbe essere un altro controller.
export const UNIDENTIFIED = 'unidentified';

function loadStore(storage) {
  try {
    const v = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    return v && typeof v === 'object' && v.entries && typeof v.entries === 'object' ? v : { v: 4, entries: {} };
  } catch {
    return { v: 4, entries: {} };
  }
}

export function loadPrevious(storage, key) {
  if (!storage || !key) return null;
  return loadStore(storage).entries[key] ?? null;
}

// Salva solo i numeri che servono al confronto: niente seriale.
export function savePrevious(storage, key, res, now = Date.now()) {
  if (!storage || !key) return;
  const store = loadStore(storage);
  const pick = s => ({ offset: s.offset, noise: s.noise, x: s.x, y: s.y, center: s.center, stability: s.stability });
  store.entries[key] = { ts: now, calibration: res.calibration, hardware: res.hardware, L: pick(res.L.score), R: pick(res.R.score) };
  const keys = Object.keys(store.entries).sort((a, b) => store.entries[b].ts - store.entries[a].ts);
  for (const k of keys.slice(MAX_REMEMBERED)) delete store.entries[k];
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(store));
    for (const k of LEGACY_KEYS) storage.removeItem(k);
  } catch { /* storage pieno o negato: il test funziona comunque */ }
}

export function localSalt(storage, random = n => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  try {
    let salt = storage.getItem(SALT_KEY);
    if (!salt || !/^[0-9a-f]{32}$/.test(salt)) {
      salt = Array.from(random(16), b => b.toString(16).padStart(2, '0')).join('');
      storage.setItem(SALT_KEY, salt);
    }
    return salt;
  } catch {
    return null;
  }
}

const agoText = (ts, now) => {
  const days = Math.max(0, Math.round((now - ts) / 86400000));
  return days === 0 ? 'earlier today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

// Confronto prima/dopo per il report (HTML). `prev` viene da loadPrevious.
export function comparisonHtml(prev, res, { unidentified = false, now = Date.now() } = {}) {
  if (!prev) {
    return '<p class="game-compare">First result for this controller saved. Run the test again after a calibration to compare.</p>';
  }
  const rows = STICKS.map(m => {
    const p = prev[m.key], c = res[m.key].score;
    const verdict = compareStick(p, c)?.center ?? 'same';
    const change = verdict !== 'same'
      ? `${stepsText(p.offset)} &rarr; ${stepsText(c.offset)}`
      : `${stepsText(c.offset)}, as before`;
    return `<li><span>${cap(m.name)}</span> ${change} <b class="game-delta" data-change="${verdict}">${verdict}</b></li>`;
  }).join('');
  const who = unidentified ? ' (serial unreadable, so it may be another controller)' : '';
  return `<div class="game-compare">
      <p>Previous result ${agoText(prev.ts, now)}${who}: Calibration ${prev.calibration} &rarr; ${res.calibration}, Hardware ${prev.hardware} &rarr; ${res.hardware}</p>
      <ul class="game-compare-list">${rows}</ul>
      <p class="game-compare-rule">A change counts only when a stick moved by at least one full step of 128; smaller differences are measurement noise.</p>
    </div>`;
}

/* ---------------- canvas di gioco ---------------- */

const INK = '#0a0a0a';
const GRID = '#e4e4e0';
// Guide con significato: lo stesso --edge (3.25:1 su bianco) dei quadranti di app.js.
const EDGE = '#8f8f8a';
const INSET_BG = '#f3f3f0';
// Ingrandimento dell'inserto centrale: 1 LSB ≈ 6 px a 220 px di quadrante,
// così il pavimento 0.555% e il gradino 1.24% si vedono come punti distinti.
const ZOOM = 8;
const INSET = 0.34;   // raggio dell'inserto, in frazioni del raggio del quadrante

// Quadrante di gioco: stesso scaling DPR di StickDial in app.js. Disegna in
// coordinate -1..1; al centro un inserto ×8 mostra il reticolo dei byte, il
// riposo misurato da Center e dove si è fermato ogni flick.
class GameCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.x = 0;
    this.y = 0;
    this.trail = [];
    const dpr = window.devicePixelRatio || 1;
    this.size = canvas.width; // dimensione logica dal markup
    canvas.width = this.size * dpr;
    canvas.height = this.size * dpr;
    this.ctx.scale(dpr, dpr);
  }

  setPos(x, y) {
    this.x = x;
    this.y = y;
    this.trail.push({ x, y });
    if (this.trail.length > 48) this.trail.shift();
  }

  clearTrail() { this.trail = []; }

  draw(scene, ts, still) {
    const { ctx, size } = this;
    const c = size / 2;
    const R = size / 2 - 16;
    const RI = R * INSET;
    const px = u => c + u * R;
    // coordinate ×8 dentro l'inserto, bloccate al suo bordo
    const zp = (x, y) => {
      let zx = x * ZOOM * R, zy = y * ZOOM * R;
      const d = Math.hypot(zx, zy);
      if (d > RI - 3) { zx *= (RI - 3) / d; zy *= (RI - 3) / d; }
      return [c + zx, c + zy];
    };
    const sc = scene || {};
    ctx.clearRect(0, 0, size, size);

    // griglia di riferimento, stesso linguaggio visivo di StickDial
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c, R / 2, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
    ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
    ctx.stroke();

    // Range: riempimento polare dei 36 settori; sul bordo un arco pieno dove
    // il settore è raggiunto, tratteggiato dove manca ancora.
    if (sc.bins) {
      const n = sc.bins.length;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * 2 * Math.PI - Math.PI;
        const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI;
        const v = Math.min(sc.bins[i], 1.15);
        const ok = sc.bins[i] >= sc.reach;
        if (v > 0.05) {
          ctx.fillStyle = ok ? 'rgba(10,10,10,0.09)' : 'rgba(10,10,10,0.04)';
          ctx.beginPath();
          ctx.moveTo(c, c);
          ctx.arc(c, c, v * R, a0, a1);
          ctx.closePath();
          ctx.fill();
        }
        ctx.strokeStyle = ok ? INK : EDGE;
        ctx.lineWidth = ok ? 3 : 1.5;
        ctx.setLineDash(ok ? [] : [2, 3]);
        ctx.beginPath();
        ctx.arc(c, c, R + 8, a0 + 0.02, a1 - 0.02);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Return: quattro bersagli sul bordo; quello da colpire è pieno e pulsa.
    if (sc.targets) {
      for (const t of sc.targets) {
        const [ux, uy] = DIR_VEC[t.dir];
        const tx = px(ux * 0.9), ty = px(uy * 0.9);
        if (t.state === 'lit') {
          const pulse = still ? 0 : (Math.sin(ts / 180) + 1) / 2;
          ctx.strokeStyle = INK;
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.3 + 0.45 * (1 - pulse);
          ctx.beginPath(); ctx.arc(tx, ty, 11 + pulse * 5, 0, 2 * Math.PI); ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = INK;
          ctx.beginPath(); ctx.arc(tx, ty, 7, 0, 2 * Math.PI); ctx.fill();
          // traccia tratteggiata dal centro verso il bersaglio
          ctx.strokeStyle = EDGE;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 4]);
          ctx.beginPath();
          ctx.moveTo(c + ux * (RI + 6), c + uy * (RI + 6));
          ctx.lineTo(tx - ux * 13, ty - uy * 13);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (t.state === 'done') {
          ctx.fillStyle = INK;
          ctx.beginPath(); ctx.arc(tx, ty, 4, 0, 2 * Math.PI); ctx.fill();
        } else {
          ctx.strokeStyle = EDGE;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(tx, ty, 5, 0, 2 * Math.PI); ctx.stroke();
        }
      }
    }

    // Inserto ×8: il reticolo dei byte vicino al centro.
    if (sc.inset) {
      ctx.fillStyle = INSET_BG;
      ctx.beginPath(); ctx.arc(c, c, RI, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = EDGE;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c, c, RI, 0, 2 * Math.PI); ctx.stroke();
      // i valori possibili di un asse sono (b − 127.5)/127.5: mezzo LSB più k
      const step = STICK_LSB * ZOOM * R;
      ctx.fillStyle = 'rgba(10,10,10,0.2)';
      for (let i = -8; i < 8; i++) {
        for (let j = -8; j < 8; j++) {
          const gx = (i + 0.5) * step, gy = (j + 0.5) * step;
          if (Math.hypot(gx, gy) > RI - 4) continue;
          ctx.fillRect(c + gx - 0.75, c + gy - 0.75, 1.5, 1.5);
        }
      }
      // anello di Center: si chiude man mano che la misura procede
      if (sc.progressRing != null) {
        ctx.strokeStyle = sc.touched ? EDGE : INK;
        ctx.lineWidth = 3;
        ctx.setLineDash(sc.touched ? [3, 3] : []);
        ctx.beginPath();
        ctx.arc(c, c, RI + 5, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * sc.progressRing);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // riposo misurato da Center (croce) e punti di assestamento dei flick
      if (sc.ref) {
        const [rx, ry] = zp(sc.ref.x, sc.ref.y);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(rx - 5, ry); ctx.lineTo(rx + 5, ry);
        ctx.moveTo(rx, ry - 5); ctx.lineTo(rx, ry + 5);
        ctx.stroke();
      }
      // anelli vuoti: più flick fermi nello stesso byte restano distinguibili
      for (const p of sc.rests ?? []) {
        const [dx, dy] = zp(p.x, p.y);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(dx, dy, 5.5, 0, 2 * Math.PI); ctx.stroke();
      }
      ctx.fillStyle = EDGE;
      ctx.font = '600 9px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('×8', c, c + RI - 5);
    }

    // scia del puntatore (fuori dall'inserto)
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      if (sc.inset && Math.hypot(a.x, a.y) < INSET && Math.hypot(b.x, b.y) < INSET) continue;
      ctx.strokeStyle = `rgba(10,10,10,${(i / this.trail.length) * 0.3})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px(a.x), px(a.y));
      ctx.lineTo(px(b.x), px(b.y));
      ctx.stroke();
    }

    // punto corrente: dentro l'inserto è disegnato ×8, fuori a scala 1
    ctx.fillStyle = INK;
    ctx.beginPath();
    if (sc.inset && Math.hypot(this.x, this.y) < INSET) {
      const [zx, zy] = zp(this.x, this.y);
      // più piccolo quando ci sono anelli di assestamento: non li copre
      ctx.arc(zx, zy, sc.rests?.length ? 2.5 : 4.5, 0, 2 * Math.PI);
    } else {
      ctx.arc(px(this.x), px(this.y), 5, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
}

/* ============================================================
   initGame — guscio DOM
   ============================================================ */

export function initGame(deps) {
  const $ = id => document.getElementById(id);
  const getSticks = deps.getSticks;
  const isAvailable = deps.isAvailable;
  const subscribe = deps.subscribe ?? (() => () => {});
  const getSerial = deps.getSerial ?? (() => null);
  // Apertura/chiusura del modale delegate ad app.js quando fornite: lì vive
  // l'animazione di uscita. Senza di esse il gioco resta autonomo.
  const showModal = deps.showModal;
  const hideModal = deps.hideModal;
  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Elementi DOM (tutti presenti in index.html).
  const modal = $('modal-game');
  const canvasL = new GameCanvas($('game-dial-l'));
  const canvasR = new GameCanvas($('game-dial-r'));
  const elPhase = $('game-phase');
  const elInstr = $('game-instr');
  const elWhy = $('game-why');
  const elSteps = $('game-steps');
  const elProgress = $('game-progress');
  const elProgressBar = elProgress.querySelector('i');
  const elHandsOff = $('game-handsoff');
  const elDials = $('game-dials');
  const elIntro = $('game-intro');
  const elLast = $('game-last');
  const elRun = $('game-run-actions');
  const elReport = $('game-report');
  const elReportActions = $('game-report-actions');
  const btnStart = $('btn-game-start');
  const btnExit = $('btn-game-exit');
  const btnRetry = $('btn-game-retry');
  const btnSkip = $('btn-game-skip');
  const btnResume = $('btn-game-resume');
  const introText = elInstr.textContent;

  const engine = createPrecisionTest();
  let rafId = null;
  let unsubscribe = null;
  let isOpen = false;
  let reported = false;
  // Epoca dell'apertura: un report asincrono (hash della chiave) iniziato
  // prima di una chiusura non scrive nel modale riaperto.
  let epoch = 0;
  // Chiave del controller per "Previous", calcolata all'apertura.
  let keyPromise = Promise.resolve(null);

  // Le regioni live (#game-instr, #game-why) si riscrivono solo quando il
  // testo cambia: la vista è ricalcolata a ogni frame, e riscrivere lo stesso
  // testo può farlo rileggere allo screen reader.
  const setText = (el, value) => { if (el && el.textContent !== value) el.textContent = value; };
  const show = (el, on) => el?.classList.toggle('hidden', !on);

  /* ---------------- report HID → macchina a stati ---------------- */

  function onSample(s, t) {
    engine.feed(s, t);
    if (engine.phase === 'done' && !reported) finishSequence();
  }

  /* ---------------- loop rAF: solo disegno e controllo dei buchi ---------------- */

  function startLoop() {
    if (rafId != null) return;
    const tick = ts => {
      rafId = requestAnimationFrame(tick);
      step(ts);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function sceneFor(v, k) {
    if (v.phase === 'ready' || v.phase === 'center') {
      return { inset: true, progressRing: v.phase === 'center' ? v.progress : 0, touched: !!v.touched || v.level === 'red' };
    }
    if (v.phase === 'return') {
      const S = v.sticks[k];
      return {
        inset: true,
        ref: v.ref?.[k] ?? null,
        rests: v.rests?.[k] ?? [],
        targets: engine.params.returnDirs.map((dir, i) => ({
          dir,
          state: i < v.target.index || (i === v.target.index && S.done) ? 'done' : i === v.target.index ? 'lit' : 'todo',
        })),
      };
    }
    if (v.phase === 'range') return { bins: v.bins[k], reach: v.reach };
    if (v.phase === 'interrupted' || v.phase === 'center-failed') return { inset: true };
    return {};
  }

  function renderView(v) {
    if (v.phase === 'idle' || v.phase === 'done') return;
    setText(elPhase, v.title);
    setText(elInstr, v.instr);
    setText(elWhy, v.why ?? '');
    elProgressBar.style.width = `${Math.round(clamp(v.progress, 0, 1) * 100)}%`;
    // passi: fatto / attivo / da fare
    elSteps?.querySelectorAll('li').forEach((li, i) => {
      const state = i + 1 < v.step ? 'done' : i + 1 === v.step ? 'active' : 'todo';
      if (li.dataset.state !== state) {
        li.dataset.state = state;
        if (state === 'active') li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
      }
    });
    const handsOff = v.phase === 'ready' || v.phase === 'center';
    show(elHandsOff, handsOff);
    if (handsOff) renderHandsOff(elHandsOff, v.level, HANDS_OFF_LABELS.quick);
    show(btnSkip, !!v.skippable);
    show(btnResume, !!v.retry);
    if (v.retry) setText(btnResume, v.retry);
  }

  function step(ts) {
    const now = performance.now();
    engine.tick(now);
    const v = engine.view(now);
    renderView(v);
    // disegno sempre, anche a riposo (intro/report): mostra la posizione viva
    const s = getSticks();
    canvasL.setPos(s.lx, s.ly);
    canvasR.setPos(s.rx, s.ry);
    canvasL.draw(sceneFor(v, 'L'), ts, reducedMotion);
    canvasR.draw(sceneFor(v, 'R'), ts, reducedMotion);
  }

  /* ---------------- sequenza ---------------- */

  function startSequence() {
    reported = false;
    elInstr.classList.remove('sr-only');
    engine.start(performance.now());
    show(elIntro, false);
    show(elReport, false);
    show(elReportActions, false);
    show(elDials, true);
    show(elProgress, true);
    show(elSteps, true);
    show(elRun, true);
    canvasL.clearTrail();
    canvasR.clearTrail();
    renderView(engine.view(performance.now()));
  }

  async function finishSequence() {
    reported = true;
    const my = epoch;
    const res = engine.result();
    let key = null;
    try { key = await keyPromise; } catch { key = null; }
    if (my !== epoch) return;
    const slot = key ?? UNIDENTIFIED;
    const prev = loadPrevious(storage, slot);
    renderReport(res, prev, slot === UNIDENTIFIED);
    savePrevious(storage, slot, res);
    // Evento locale (mai inviato: la telemetria v1 porta solo le rapide).
    // Niente seriale né chiave: i numeri grezzi, per ritarare le ancore.
    deps.onReport?.(eventOf(res));

    show(elDials, false);
    show(elProgress, false);
    show(elHandsOff, false);
    show(elSteps, false);
    show(elRun, false);
    setText(elPhase, 'Result');
    // Il risultato si annuncia dalla regione live; a schermo lo dicono già i
    // due numeri grandi, quindi la riga resta solo per lo screen reader.
    elInstr.classList.add('sr-only');
    setText(elInstr, `Calibration ${res.calibration}, Hardware ${res.hardware}.`);
    setText(elWhy, '');
    show(elReport, true);
    show(elReportActions, true);
    // Il fuoco era sul pannello (Start nascosto): va sul punteggio, che lo
    // screen reader legge per primo; Tab prosegue verso "Run test again".
    elReport.querySelector('.game-overall')?.focus({ preventScroll: true });
  }

  function eventOf(res) {
    const r3 = v => (typeof v === 'number' ? +v.toFixed(3) : v);
    const stick = s => ({
      off: r3(s.score.offset),
      noise: r3(s.score.noise),
      xy: [r3(s.score.x * 100), r3(s.score.y * 100)],
      center: s.score.center,
      stability: s.score.stability,
      ret: s.ret ? { n: s.ret.n, H: r3(s.ret.H), B: r3(s.ret.B), settleMs: Math.round(s.ret.settleMs) } : null,
      range: s.range ? { coverage: r3(s.range.coverage), circ: r3(s.range.circ), under: r3(s.range.under), over: r3(s.range.over) } : null,
    });
    return {
      v: 4,
      calibration: res.calibration,
      hardware: res.hardware,
      L: stick(res.L),
      R: stick(res.R),
      durationMs: res.durationMs,
      centerRetries: res.centerRetries,
      interruptions: res.interruptions,
      attempts: res.attempts,
      returnSkipped: res.returnSkipped,
      rangeSkipped: res.rangeSkipped,
    };
  }

  function renderReport(res, prev, unidentified) {
    const row = (label, detail, val) =>
      `<div class="game-score-row"><span>${label} <small>${detail}</small></span><b>${val}</b></div>`;
    const sub = (label, text) => `<p class="game-sub"><span>${label}</span> ${text}</p>`;
    const col = (name, s) => `
        <div class="game-stick-col">
          <h4>${name} stick</h4>
          ${row('Center', formatOffset(s.score.offset), s.score.center)}
          ${row('Stability', `&plusmn;${s.score.noise.toFixed(1)}% jitter`, s.score.stability)}
          ${sub('Return', returnText(s.ret, res.flicksPerStick))}
          ${sub('Range', rangeText(s.range))}
        </div>`;
    elReport.innerHTML = `
      <div class="game-overall" tabindex="-1" aria-label="Calibration ${res.calibration} out of 100, Hardware ${res.hardware} out of 100">
        <div class="game-metric"><span class="game-overall-num">${res.calibration}</span><span class="game-overall-cap">Calibration</span></div>
        <div class="game-metric"><span class="game-overall-num">${res.hardware}</span><span class="game-overall-cap">Hardware</span></div>
      </div>
      <p class="game-verdict">${headlineSentence(res)}</p>
      ${comparisonHtml(prev, res, { unidentified })}
      <div class="game-breakdown">
        ${col('Left', res.L)}
        ${col('Right', res.R)}
      </div>
      <p class="game-formula">Calibration is the Center score of the weaker stick: 100 at the measurement limit, 90 one step of 128 off, 60 at 3.5%. Hardware is its stability, which calibration can't change. Return and Range are for information only.</p>
    `;
  }

  /* ---------------- apertura / chiusura ---------------- */

  function showIntro() {
    engine.reset();
    show(elIntro, true);
    show(elReport, false);
    show(elReportActions, false);
    show(elDials, true); // i quadranti restano vivi per provare gli stick
    show(elProgress, false);
    show(elHandsOff, false);
    show(elSteps, false);
    show(elRun, false);
    setText(elPhase, 'Precision test');
    elInstr.classList.remove('sr-only');
    setText(elInstr, introText);
    setText(elWhy, '');
    setText(elLast, '');
  }

  async function showLast(my) {
    let key = null;
    try { key = await keyPromise; } catch { key = null; }
    if (my !== epoch || !elLast) return;
    const prev = loadPrevious(storage, key ?? UNIDENTIFIED);
    if (!prev) return;
    setText(elLast, `Last result ${key ? 'for this controller' : 'in this browser'}, ${agoText(prev.ts, Date.now())}: Calibration ${prev.calibration}, Hardware ${prev.hardware}.`);
  }

  // open(bypassGate): bypassGate=true salta isAvailable (hook dev senza controller).
  function open(bypassGate = false) {
    if (!bypassGate && !isAvailable()) return;
    epoch += 1;
    isOpen = true;
    reported = false;
    canvasL.clearTrail();
    canvasR.clearTrail();
    showIntro();
    const salt = storage ? localSalt(storage) : null;
    keyPromise = controllerKey(getSerial(), salt).catch(() => null);
    showLast(epoch);
    unsubscribe?.();
    unsubscribe = subscribe(onSample);
    showModal ? showModal() : modal.classList.remove('hidden');
    startLoop();
  }

  function close() {
    stopLoop();          // niente loop fantasma
    unsubscribe?.();
    unsubscribe = null;
    isOpen = false;
    epoch += 1;
    engine.reset();
    // usa la chiusura animata di app.js quando disponibile, così l'uscita del
    // gioco è coerente con gli altri modali
    hideModal ? hideModal() : modal.classList.add('hidden');
  }

  // Tab in background: rAF si ferma e i tempi non sono più affidabili.
  document.addEventListener('visibilitychange', () => {
    if (isOpen && document.hidden) engine.interrupt('hidden', performance.now());
  });

  /* ---------------- wiring bottoni del gioco ---------------- */

  const idle = () => engine.phase === 'idle' || engine.phase === 'done';
  btnStart.addEventListener('click', () => { if (idle()) startSequence(); });
  btnExit.addEventListener('click', close);
  btnRetry?.addEventListener('click', () => { if (idle()) startSequence(); });
  btnSkip?.addEventListener('click', () => {
    engine.skip(performance.now());
    if (engine.phase === 'done' && !reported) finishSequence();
  });
  btnResume?.addEventListener('click', () => engine.retry(performance.now()));

  return { open, close };
}

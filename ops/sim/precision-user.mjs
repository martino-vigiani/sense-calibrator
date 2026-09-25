// Utente e controller simulati per il test di precisione v4 (js/game.js).
// Solo sviluppo: guida la vera macchina a stati `createPrecisionTest` con
// report a ~250 Hz quantizzati sul reticolo a 8 bit, e un utente che reagisce
// a ciò che la vista gli chiede (lascia gli stick, flick verso il bersaglio,
// giro sul bordo) con tempi di reazione casuali ma riproducibili.
//
// Tutto qui è un MODELLO (model-verified): i tempi di reazione, la molla e la
// forma del bordo sono ipotesi ragionevoli, non misure su un DualSense. Il
// valore serve a due cose: (1) la durata mediana dichiarata nella copy, (2)
// lo strumento "nessuna attesa oltre 2 s senza spiegazione", che guarda la
// vista a ogni frame come farebbe l'utente.
import { createPrecisionTest } from '../../js/game.js';
import { rng, gauss } from './fake-dualsense.mjs';

const DIRS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const WRONG = { up: 'right', right: 'down', down: 'left', left: 'up' };

// Stick di default: riposo al pavimento (byte 127/128), rumore sotto 1 LSB.
export const PERFECT_STICK = Object.freeze({ rest: [-0.5, -0.5], noise: 0.3 });

// Parametri dell'utente modello. Tempi in ms.
export const USER_DEFAULTS = Object.freeze({
  // dal click su Start a mani lontane (se le teneva sugli stick)
  handsOnAtStart: 0.5,
  releaseAfter: [200, 1200],
  // lettura dell'istruzione prima di ogni flick e prima del giro
  reactFlick: [500, 1300],
  reactRange: [800, 1600],
  reactRetry: [900, 2000],
  // un flick: andata, tenuta, poi rilascio (molla) o ritorno accompagnato
  flickOutMs: 50,
  flickHoldMs: [60, 160],
  springTauMs: 6,
  guidedMs: 320,
  pGuided: 0.08,
  pWrong: 0.03,
  // scarto tra i due pollici nello stesso flick
  thumbSkewMs: [0, 60],
  // giro sul bordo: tempo per giro, un giro e mezzo di solito basta
  lapMs: [1100, 2200],
  // errore di ritorno della molla (LSB), verso la parte da cui arriva
  returnErrLsb: [0, 1.2],
});

function pick(r, [a, b]) { return a + r() * (b - a); }

// simulateRun({ seed, sticks: { L, R }, user, scenario, params })
//   sticks.L/R: { rest: [x, y] in LSB (byte = floor(128 + pos)), noise: σ LSB,
//                 square: 0..1 (bordo quadrato), reach: raggio massimo }
//   scenario: {
//     touch: { stick, from, dur, amp }  tocco in movimento durante Center
//            (from relativo all'inizio di Center)
//     hold: true                       pollice che si muove per tutto Center
//     neverFlick: true, skipReturnAt   Return senza flick (salto o tetto)
//     gap: { at, dur }                 report fermi (assoluto)
//     hidden: { at }                   tab in background (assoluto)
//     muteWhy: true                    toglie i "perché" (controllo negativo
//                                      dello strumento delle attese)
//   }
// Ritorna { result, phase, durationMs, deadWaits, explainedWaits, trace }.
export function simulateRun({
  seed = 1, sticks = {}, user = {}, scenario = {}, params = {}, maxMs = 240000, periodMs = 4, trace = false,
} = {}) {
  const r = rng(seed);
  const hr = rng(seed ^ 0x5eed);
  const U = { ...USER_DEFAULTS, ...user };
  const model = {
    L: { ...PERFECT_STICK, square: 0.15, reach: 1.02, ...sticks.L },
    R: { ...PERFECT_STICK, square: 0.15, reach: 1.02, ...sticks.R },
  };
  for (const k of ['L', 'R']) model[k].ret = [0, 0];
  const engine = createPrecisionTest(params);

  // movimenti in corso: { stick, from, to, at(t) → [dx, dy] normalizzati }
  const motions = [];
  const disp = (k, t) => {
    let dx = 0, dy = 0;
    for (const m of motions) {
      if (m.stick !== k || t < m.from || t > m.to) continue;
      const d = m.at(t);
      dx += d[0]; dy += d[1];
    }
    return [dx, dy];
  };

  function flick(k, dir, t0, guided) {
    const [ux, uy] = DIRS[dir];
    const hold = pick(r, U.flickHoldMs);
    const out = U.flickOutMs;
    const rel = t0 + out + hold;
    const back = guided ? U.guidedMs : U.springTauMs * 8;
    const errLsb = pick(r, U.returnErrLsb);
    motions.push({
      stick: k, from: t0, to: rel + back,
      at: t => {
        const a = t < t0 + out ? (t - t0) / out
          : t < rel ? 1
            : guided ? Math.max(0, 1 - (t - rel) / U.guidedMs) : Math.exp(-(t - rel) / U.springTauMs);
        return [ux * a, uy * a];
      },
    });
    // la molla si ferma un po' dalla parte da cui arriva (ipotesi del modello)
    return { rel, back, apply: () => { model[k].ret = [ux * errLsb, uy * errLsb]; } };
  }

  function rotate(k, t0, lap, dirSign, until) {
    motions.push({
      stick: k, from: t0, to: until,
      at: t => {
        const th = dirSign * ((t - t0) / lap) * 2 * Math.PI;
        const c = Math.cos(th), s = Math.sin(th);
        // bordo tra cerchio e quadrato: raggio 1/max(|c|,|s|)^square
        const rr = model[k].reach / Math.max(Math.abs(c), Math.abs(s)) ** model[k].square;
        const ramp = Math.min(1, (t - t0) / 150);
        return [c * rr * ramp, s * rr * ramp];
      },
    });
  }

  function sample(t) {
    const out = {};
    for (const [k, ax, ay] of [['L', 'lx', 'ly'], ['R', 'rx', 'ry']]) {
      const m = model[k];
      const [dx, dy] = disp(k, t);
      const pos = (i, d) => m.rest[i] + m.ret[i] + m.noise * gauss(r) + d * 127.5;
      const byte = v => Math.max(0, Math.min(255, Math.floor(128 + v)));
      out[ax] = (byte(pos(0, dx)) - 127.5) / 127.5;
      out[ay] = (byte(pos(1, dy)) - 127.5) / 127.5;
    }
    return out;
  }

  // --- utente reattivo ---
  const plan = { nextAt: 0, handled: null, pendingApply: [] };
  let centerStart = null;

  if (r() < U.handsOnAtStart) {
    const until = pick(r, U.releaseAfter);
    for (const k of ['L', 'R']) {
      motions.push({ stick: k, from: 0, to: until, at: t => [0.04 * Math.sin(t / 37 + (k === 'L' ? 0 : 1)), 0.05 * Math.cos(t / 53)] });
    }
  }

  function userStep(t, v) {
    for (const p of plan.pendingApply.filter(p => t >= p.at)) p.apply();
    plan.pendingApply = plan.pendingApply.filter(p => t < p.at);

    if (v.phase === 'center' && centerStart == null) {
      centerStart = t;
      // il tocco sceneggiato capita alla prima corsa di Center, non a ogni ripresa
      if (scenario.touch && !plan.touched) {
        plan.touched = true;
        const { stick, from, dur, amp = 0.2, shape = 'brush' } = scenario.touch;
        const t0 = t + from;
        // 'brush': sfregamento veloce; 'creep': spinta lenta che resta, sotto
        // la soglia di spread di ogni finestra da 120 ms
        // (sale in dur/2 e torna in dur/2)
        const at = shape === 'creep'
          ? tt => [amp * (1 - Math.abs(2 * (tt - t0) / dur - 1)), 0]
          : tt => [amp * Math.sin(tt / 23), amp * 0.6 * Math.cos(tt / 31)];
        motions.push({ stick, from: t0, to: t0 + dur, at });
      }
      if (scenario.hold) {
        for (const k of ['L', 'R']) motions.push({ stick: k, from: t, to: t + 60000, at: tt => [0.12 * Math.sin(tt / 29), 0.1 * Math.cos(tt / 41)] });
      }
    }
    if (v.phase !== 'center') centerStart = v.phase === 'ready' ? null : centerStart;

    if (v.phase === 'interrupted' || v.phase === 'center-failed') {
      const key = `retry:${v.phase}:${engine.view(t).why}`;
      if (plan.handled !== key) { plan.handled = key; plan.nextAt = t + pick(r, U.reactRetry); }
      if (t >= plan.nextAt && v.phase === 'interrupted') { engine.retry(t); plan.handled = null; }
      return;
    }

    if (v.phase === 'return') {
      if (scenario.neverFlick) {
        if (scenario.skipReturnAt != null && t >= scenario.skipReturnAt + (plan.returnAt ??= t)) engine.skip(t);
        return;
      }
      const need = ['L', 'R'].filter(k => !v.sticks[k].done && (v.sticks[k].stage === 'aim'));
      const key = `ret:${v.target.index}:${need.join('')}:${v.instr}`;
      if (!need.length) return;
      if (plan.handled !== key) { plan.handled = key; plan.nextAt = t + pick(r, U.reactFlick); return; }
      if (t < plan.nextAt) return;
      plan.nextAt = Infinity;
      for (const k of need) {
        const guided = r() < U.pGuided;
        const dir = r() < U.pWrong ? WRONG[v.target.dir] : v.target.dir;
        const f = flick(k, dir, t + pick(r, U.thumbSkewMs), guided);
        plan.pendingApply.push({ at: f.rel, apply: f.apply });
      }
      return;
    }

    if (v.phase === 'range') {
      if (plan.handled !== 'range') {
        plan.handled = 'range';
        const t0 = t + pick(r, U.reactRange);
        const lap = pick(r, U.lapMs);
        rotate('L', t0, lap, 1, t0 + 60000);
        rotate('R', t0 + pick(r, U.thumbSkewMs), lap * (0.9 + 0.2 * r()), -1, t0 + 60000);
      }
    }
  }

  // --- ciclo: report a ~250 Hz, frame a 60 Hz ---
  engine.start(0);
  let t = 0;
  let nextFrame = 0;
  // Strumento delle attese: un tratto di oltre 2 s in cui la prova non avanza
  // e la vista non dice perché (why nullo in ogni frame) è un'attesa morta.
  // `quiet` è l'ultimo frame in cui qualcosa è cambiato o c'era un perché.
  let sig = null, sigSince = 0, quiet = 0, flagged = false, counted = false;
  const deadWaits = [];
  let explainedWaits = 0;
  const rows = [];
  const inGap = tt => scenario.gap && tt >= scenario.gap.at && tt < scenario.gap.at + scenario.gap.dur;
  let hiddenDone = false;
  let lastPhase = null;

  while (t < maxMs) {
    const v = engine.view(t);
    if (v.phase === 'done' || v.phase === 'center-failed') break;
    userStep(t, v);
    if (scenario.hidden && !hiddenDone && t >= scenario.hidden.at) { hiddenDone = true; engine.interrupt('hidden', t); }
    if (!inGap(t)) engine.feed(sample(t), t);
    while (nextFrame <= t) {
      engine.tick(nextFrame);
      const fv = engine.view(nextFrame);
      // controllo negativo dello strumento: una vista che non spiega mai nulla
      if (scenario.muteWhy) fv.why = null;
      const s = `${fv.phase}|${Math.floor(fv.progress * 50)}|${fv.target?.index ?? ''}|${fv.sticks ? `${fv.sticks.L.done}${fv.sticks.R.done}` : ''}|${fv.retries}`;
      if (s !== sig) { sig = s; sigSince = nextFrame; quiet = nextFrame; flagged = false; counted = false; }
      if (fv.why) quiet = nextFrame;
      if (!flagged && nextFrame - quiet > 2000) {
        flagged = true;
        deadWaits.push({ t: nextFrame, phase: fv.phase, instr: fv.instr });
      }
      if (!counted && fv.why && nextFrame - sigSince > 2000) { counted = true; explainedWaits += 1; }
      if (trace && fv.phase !== lastPhase) { rows.push({ t: nextFrame, phase: fv.phase, instr: fv.instr, why: fv.why }); lastPhase = fv.phase; }
      nextFrame += 1000 / 60;
    }
    t += Math.max(1, periodMs + 0.3 * gauss(hr));
  }
  const result = engine.result();
  return {
    result,
    phase: engine.phase,
    durationMs: result ? result.durationMs : null,
    deadWaits,
    explainedWaits,
    trace: rows,
  };
}

export function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

// Durate di N corse con utenti e stick diversi (seed 1..N). Stick tratti dal
// reticolo: pavimento, un passo, drift lieve, qualche rumore.
export function durationSample(n = 60, { seedBase = 1 } = {}) {
  const rests = [[-0.5, -0.5], [0.5, -0.5], [1.5, -0.5], [-2.5, 0.5], [3.5, 1.5], [-0.5, 5.5]];
  const out = [];
  for (let i = 0; i < n; i++) {
    const seed = seedBase + i;
    const res = simulateRun({
      seed,
      sticks: {
        L: { rest: rests[i % rests.length], noise: 0.25 + (i % 3) * 0.2 },
        R: { rest: rests[(i * 5 + 2) % rests.length], noise: 0.3 },
      },
    });
    out.push(res);
  }
  return out;
}

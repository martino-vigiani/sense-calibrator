import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIFT_MOVE_SPREAD, summarizeResult } from '../js/calib/measure.js';
import { STICK_LSB, measureOffset } from '../js/calib/sampling.js';
import {
  WIZARD_DEFAULTS, captureRestReference, checkBefore, cornerProjection, createCornerTracker, gateWizardSample, restTolerance,
  sampleGateOptions, wizardComparison, axisWorsening,
} from '../js/calib/wizard-gate.js';

// Gate del wizard guidato (WS7) su una sorgente scriptata: gli stick sono una
// funzione del tempo, un report ogni 4 ms, e l'attesa scade sul tempo dei
// report (waitForStable non campiona mai su un timer).
function scriptedSource(at) {
  const listeners = new Set();
  const source = {
    t: 0,
    sticks: at(0),
    now: () => source.t,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    listeners,
  };
  return source;
}
// Fa girare i report finché la promessa non si risolve (al massimo `maxMs`).
async function drive(source, at, promise, maxMs = 20_000) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let n = 0; !settled && n < maxMs / 4; n++) {
    source.t += 4;
    source.sticks = at(source.t);
    for (const fn of [...source.listeners]) fn();
    await Promise.resolve();
  }
  return promise;
}
const idleClock = { setTimeout: () => 1, clearTimeout: () => {} };
const REST = { lx: 0.2, ly: -0.1, rx: -0.05, ry: 0.03 }; // riposo lontano dal centro: il pubblico del wizard
const TOP_LEFT = { tx: -0.7, ty: -0.7 };

function reachedTracker() {
  const t = createCornerTracker(TOP_LEFT);
  t.push({ lx: -0.7, ly: -0.7, rx: -0.6, ry: -0.6 });
  return t;
}

test('the rest tolerance is max(4 LSB, 3 × the start noise), from the noisier stick', () => {
  assert.equal(restTolerance({ noise: [0, 0] }), 4 * STICK_LSB);
  assert.equal(restTolerance(null), 4 * STICK_LSB);
  assert.ok(Math.abs(restTolerance({ noise: [0.4, 2] }) - 0.06) < 1e-12);
});

test('the rest tolerance has a ceiling: DRIFT_MOVE_SPREAD per axis, whose diagonal stays inside the escape radius', () => {
  assert.equal(WIZARD_DEFAULTS.maxTol, DRIFT_MOVE_SPREAD);
  // la diagonale del controllo per asse non supera mai il raggio dell'uscita
  assert.ok(Math.SQRT2 * WIZARD_DEFAULTS.maxTol < WIZARD_DEFAULTS.escapeLsb * STICK_LSB);
  assert.equal(restTolerance({ noise: [21.2, 0.5] }), DRIFT_MOVE_SPREAD);
  assert.equal(restTolerance({ noise: [Infinity, 1] }), 4 * STICK_LSB, 'non-finite noise is ignored');
  // anche una tol passata a mano viene tagliata, e l'uscita resta 24 LSB
  const opts = sampleGateOptions({ ref: REST, tol: 0.635 });
  assert.equal(opts.tol, DRIFT_MOVE_SPREAD);
  const esc = sampleGateOptions({ ref: REST, tol: 0.635, escaped: true });
  assert.equal(esc.nearRadius, WIZARD_DEFAULTS.escapeLsb * STICK_LSB);
  assert.equal(esc.tol, WIZARD_DEFAULTS.escapeLsb * STICK_LSB);
});

// Orologio con sleep sul tempo dei report, per measureOffset (vero modulo).
function timedClock(source) {
  const sleeps = [];
  return {
    setTimeout: () => 1,
    clearTimeout: () => {},
    sleep: ms => new Promise(resolve => sleeps.push({ until: source.t + ms, resolve })),
    tick() {
      for (let i = sleeps.length - 1; i >= 0; i--) {
        if (source.t >= sleeps[i].until) sleeps.splice(i, 1)[0].resolve();
      }
    },
  };
}
async function driveTimed(source, clock, at, promise, maxMs = 20_000) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let n = 0; !settled && n < maxMs / 4; n++) {
    source.t += 4;
    source.sticks = at(source.t);
    for (const fn of [...source.listeners]) fn();
    clock.tick();
    await Promise.resolve();
  }
  return promise;
}
// Misura di partenza del wizard (1000 ms, come la pagina) con i moduli veri.
async function measureBefore(at) {
  const source = scriptedSource(at);
  const clock = timedClock(source);
  return driveTimed(source, clock, at, measureOffset(source, clock, 1000));
}
// Rumore deterministico di ±1 LSB per asse, come uno stick a riposo.
const jitter = (t, k) => STICK_LSB * Math.sin(t * 0.37 + k * 1.7);
const restAt = t => ({ lx: REST.lx + jitter(t, 0), ly: REST.ly + jitter(t, 1), rx: REST.rx + jitter(t, 2), ry: REST.ry + jitter(t, 3) });

test('WS7 regression: a touch during the start measurement no longer yields an 81-LSB tolerance that samples a thumb 57% away', async () => {
  // Il pollice spinge lo stick sinistro di (15%, 15%) per 250 ms del secondo
  // di misura, poi lo lascia.
  const touched = t => {
    const s = restAt(t);
    return t >= 400 && t < 650 ? { ...s, lx: s.lx + 0.15, ly: s.ly + 0.15 } : s;
  };
  const raw = await measureBefore(touched);
  const before = summarizeResult(raw);
  // Senza tetto (il codice di prima): tolleranza ~81 LSB.
  const uncapped = restTolerance(before, { maxTol: Infinity });
  assert.ok(uncapped / STICK_LSB > 75 && uncapped / STICK_LSB < 90, `${(uncapped / STICK_LSB).toFixed(1)} LSB`);
  // Pollice fermo a (40%, 40%) dal riferimento: 57% radiale.
  const thumb = { ...REST, lx: REST.lx + 0.4, ly: REST.ly + 0.4 };
  assert.ok(Math.abs(Math.hypot(0.4, 0.4) - 0.566) < 0.001);
  const held = () => thumb;
  let source = scriptedSource(held);
  const old = await drive(source, held, gateWizardSample(source, idleClock, {
    tracker: reachedTracker(), ref: REST, tol: uncapped, params: { maxTol: Infinity },
  }));
  assert.equal(old.ok, true, 'reproduces the defect: without the ceiling the held thumb is sampled');

  // 1. La misura disturbata viene rifiutata prima di calibBegin.
  assert.deepEqual(checkBefore(raw), { ok: false, reason: 'noisy' });
  assert.equal(checkBefore(before).ok, false, 'the summarized result is rejected too');
  // 2. E anche se passasse, la tolleranza ha il tetto e il pollice non si campiona.
  const tol = restTolerance(before);
  assert.equal(tol, DRIFT_MOVE_SPREAD);
  source = scriptedSource(held);
  const now = await drive(source, held, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol }));
  assert.deepEqual(now, { ok: false, reason: 'timeout' });
  // Nemmeno con l'uscita: 57% è ben oltre 18.8%.
  source = scriptedSource(held);
  const esc = await drive(source, held, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol, escaped: true }));
  assert.deepEqual(esc, { ok: false, reason: 'timeout' });
});

test('a start measurement with normal noise is accepted, and its tolerance still samples a stick back at rest', async () => {
  for (const lsb of [1, 2, 3]) {
    const at = t => ({
      lx: REST.lx + lsb * jitter(t, 0), ly: REST.ly + lsb * jitter(t, 1),
      rx: REST.rx + lsb * jitter(t, 2), ry: REST.ry + lsb * jitter(t, 3),
    });
    const raw = await measureBefore(at);
    assert.deepEqual(checkBefore(raw), { ok: true }, `±${lsb} LSB`);
    const tol = restTolerance(summarizeResult(raw));
    assert.ok(tol >= 4 * STICK_LSB && tol < DRIFT_MOVE_SPREAD, `±${lsb} LSB: ${(tol / STICK_LSB).toFixed(1)} LSB`);
    // ±3 LSB (spread 6 LSB) supera già QUICK_STABLE_SPREAD: lì decide il gate
    // di stabilità, non la posizione, come prima.
    if (lsb === 3) continue;
    const source = scriptedSource(at);
    const r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol }));
    assert.equal(r.ok, true, `±${lsb} LSB`);
  }
  // un rumore da sensore consumato (3%, sotto la soglia del 4%) passa
  assert.deepEqual(checkBefore({ noise: [3, 0.8] }), { ok: true });
  assert.deepEqual(checkBefore({ noise: [4.01, 0.8] }), { ok: false, reason: 'noisy' });
  assert.equal(WIZARD_DEFAULTS.beforeMaxNoise, (DRIFT_MOVE_SPREAD * 100) / 2);
});

test('a start measurement that is mostly movement or has no data is rejected', async () => {
  assert.deepEqual(checkBefore(null), { ok: false, reason: 'no-data' });
  assert.deepEqual(checkBefore({ noise: [NaN, 1] }), { ok: false, reason: 'no-data' });
  assert.deepEqual(checkBefore({ left: { noise: 1 }, right: { noise: 1 }, stableFraction: 0.2 }), { ok: false, reason: 'moving' });
  // una mano che muove lo stick per tutto il secondo (±6%, 5 Hz)
  const moving = t => ({ ...restAt(t), rx: REST.rx + 0.06 * Math.sin(2 * Math.PI * t / 200) });
  const raw = await measureBefore(moving);
  assert.equal(checkBefore(raw).ok, false);
});

test('corner reach is the projection toward the corner, tracked as a maximum and reset per step', () => {
  const p = cornerProjection({ lx: -0.7, ly: -0.7, rx: 0.5, ry: 0 }, TOP_LEFT);
  assert.ok(Math.abs(p.left - 0.99) < 0.01);
  assert.ok(p.right < 0);
  const t = createCornerTracker(TOP_LEFT);
  assert.deepEqual(t.missing(), ['left', 'right']);
  t.push({ lx: -0.5, ly: -0.5, rx: -0.3, ry: -0.3 }); // sinistro 0.71, destro 0.42
  assert.deepEqual(t.missing(), ['right']);
  t.push({ lx: 0, ly: 0, rx: -0.45, ry: -0.45 }); // il ritorno al centro non cancella il massimo
  assert.deepEqual(t.missing(), []);
  t.reset({ tx: 0.7, ty: -0.7 });
  assert.deepEqual(t.missing(), ['left', 'right']);
  // un drift enorme (20%) non basta a "raggiungere" un angolo
  t.push({ lx: 0.2, ly: -0.2, rx: 0.2, ry: -0.2 });
  assert.deepEqual(t.missing(), ['left', 'right']);
});

test('a corner that was not reached refuses the sample at once, with no wait', async () => {
  const at = () => REST;
  const source = scriptedSource(at);
  const r = await gateWizardSample(source, idleClock, { tracker: createCornerTracker(TOP_LEFT), ref: REST, tol: 4 * STICK_LSB });
  assert.deepEqual(r, { ok: false, reason: 'corner', missing: ['left', 'right'], axes: [{ side: 'left', axes: ['x', 'y'] }, { side: 'right', axes: ['x', 'y'] }] });
  assert.equal(source.t, 0);
  assert.equal(source.listeners.size, 0);
});

test('sticks back at their rest point are sampled after a 300 ms hold', async () => {
  const at = () => ({ lx: REST.lx + 2 * STICK_LSB, ly: REST.ly, rx: REST.rx, ry: REST.ry - 3 * STICK_LSB });
  const source = scriptedSource(at);
  const r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol: 4 * STICK_LSB }));
  assert.equal(r.ok, true);
  assert.ok(source.t >= 240 && source.t < 400, `${source.t} ms`);
});

test('a thumb held still on the stick (spread 0) is never sampled: timeout after 5 s', async () => {
  for (const held of [{ ...REST, lx: REST.lx + 0.15 }, { ...REST, lx: -0.7, ly: -0.7 }, { ...REST, lx: REST.lx + 5 * STICK_LSB }]) {
    const at = () => held;
    const source = scriptedSource(at);
    const r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol: 4 * STICK_LSB }));
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    assert.ok(source.t >= WIZARD_DEFAULTS.timeoutMs && source.t < WIZARD_DEFAULTS.timeoutMs + 20);
  }
});

// Stick che striscia: ~20 LSB in una decina di secondi, spread per finestra
// sotto il gate. Fermo abbastanza per il gate di stabilità, ma mai al suo
// punto di riposo.
const creep = t0 => t => ({ ...REST, lx: REST.lx + 20 * STICK_LSB * (1 - Math.exp(-(t - t0) / 3000)) });

test('a creeping stick passes only through the explicit escape', async () => {
  let at = creep(-2000);
  let source = scriptedSource(at);
  let r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol: 4 * STICK_LSB }));
  assert.equal(r.reason, 'timeout', 'no automatic relaxation');
  at = creep(-2000);
  source = scriptedSource(at);
  r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol: 4 * STICK_LSB, escaped: true }));
  assert.equal(r.ok, true);
});

test('the escape keeps a stable window mandatory and the gate at most DRIFT_MOVE_SPREAD', async () => {
  const opts = sampleGateOptions({ ref: REST, tol: 0.03, escaped: true });
  assert.equal(opts.spread, DRIFT_MOVE_SPREAD);
  assert.equal(opts.near, REST, 'the escape keeps the position check');
  assert.equal(opts.nearRadius, WIZARD_DEFAULTS.escapeLsb * STICK_LSB);
  assert.equal(sampleGateOptions({ ref: REST, tol: 0.03 }).spread, WIZARD_DEFAULTS.spread);
  assert.ok(WIZARD_DEFAULTS.spread <= DRIFT_MOVE_SPREAD && WIZARD_DEFAULTS.escapeSpread <= DRIFT_MOVE_SPREAD);
  // una mano che muove lo stick (±6%, 5 Hz) non viene campionata nemmeno con l'uscita
  const at = t => ({ ...REST, lx: REST.lx + 0.06 * Math.sin(2 * Math.PI * t / 200) });
  const source = scriptedSource(at);
  const r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol: 0.03, escaped: true }));
  assert.equal(r.reason, 'timeout');
});

test('the escape keeps a fixed position bound: a thumb held still at a corner or at ~20% is never sampled', async () => {
  // 24 LSB ≈ 18.8%: largo per uno stick che striscia, stretto per una mano ferma
  assert.ok(WIZARD_DEFAULTS.escapeLsb >= 20 && WIZARD_DEFAULTS.escapeLsb * STICK_LSB < 0.2);
  const held = [
    { ...REST, lx: -0.66, ly: -0.67 }, // pollice fermo sull'angolo
    { ...REST, rx: REST.rx + 0.2 }, // pollice al 20% su un asse
    // diagonale: 18 LSB per asse (25 LSB radiali) passerebbe un limite per asse
    { ...REST, lx: REST.lx + 18 * STICK_LSB, ly: REST.ly + 18 * STICK_LSB },
  ];
  for (const pos of held) {
    const at = () => pos;
    const source = scriptedSource(at);
    const r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol: 4 * STICK_LSB, escaped: true }));
    assert.deepEqual(r, { ok: false, reason: 'timeout' }, JSON.stringify(pos));
  }
  // lasciato lo stick, lo stesso passo campiona
  const at = () => ({ ...REST, lx: REST.lx + 12 * STICK_LSB });
  const source = scriptedSource(at);
  const r = await drive(source, at, gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: REST, tol: 4 * STICK_LSB, escaped: true }));
  assert.equal(r.ok, true);
});

test('no reference, no sample: not even with the escape', async () => {
  const at = () => REST;
  const source = scriptedSource(at);
  for (const escaped of [false, true]) {
    const r = await gateWizardSample(source, idleClock, { tracker: reachedTracker(), ref: null, tol: 4 * STICK_LSB, escaped });
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
  }
  assert.equal(source.listeners.size, 0);
});

test('with the escape the reference is still captured, with the wider spread gate and within 50%', async () => {
  // rumore ±5% a 5 Hz: oltre QUICK_STABLE_SPREAD, sotto DRIFT_MOVE_SPREAD
  let at = t => ({ ...REST, lx: REST.lx + 0.025 * Math.sin(2 * Math.PI * t / 200) });
  let source = scriptedSource(at);
  assert.equal(await drive(source, at, captureRestReference(source, idleClock)), null);
  source = scriptedSource(at);
  const ref = await drive(source, at, captureRestReference(source, idleClock, { escaped: true }));
  assert.ok(ref && Math.abs(ref.lx - REST.lx) < 0.02);
  at = () => ({ ...REST, lx: -0.66, ly: -0.67 });
  source = scriptedSource(at);
  assert.equal(await drive(source, at, captureRestReference(source, idleClock, { escaped: true })), null);
});

test('the in-session reference is a stable window within 50%, never a thumb on the rim', async () => {
  let at = () => REST;
  let source = scriptedSource(at);
  const ref = await drive(source, at, captureRestReference(source, idleClock));
  assert.ok(Math.abs(ref.lx - REST.lx) < 1e-9);
  at = () => ({ ...REST, rx: 0.8 });
  source = scriptedSource(at);
  assert.equal(await drive(source, at, captureRestReference(source, idleClock)), null);
});

test('the before/after comparison formats both sticks and flags a worse result', () => {
  const before = { off: [18.2, 0.555], noise: [0.5, 0.4] };
  let c = wizardComparison(before, { off: [0.555, 0.555], noise: [0.5, 0.4] });
  assert.equal(c.worse, false);
  assert.equal(c.centered, true);
  assert.equal(c.sticks[0].beforeLabel, '18.2%');
  assert.equal(c.sticks[0].afterLabel, '0.6% · at floor');
  c = wizardComparison(before, { off: [3.1, 19.5] });
  assert.equal(c.worse, true);
  assert.equal(c.afterWorst, 19.5);
  c = wizardComparison(before, null);
  assert.equal(c.measured, false);
  assert.equal(c.worse, false);
  assert.equal(c.sticks[1].afterLabel, '—');
});

test('a corner needs both axes in the same report, not one axis pushed to the edge', () => {
  // Il caso trovato in revisione: X a fondo verso sinistra, Y fermo. La sola
  // proiezione diagonale (0,6) lo accettava come angolo in alto a sinistra.
  const t = createCornerTracker(TOP_LEFT);
  t.push({ lx: -0.85, ly: 0, rx: -0.85, ry: 0 });
  assert.deepEqual(t.missing(), ['left', 'right']);
  assert.deepEqual(t.missingAxes(), [{ side: 'left', axes: ['y'] }, { side: 'right', axes: ['y'] }]);
  // X a fondo e poi Y a fondo in due momenti diversi non sono un angolo.
  t.push({ lx: 0, ly: -0.85, rx: 0, ry: -0.85 });
  assert.deepEqual(t.missing(), ['left', 'right']);
  // Un angolo vero, anche imperfetto, sì.
  t.push({ lx: -0.8, ly: -0.4, rx: -0.55, ry: -0.55 });
  assert.deepEqual(t.missing(), []);
});

test('the gate names the short axis when a corner is missed', async () => {
  const tracker = createCornerTracker(TOP_LEFT);
  tracker.push({ lx: -0.9, ly: -0.1, rx: -0.6, ry: -0.6 });
  const r = await gateWizardSample(scriptedSource(() => REST), idleClock, { tracker, ref: REST, tol: 4 * STICK_LSB });
  assert.deepEqual(r, { ok: false, reason: 'corner', missing: ['left'], axes: [{ side: 'left', axes: ['y'] }] });
});

test('an axis that moved away from center is reported even when the stick improved', () => {
  const before = { off: [3.1, 0.555], xy: [[3.0, 0.4], [0.4, 0.4]] };
  const after = { off: [2.8, 0.555], xy: [[0.4, 2.8], [0.4, 0.4]] };
  const c = wizardComparison(before, after);
  assert.equal(c.worse, false);
  assert.deepEqual(c.axisWorse, [{ stick: 'Left', axis: 'Y', before: 0.4, after: 2.8 }]);
  // un passo (0,784) non basta: stessa soglia di worseEps
  assert.deepEqual(axisWorsening({ xy: [[0.4, 0.4], [0.4, 0.4]] }, { xy: [[1.18, 0.4], [0.4, 0.4]] }), []);
  assert.deepEqual(axisWorsening(null, after), []);
});

test('B1/N6: floor medians do not trigger axis worsening, while a milder stick change stays separate', () => {
  const before = { off: [9.03, 0.555], xy: [[9.03, 0], [0, 0]] };
  const after = { off: [0.555, 2], xy: [[0.392, 0.392], [2, 0]] };
  const cmp = wizardComparison(before, after);
  assert.equal(cmp.worse, false);
  assert.deepEqual(cmp.stickWorse.map(s => s.name), ['Right']);
  assert.deepEqual(axisWorsening({ xy: [[0, 0], [0, 0]] }, { xy: [[0.555, 0], [0, 0]] }), []);
  assert.deepEqual(axisWorsening({ xy: [[0, 0], [0, 0]] }, { xy: [[0.555, 0], [0, 0]] }, { worseEps: 0 }), []);
  assert.deepEqual(axisWorsening(before, after), [{ stick: 'Right', axis: 'X', before: 0, after: 2 }]);
});

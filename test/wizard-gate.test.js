import test from 'node:test';
import assert from 'node:assert/strict';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';
import { STICK_LSB } from '../js/calib/sampling.js';
import {
  WIZARD_DEFAULTS, captureRestReference, cornerProjection, createCornerTracker, gateWizardSample, restTolerance,
  sampleGateOptions, wizardComparison,
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
  assert.deepEqual(r, { ok: false, reason: 'corner', missing: ['left', 'right'] });
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

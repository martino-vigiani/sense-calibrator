import test from 'node:test';
import assert from 'node:assert/strict';
import { runVariant, makeSession, loadScenario, POP, fitParams } from '../ops/sim/run.mjs';
import { rng } from '../ops/sim/fake-dualsense.mjs';
import { syntheticTemplates } from '../ops/sim/population.mjs';
import scenario, { LEFT_X, drawCapture } from '../ops/sim/scenarios/left-x-capture.mjs';

// Scenario "errore di cattura sulla X sinistra" (BDM-040, ipotesi X1). Solo
// popolazione sintetica: la CI non ha la telemetria. Risultati model-verified.

const median = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

test('drawCapture: always the same number of random draws, whatever branch it takes', () => {
  const counts = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    let n = 0;
    drawCapture(() => { n++; return r(); });
    counts.add(n);
  }
  assert.equal(counts.size, 1, 'two draws of different shape consumed a different amount of numbers');
});

test('drawCapture: distribution matches the documented parameters', () => {
  const bs = [], jumps = [];
  for (let seed = 1; seed <= 4000; seed++) {
    const { b0, jumps: j } = drawCapture(rng(seed * 31 + 5));
    bs.push(b0);
    jumps.push(...j.slice(1));
    assert.equal(j.length, LEFT_X.maxBegins);
  }
  const zero = bs.filter(b => Math.abs(b) < 1).length / bs.length;
  assert.ok(Math.abs(zero - LEFT_X.zeroP) < 0.03, `near-zero share ${zero}`);
  assert.ok(bs.every(b => b <= LEFT_X.maxLsb), 'truncated at maxLsb');
  assert.ok(bs.every(b => b > -1), 'the error always points the same way (output toward −X)');
  const big = bs.filter(b => b >= 1);
  assert.ok(Math.abs(median(big) - LEFT_X.medianLsb) < 0.8, `median ${median(big)}`);
  const none = jumps.filter(j => j === 0).length / jumps.length;
  const large = jumps.filter(j => Math.abs(j) >= LEFT_X.bigLsb[0]).length / jumps.length;
  assert.ok(Math.abs(none - LEFT_X.jumpP.none) < 0.02, `no-jump share ${none}`);
  assert.ok(Math.abs(large - (1 - LEFT_X.jumpP.none - LEFT_X.jumpP.small)) < 0.015, `large-jump share ${large}`);
  assert.ok(jumps.every(j => Math.abs(j) <= LEFT_X.bigLsb[1]));
});

test('the bias sits on stick 0, axis 0 only', () => {
  const tpl = syntheticTemplates()[3];
  const spec = makeSession(tpl, rng(11), POP);
  const right = { ...spec.sticks[1] };
  scenario.apply(spec, rng(1), tpl);
  assert.deepEqual(spec.sticks[0].bias, { axis: 0, B: 0 }, 'the fitted random bias of the left stick is switched off');
  assert.deepEqual(spec.sticks[1], right, 'the right stick keeps the normal model');

  const dev = { sticks: [{}, { bias: { axis: 1, B: 2 } }], sendFeatureReport: () => Promise.resolve() };
  scenario.setup({ dev, r2: rng(5) });
  assert.deepEqual(dev.sticks[0].bias, { axis: 0, B: drawCapture(rng(5)).b0 });
  assert.deepEqual(dev.sticks[1].bias, { axis: 1, B: 2 });
  dev.sendFeatureReport(0x82, [1, 0, 1]);
  dev.sendFeatureReport(0x82, [1, 0, 1]);
  assert.deepEqual(dev.sticks[1].bias, { axis: 1, B: 2 }, 'a calibBegin never touches the right stick');
});

test('calibBegin n adds exactly the pre-drawn jump n', () => {
  const dev = { sticks: [{}, {}], sendFeatureReport: () => Promise.resolve() };
  const { b0, jumps } = drawCapture(rng(9));
  scenario.setup({ dev, r2: rng(9) });
  let B = b0;
  for (let n = 1; n <= 6; n++) {
    dev.sendFeatureReport(0x82, [1, 0, 1]);
    B += jumps[n - 1];
    assert.ok(Math.abs(dev.sticks[0].bias.B - B) < 1e-9, `begin ${n}`);
    assert.equal(dev.sticks[0].bias.axis, 0);
  }
  // sample ed end non muovono nulla
  const before = dev.sticks[0].bias.B;
  dev.sendFeatureReport(0x82, [3, 0, 1]);
  dev.sendFeatureReport(0x82, [2, 0, 1]);
  assert.equal(dev.sticks[0].bias.B, before);
});

test('synthetic run: deterministic, paired with normal, left X follows the capture error', async () => {
  const opts = { n: 24, seed: 3, population: 'synthetic', impl: 'module', variant: 'baseline' };
  const a = await runVariant({ ...opts, scenario: 'left-x-capture' });
  const b = await runVariant({ ...opts, scenario: 'left-x-capture' });
  assert.deepEqual(a, b, 'same seed, same sessions');
  const normal = await runVariant({ ...opts, scenario: 'normal' });
  assert.deepEqual(a.map(s => s.tpl), normal.map(s => s.tpl), 'same template sequence as normal');

  // dove ha calibrato, la X sinistra esce spostata verso −X di circa B finale e la Y esatta
  const committed = a.filter(s => s.calibEnds > 0 && s.outcome !== 'stalled');
  assert.ok(committed.length >= 10, `only ${committed.length} sessions calibrated`);
  let close = 0;
  for (const s of committed) {
    const [x, y] = s.extra.left;
    if (Math.abs(x + s.extra.bFinal) < 3 && Math.abs(y) < 3) close++;
  }
  assert.ok(close / committed.length > 0.9, `left residual follows the bias in ${close}/${committed.length}`);
  assert.ok(committed.some(s => s.extra.bFinal > 5), 'some sessions have a clear error');
});

test('with the error switched off the scenario consumes no random number of the model', async () => {
  // B ≡ 0 e nessun salto: dove la baseline non ha bias sullo stick sinistro
  // la sessione deve coincidere campo per campo con `normal`. Se lo scenario
  // spostasse la sequenza di `r` o `dev.r`, le sessioni divergerebbero.
  const saved = { ...LEFT_X, jumpP: { ...LEFT_X.jumpP } };
  Object.assign(LEFT_X, { zeroP: 1, zeroLsb: 0, jumpP: { none: 1, small: 0 } });
  try {
    const opts = { n: 48, seed: 5, population: 'synthetic', impl: 'module', variant: 'baseline' };
    const off = await runVariant({ ...opts, scenario: 'left-x-capture' });
    const normal = await runVariant({ ...opts, scenario: 'normal' });
    const tpls = syntheticTemplates();
    const fit = fitParams();
    const pop = { ...POP, fw: { ...POP.fw, sf: fit.sf } };
    let compared = 0;
    for (let i = 0; i < opts.n; i++) {
      const spec = makeSession(tpls[i % tpls.length], rng(opts.seed * 100003 + i), pop, { fit });
      if (spec.sticks[0].bias.B !== 0) continue;
      compared++;
      const pick = ({ outcome, calibEnds, trueQuant, counts, s }) => ({ outcome, calibEnds, trueQuant, counts, passXY: s.passXY, passes: s.passes, after: s.after });
      assert.deepEqual(pick(off[i]), pick(normal[i]), `session ${i}`);
    }
    assert.ok(compared >= 20, `only ${compared} sessions without a baseline bias on the left stick`);
  } finally {
    Object.assign(LEFT_X, saved);
  }
});

test('real population keeps only BDM-040 templates, synthetic keeps them all', async () => {
  const scen = await loadScenario('left-x-capture');
  const tpls = [{ board: 'BDM-040' }, { board: 'BDM-030' }, { board: 'BDM-040' }];
  assert.equal(scen.templates(tpls, { population: 'real' }).length, 2);
  assert.equal(scen.templates(tpls, { population: 'synthetic' }).length, 3);
  assert.equal(scen.base, 'normal');
});

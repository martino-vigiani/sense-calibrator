import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuick, QUICK_DEFAULTS } from '../js/calib/quick.js';
import { DRIFT_MIN_STABLE } from '../js/calib/measure.js';
import { writeLockFor } from '../js/ui/outcome.js';

// Regressione diagnostica Quick: prima si conservava solo il raggio finale,
// perdendo stabilità, rumore grezzo, tentativi e tenuta di rilascio. Tutte le
// misure qui sono sintetiche; nessuna spiega la causa o prova l'hardware.
const CENTERED_OFFSETS = [0.55, 0.6];
const BASELINE_OFFSETS = [2.5, 1.5];
const EXTREME_OFFSETS = [25, 1.5]; // oltre il tetto Quick del 15%
const BASELINE_NOISE = [0.2, 0.3];
const BASELINE_RAW_NOISE = 0.4;

function makeReading({ off = CENTERED_OFFSETS, noise = BASELINE_NOISE,
  stableFraction = 1, rawNoise = BASELINE_RAW_NOISE } = {}) {
  return {
    left: { offset: off[0], noise: noise[0], x: off[0] / 100, y: 0 },
    right: { offset: off[1], noise: noise[1], x: off[1] / 100, y: 0 },
    stableFraction, rawNoise,
  };
}

function makeQuickHarness({ baseline = makeReading({ off: BASELINE_OFFSETS }),
  verifies = [makeReading()], holds = [], cancel = false } = {}) {
  const commands = [], waits = [], measurements = [], sleeps = [];
  const timers = new Map();
  let holdIndex = 0, verifyIndex = 0, timerId = 0, time = 0;
  const controller = {
    calibBegin: async () => { commands.push('begin'); },
    calibSample: async () => { commands.push('sample'); },
    calibEnd: async () => { commands.push('end'); },
  };
  const clock = {
    sleep: async ms => { sleeps.push(ms); time += ms; },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => { timers.delete(id); },
  };
  const sampler = {
    waitForStable: async options => {
      waits.push(options);
      if (options.requireCentered) return holds[holdIndex++] ?? true;
      return { center: { lx: 0, ly: 0, rx: 0, ry: 0 } };
    },
    measureOffset: async (ms, options) => {
      measurements.push({ ms, centered: options?.requireCentered === true });
      if (options?.requireCentered) return baseline;
      assert.ok(verifyIndex < verifies.length, 'no extra verification measurement');
      return verifies[verifyIndex++];
    },
  };
  return {
    run: (extra = {}) => runQuick({ controller, clock, sampler,
      source: { now: () => time }, isCancelled: () => cancel, ...extra }),
    commands, waits, measurements, sleeps, timers,
  };
}

const diagnostic = ({ pass = 1, attempt = 1, off = CENTERED_OFFSETS,
  noise = BASELINE_NOISE, stableFraction = 1, rawNoise = BASELINE_RAW_NOISE,
  hold = 'not-required', accepted = true, criterion = 'stable-fraction' } = {}) => ({
  pass, attempt, off, noise, stableFraction, rawNoise, hold, accepted, criterion,
});

function assertOneCommitWithoutExtraIO(harness, { verifyAttempts = 1 } = {}) {
  assert.deepEqual(harness.commands, ['begin', ...Array(12).fill('sample'), 'end'],
    'diagnostics add no command and each commit still contains 12 samples');
  assert.deepEqual(harness.sleeps, [...Array(12).fill(QUICK_DEFAULTS.sampleSettleMs), QUICK_DEFAULTS.endDelayMs],
    'diagnostics add no delay');
  assert.deepEqual(harness.measurements, [
    { ms: QUICK_DEFAULTS.baselineMs, centered: true },
    ...Array.from({ length: verifyAttempts }, () => ({ ms: QUICK_DEFAULTS.verifyMs, centered: false })),
  ]);
  assert.equal(harness.waits.length, 2 + 12 + verifyAttempts - 1,
    'only preflight, pass hold, 12 sample gates and the existing verification retry hold');
  assert.equal(harness.timers.size, 0, 'existing prompt timers are cleared');
}

test('stable extreme verification retains its quality and failed release hold while Write stays disabled', async () => {
  const extreme = makeReading({ off: EXTREME_OFFSETS });
  const h = makeQuickHarness({ verifies: [extreme, extreme], holds: [true, true, false] });

  const result = await h.run();

  assert.equal(result.outcome, 'catastrophic');
  assert.equal(result.worst, EXTREME_OFFSETS[0]);
  assert.equal(writeLockFor({ center: result }).mode, 'disabled');
  assert.deepEqual(result.session.verification, {
    baselineNoise: BASELINE_NOISE, baselineRawNoise: BASELINE_RAW_NOISE,
    attempts: [
      diagnostic({ off: EXTREME_OFFSETS, accepted: false }),
      diagnostic({ attempt: 2, off: EXTREME_OFFSETS, hold: 'not-released', accepted: false }),
    ],
  });
  assertOneCommitWithoutExtraIO(h, { verifyAttempts: 2 });
});

test('unstable extreme verification is recorded as rejected and keeps the catastrophic Write lock', async () => {
  const extreme = makeReading({ off: EXTREME_OFFSETS, noise: [5, 6], stableFraction: 0.1, rawNoise: 6 });
  const h = makeQuickHarness({ verifies: [extreme, extreme] });

  const result = await h.run();

  assert.equal(result.outcome, 'catastrophic');
  assert.equal(writeLockFor({ center: result }).mode, 'disabled');
  assert.deepEqual(result.session.verification.attempts, [
    diagnostic({ off: EXTREME_OFFSETS, noise: [5, 6], stableFraction: 0.1, rawNoise: 6, accepted: false, criterion: 'none' }),
    diagnostic({ attempt: 2, off: EXTREME_OFFSETS, noise: [5, 6], stableFraction: 0.1, rawNoise: 6,
      hold: 'released', accepted: false, criterion: 'none' }),
  ]);
  assertOneCommitWithoutExtraIO(h, { verifyAttempts: 2 });
});

test('an extreme first verification followed by a valid second reading records both and keeps the valid result', async () => {
  const h = makeQuickHarness({ verifies: [makeReading({ off: EXTREME_OFFSETS }), makeReading()] });

  const result = await h.run();

  assert.equal(result.outcome, 'centered');
  assert.deepEqual(result.session.passes, [CENTERED_OFFSETS[1]]);
  assert.deepEqual(result.session.verification.attempts, [
    diagnostic({ off: EXTREME_OFFSETS, accepted: false }),
    diagnostic({ attempt: 2, hold: 'released' }),
  ]);
  assertOneCommitWithoutExtraIO(h, { verifyAttempts: 2 });
});

test('recording a failed retry hold preserves the existing acceptance of its valid measurement', async () => {
  // Il rilascio registrato non era usato come criterio dalla policy: la
  // diagnostica deve mostrarlo, senza introdurre un nuovo gate implicito.
  const h = makeQuickHarness({ verifies: [null, makeReading()], holds: [true, true, false] });

  const result = await h.run();

  assert.equal(result.outcome, 'centered');
  assert.deepEqual(result.session.verification.attempts[1], diagnostic({ attempt: 2, hold: 'not-released' }));
  assertOneCommitWithoutExtraIO(h, { verifyAttempts: 2 });
});

test('an extreme verification followed by missing data keeps the extreme record and catastrophic outcome', async () => {
  const h = makeQuickHarness({ verifies: [makeReading({ off: EXTREME_OFFSETS }), null] });

  const result = await h.run();

  assert.equal(result.outcome, 'catastrophic');
  assert.equal(writeLockFor({ center: result }).mode, 'disabled');
  assert.deepEqual(result.session.verification.attempts[1], diagnostic({
    attempt: 2, off: null, noise: null, stableFraction: null, rawNoise: null,
    hold: 'released', accepted: false, criterion: 'none',
  }));
  assertOneCommitWithoutExtraIO(h, { verifyAttempts: 2 });
});

test('missing verification data stays null without attributing it to a report gap', async () => {
  // Il sampler restituisce null sia senza report sia dopo il budget di gap;
  // Quick non osserva quale dei due, quindi non inventa una causa.
  const h = makeQuickHarness({ verifies: [null, null] });

  const result = await h.run({ params: { maxPasses: 1 } });

  assert.equal(result.outcome, 'unverified');
  assert.deepEqual(result.session.passes, [null]);
  assert.deepEqual(result.session.verification.attempts, [
    diagnostic({ off: null, noise: null, stableFraction: null, rawNoise: null, accepted: false, criterion: 'none' }),
    diagnostic({ attempt: 2, off: null, noise: null, stableFraction: null, rawNoise: null,
      hold: 'released', accepted: false, criterion: 'none' }),
  ]);
  assertOneCommitWithoutExtraIO(h, { verifyAttempts: 2 });
});

test('an unverified pass followed by a valid pass preserves pass and attempt attribution', async () => {
  const h = makeQuickHarness({ verifies: [null, null, makeReading()] });

  const result = await h.run();

  assert.equal(result.outcome, 'centered');
  assert.deepEqual(result.session.passes, [null, CENTERED_OFFSETS[1]]);
  assert.deepEqual(result.session.verification.attempts.map(({ pass, attempt, accepted }) => ({ pass, attempt, accepted })), [
    { pass: 1, attempt: 1, accepted: false },
    { pass: 1, attempt: 2, accepted: false },
    { pass: 2, attempt: 1, accepted: true },
  ]);
  assert.deepEqual(h.commands.filter(command => command !== 'sample'), ['begin', 'end', 'begin', 'end']);
});

for (const [name, stableFraction, rawNoise, criterion] of [
  ['at the stable-fraction threshold', DRIFT_MIN_STABLE, 20, 'stable-fraction'],
  ['below the stable-fraction threshold with excessive noise', DRIFT_MIN_STABLE - 0.001, 20, 'none'],
  ['at the minimum noisy-baseline fraction and noise ratio', 0.2, QUICK_DEFAULTS.verifyNoiseRatio * BASELINE_RAW_NOISE, 'baseline-noise'],
  ['below the minimum noisy-baseline fraction', 0.2 - 0.001, BASELINE_RAW_NOISE, 'none'],
  ['above the noisy-baseline noise ratio', 0.3, QUICK_DEFAULTS.verifyNoiseRatio * BASELINE_RAW_NOISE + 0.001, 'none'],
  ['below the stable-fraction threshold despite rounding to it', DRIFT_MIN_STABLE - 0.0001, 20, 'none'],
]) {
  test(`verification diagnostics identify acceptance ${name}`, async () => {
    const h = makeQuickHarness({ verifies: [makeReading({ stableFraction, rawNoise })] });

    const result = await h.run({ params: { maxPasses: 1, verifyAttempts: 1 } });

    assert.equal(result.session.verification.attempts[0].criterion, criterion);
    assert.equal(result.session.verification.attempts[0].accepted, criterion !== 'none');
    assert.equal(result.outcome, criterion === 'none' ? 'unverified' : 'centered');
    assertOneCommitWithoutExtraIO(h);
  });
}

for (const [name, offset, catastrophic] of [
  ['just below', QUICK_DEFAULTS.catastrophicPct - 0.001, false],
  ['exactly at', QUICK_DEFAULTS.catastrophicPct, true],
  ['just above', QUICK_DEFAULTS.catastrophicPct + 0.001, true],
]) {
  test(`verification acceptance ${name} the catastrophic ceiling uses unrounded measurements`, async () => {
    const h = makeQuickHarness({ verifies: [makeReading({ off: [offset, 1.5] })] });

    const result = await h.run({ params: { maxPasses: 1, verifyAttempts: 1 } });

    assert.equal(result.outcome, catastrophic ? 'catastrophic' : 'worse-than-start');
    assert.equal(result.session.verification.attempts[0].accepted, !catastrophic);
    assert.equal(result.session.verification.attempts[0].criterion, 'stable-fraction');
    assert.equal(result.session.verification.attempts[0].off[0], QUICK_DEFAULTS.catastrophicPct,
      'the rounded diagnostic radius cannot become the policy input');
    assertOneCommitWithoutExtraIO(h);
  });
}

test('legacy sampler measurements retain their acceptance and explicitly lack a stable fraction', async () => {
  const reading = makeReading();
  delete reading.stableFraction;
  delete reading.rawNoise;
  const h = makeQuickHarness({ verifies: [reading] });

  const result = await h.run();

  assert.equal(result.outcome, 'centered');
  assert.deepEqual(result.session.verification.attempts, [
    diagnostic({ stableFraction: null, rawNoise: null, criterion: 'legacy' }),
  ]);
  assertOneCommitWithoutExtraIO(h);
});

test('ordinary verification records only bounded primitive measurements and no sampler identifiers', async () => {
  const reading = makeReading({ noise: [0.12345, 0.87654], stableFraction: 0.98765, rawNoise: 999 });
  reading.serial = 'synthetic-identifier-must-not-be-copied';
  reading.error = new Error('synthetic-free-text-must-not-be-copied');
  const h = makeQuickHarness({ verifies: [reading] });

  const result = await h.run();

  assert.deepEqual(result.session.verification.attempts, [
    diagnostic({ noise: [0.12, 0.88], stableFraction: 0.988, rawNoise: 200 }),
  ]);
  assert.doesNotMatch(JSON.stringify(result.session.verification), /identifier|free-text|serial|error/);
  assertOneCommitWithoutExtraIO(h);
});

test('nonfinite diagnostic metadata becomes null without changing legacy verification decisions', async () => {
  const reading = makeReading({ rawNoise: Infinity });
  delete reading.stableFraction;
  const baseline = makeReading({ off: BASELINE_OFFSETS, rawNoise: NaN });
  const h = makeQuickHarness({ baseline, verifies: [reading] });

  const result = await h.run();

  assert.equal(result.outcome, 'centered');
  assert.equal(result.session.verification.baselineRawNoise, null);
  assert.deepEqual(result.session.verification.attempts, [
    diagnostic({ stableFraction: null, rawNoise: null, criterion: 'legacy' }),
  ]);
});

test('failed preflight records no baseline or verification and sends no command', async () => {
  const h = makeQuickHarness({ holds: [false] });

  const result = await h.run();

  assert.equal(result.outcome, 'preflight');
  assert.deepEqual(result.session.verification, { baselineNoise: null, baselineRawNoise: null, attempts: [] });
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.measurements, []);
  assert.deepEqual(h.sleeps, []);
});

test('a blocked first-pass hold keeps the measured baseline and records no attempted verification', async () => {
  const h = makeQuickHarness({ holds: [true, false] });

  const result = await h.run();

  assert.equal(result.outcome, 'preflight');
  assert.deepEqual(result.session.verification, {
    baselineNoise: BASELINE_NOISE, baselineRawNoise: BASELINE_RAW_NOISE, attempts: [],
  });
  assert.deepEqual(h.commands, []);
  assert.equal(h.measurements.length, 1);
});

test('an already-centered baseline records no verification and sends no command', async () => {
  const h = makeQuickHarness({ baseline: makeReading() });

  const result = await h.run();

  assert.equal(result.outcome, 'already-centered');
  assert.deepEqual(result.session.verification.attempts, []);
  assert.deepEqual(result.session.verification.baselineNoise, BASELINE_NOISE);
  assert.deepEqual(h.commands, []);
});

test('cancel before sampling leaves an open session without inventing verification diagnostics', async () => {
  const h = makeQuickHarness({ cancel: true });

  const result = await h.run();

  assert.equal(result.outcome, 'stalled');
  assert.equal(result.committed, false);
  assert.equal(result.needsPowerCycle, true);
  assert.deepEqual(result.session.verification.attempts, []);
  assert.deepEqual(h.commands, ['begin']);
  assert.equal(h.measurements.length, 1);
});

test('diagnostics stop at sixteen attempts without truncating simulator passes or adding commands', async () => {
  const h = makeQuickHarness({ verifies: Array(18).fill(null) });

  const result = await h.run({ params: { maxPasses: 9 } });

  const attempts = result.session.verification.attempts;
  assert.equal(attempts.length, 16);
  assert.deepEqual(attempts.map(({ pass, attempt }) => [pass, attempt]),
    Array.from({ length: 8 }, (_, index) => [[index + 1, 1], [index + 1, 2]]).flat());
  assert.equal(result.session.passes.length, 9, 'the diagnostic cap never limits the algorithm');
  assert.equal(h.commands.filter(command => command === 'sample').length, 9 * 12);
  assert.equal(h.commands.filter(command => command === 'end').length, 9);
  assert.equal(h.measurements.length, 1 + 18);
});

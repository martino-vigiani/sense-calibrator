import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticsReport } from '../ops/calib-telemetry/diagnostics-report.mjs';
import { buildQuickEvent, validateEventV2 } from '../js/telemetry-v2.js';

// Il fallback Quick conserva l'ultima misura estrema della passata finale.
// Il report deve descrivere quella misura, senza dedurre stabilità dal solo
// raggio, da un tentativo precedente o da dati che la vecchia pagina non aveva.
const STABLE_EXTREME = { off: [25, 1.5], noise: [0.3, 0.2], stableFraction: 1,
  rawNoise: 0.3, criterion: 'stable-fraction' };
const UNSTABLE_EXTREME = { off: [30, 1.5], noise: [6, 0.2], stableFraction: 0.1,
  rawNoise: 6, criterion: 'none' };
const MISSING = { off: null, noise: null, stableFraction: null, rawNoise: null, criterion: 'none' };

function attempt(reading, { pass = 1, attempt = 1 } = {}) {
  return { pass, attempt, ...reading, hold: attempt === 1 ? 'not-required' : 'released', accepted: false };
}

function makeQuickEvent({ attempts, outcome = 'catastrophic' } = {}) {
  const finalPass = attempts?.at(-1)?.pass ?? 1;
  const session = {
    before: { off: [2.5, 1.5] }, after: { off: [30, 1.5] }, passes: Array(finalPass).fill(30),
    ...(attempts ? { verification: { baselineNoise: [0.3, 0.2], baselineRawNoise: 0.3, attempts } } : {}),
  };
  const event = buildQuickEvent({ sid: '1234abcd', seq: 0 }, { session, outcome, committed: true, durMs: 12_000 });
  assert.equal(validateEventV2(event), null, 'the reporter receives an event admitted by the real contract');
  return event;
}

for (const { name, attempts, category } of [
  { name: 'the unstable retry replaces a stable extreme',
    attempts: [attempt(STABLE_EXTREME), attempt(UNSTABLE_EXTREME, { attempt: 2 })], category: 'unstableMeasurement' },
  { name: 'the stable retry replaces an unstable extreme',
    attempts: [attempt(UNSTABLE_EXTREME), attempt(STABLE_EXTREME, { attempt: 2 })], category: 'stableMeasurement' },
  { name: 'a missing retry retains the earlier stable extreme in that pass',
    attempts: [attempt(STABLE_EXTREME), attempt(MISSING, { attempt: 2 })], category: 'stableMeasurement' },
  { name: 'a missing retry retains the earlier unstable extreme in that pass',
    attempts: [attempt(UNSTABLE_EXTREME), attempt(MISSING, { attempt: 2 })], category: 'unstableMeasurement' },
  { name: 'an unstable final pass does not inherit a stable earlier pass',
    attempts: [attempt(STABLE_EXTREME), attempt(UNSTABLE_EXTREME, { pass: 2 })], category: 'unstableMeasurement' },
  { name: 'a missing final pass does not inherit an extreme from an earlier pass',
    attempts: [attempt(STABLE_EXTREME), attempt(MISSING, { pass: 2 })], category: 'unknownMeasurement' },
  { name: 'legacy acceptance without a stable fraction remains unknown',
    attempts: [attempt({ ...STABLE_EXTREME, stableFraction: null, criterion: 'legacy' })], category: 'unknownMeasurement' },
  { name: 'an empty diagnostic list remains unknown', attempts: [], category: 'unknownMeasurement' },
  { name: 'an older event without diagnostics remains unknown', category: 'unknownMeasurement' },
]) {
  test(`catastrophic report attributes measurement quality when ${name}`, () => {
    const event = makeQuickEvent({ attempts });

    const report = diagnosticsReport([event]);

    assert.deepEqual(report.quick.catastrophic, {
      n: 1, stableMeasurement: 0, unstableMeasurement: 0, unknownMeasurement: 0, [category]: 1,
    });
  });
}

test('a recovered ordinary verification is excluded from catastrophic measurement counts', () => {
  const recovered = attempt({ off: [0.55, 0.6], noise: [0.3, 0.2], stableFraction: 1,
    rawNoise: 0.3, criterion: 'stable-fraction' }, { attempt: 2 });
  recovered.accepted = true;
  const event = makeQuickEvent({ attempts: [attempt(STABLE_EXTREME), recovered], outcome: 'centered' });

  const report = diagnosticsReport([event]);

  assert.equal(report.quick.attempts, 2);
  assert.deepEqual(report.quick.catastrophic, {
    n: 0, stableMeasurement: 0, unstableMeasurement: 0, unknownMeasurement: 0,
  });
});

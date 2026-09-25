import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_DEFAULTS } from '../js/calib/quick.js';
import { VARIANTS } from '../ops/sim/variants.mjs';
import { convergedWorseCheck } from '../ops/sim/replay-sequences.mjs';
import { restrictedCompare, untouchedByWs1 } from '../ops/sim/equivalence.mjs';

// Strumenti dei gate di rilascio (ops/sim, solo sviluppo) su righe sintetiche:
// la telemetria reale non entra nei test.

const FLOOR = 0.555;
const row = (before, passes, other = FLOOR) => ({
  t: 'x', before: { off: [before, FLOOR], noise: [0.2, 0.2] }, after: { off: [passes.at(-1), other], noise: [0.2, 0.2] }, passes,
});
const LEGACY = { ...QUICK_DEFAULTS, ...VARIANTS.legacyStop };

test('converged-worse check: plateaus worse than the start continue, ≥15% stops at the ceiling', () => {
  const rows = [
    row(2.287, [3.55, 3.55]), // convergeva peggiore dell'inizio: ora continua
    row(3.551, [100, 100]), // ≥15%: tetto, esito catastrophic
    row(3.551, [2, 2]), // plateau migliore dell'inizio: non entra nel controllo
  ];
  const cw = convergedWorseCheck(rows, QUICK_DEFAULTS, LEGACY);
  assert.equal(cw.legacyConvergedWorse, 2);
  assert.equal(cw.continued, 1);
  assert.equal(cw.stoppedAtCeiling, 1);
  assert.equal(cw.pass, true);
  // Con la regola precedente come candidata il controllo fallisce.
  const same = convergedWorseCheck(rows, LEGACY, LEGACY);
  assert.equal(same.pass, false);
  assert.equal(same.notContinued.length, 2, 'the old rule has no ceiling either');
});

test('restricted equivalence compares only untouched sessions and flags any field difference', () => {
  const rec = (i, { passes = [0.55], before = [2, FLOOR], noise = [0.2, 0.2], unstable = 0, outcome = 'centered' } = {}) => ({
    i, s: { passes, before: { off: before, noise }, after: { off: [FLOOR, FLOOR], noise }, unstableEvents: unstable }, outcome, calibEnds: 1, trueQuant: 0.5, counts: { begin: 1, sample: 12, end: 1 },
  });
  const legacy = [rec(0), rec(1, { unstable: 2 }), rec(2, { noise: [4.2, 0.2] }), rec(3, { before: [0.555, FLOOR] })];
  assert.deepEqual(legacy.map(untouchedByWs1), [true, false, false, false], 'unstable, noisy (above 4 LSB) and centered starts are touched by WS1');
  const same = restrictedCompare(legacy, legacy.map(r => structuredClone(r)));
  assert.deepEqual([same.compared, same.fieldDiffs, same.unexpectedOutcomeChanges], [1, 0, 0]);
  const moved = legacy.map(r => structuredClone(r));
  moved[0].counts.sample = 11;
  moved[1].counts.sample = 3; // non confrontata
  assert.equal(restrictedCompare(legacy, moved).fieldDiffs, 1);
  const relabeled = legacy.map(r => structuredClone(r));
  relabeled[0].outcome = 'worn';
  assert.equal(restrictedCompare(legacy, relabeled).unexpectedOutcomeChanges, 1);
});

test('gate 3.3 compares counts against the paired baseline, and the WS1 forced-hold reference is recorded', async () => {
  const { final15Normal, WS1_FORCED_HOLD } = await import('../ops/sim/release-gates.mjs');
  const high = r => r >= 15;
  // Un LSB attraverso il 15% in entrambe le direzioni: stesso conteggio, passa.
  const swap = final15Normal([14.52, 15.3, 20, 1], [15.3, 14.52, 20, 1], high);
  assert.deepEqual([swap.base, swap.cand, swap.extra, swap.fewer, swap.pass], [2, 2, 1, 1, true]);
  // Una sessione ≥15% in più del codice: fallisce.
  assert.equal(final15Normal([14.52, 20], [15.3, 20], high).pass, false);
  for (const fit of ['best', 'alt1', 'alt2']) for (const seed of [1, 2, 3]) {
    const v = WS1_FORCED_HOLD[`${fit}-s${seed}`];
    assert.ok(Number.isFinite(v) && v >= 0 && v < 0.017, `${fit}-s${seed} recorded`);
  }
});

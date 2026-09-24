import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome, decideAfterPass } from '../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../js/calib/quick.js';
import { replayDecisions } from '../ops/sim/replay-sequences.mjs';

// Regole di oggi, sequenze reali o dal piano. `replayDecisions` applica
// decideAfterPass passata per passata, come fa runQuick.
const stopOf = (passes, params = QUICK_DEFAULTS) => {
  const r = replayDecisions(passes, params);
  return [r.stopAt, r.reason];
};

test('the loop stops at the target, on a plateau, or when the four passes run out', () => {
  assert.deepEqual(stopOf([0.55]), [1, 'target']);
  assert.deepEqual(stopOf([1.24, 0.55]), [2, 'target']);
  assert.deepEqual(stopOf([2, 2]), [2, 'converged']);
  assert.deepEqual(stopOf([1.24, 1.24]), [2, 'converged']);
  assert.deepEqual(stopOf([3.1, 2.2, 1.9, 1.6]), [4, 'budget']);
});

test('a regression never stops the loop, and a plateau after a regression is not convergence', () => {
  const first = decideAfterPass({ pass: 1, worst: 5, prevWorst: null, bestWorst: null }, QUICK_DEFAULTS);
  const second = decideAfterPass({ pass: 2, worst: 5.4, prevWorst: first.prevWorst, bestWorst: first.bestWorst }, QUICK_DEFAULTS);
  assert.equal(second.regressed, true);
  assert.equal(second.stop, false);
  assert.equal(second.bestWorst, 5);
  assert.deepEqual(stopOf([5.0, 5.4, 5.35, 5.35]), [4, 'budget']);
  // Runaway reale dopo il guard: nessuna regola di oggi lo ferma prima del budget.
  assert.deepEqual(stopOf([30.2, 46.67, 46.67, 40.39]), [4, 'budget']);
});

test('decideAfterPass is pure: the caller owns the state', () => {
  const state = Object.freeze({ pass: 2, worst: 2, prevWorst: 2.05, bestWorst: 2.05 });
  const d = decideAfterPass(state, QUICK_DEFAULTS);
  assert.deepEqual(d, { stop: true, reason: 'converged', regressed: false, prevWorst: 2, bestWorst: 2 });
});

test('params override the stop rule without touching the code', () => {
  assert.deepEqual(stopOf([2, 2], { ...QUICK_DEFAULTS, convergeEps: 0 }), [4, 'budget']);
  assert.deepEqual(stopOf([3, 2.5, 2, 1.6], { ...QUICK_DEFAULTS, maxPasses: 3 }), [3, 'budget']);
});

const facts = over => ({ worst: 2, beforeWorst: 3, bestWorst: 2, maxNoise: 0.2, unstableEvents: 0, ...over });

test('classifyOutcome keeps today\'s toast precedence', () => {
  assert.equal(classifyOutcome(facts({ worst: null }), QUICK_DEFAULTS), 'unverified');
  assert.equal(classifyOutcome(facts({ worst: 0.555, maxNoise: 9 }), QUICK_DEFAULTS), 'centered');
  assert.equal(classifyOutcome(facts({ maxNoise: 1.6 }), QUICK_DEFAULTS), 'worn');
  assert.equal(classifyOutcome(facts({ worst: 4, beforeWorst: 3 }), QUICK_DEFAULTS), 'worse-than-start');
  assert.equal(classifyOutcome(facts({ worst: 3, beforeWorst: 3, bestWorst: 1.24 }), QUICK_DEFAULTS), 'lost-ground');
  assert.equal(classifyOutcome(facts({ unstableEvents: 1 }), QUICK_DEFAULTS), 'unstable');
  assert.equal(classifyOutcome(facts(), QUICK_DEFAULTS), 'residual');
  assert.equal(classifyOutcome(facts({ worst: 3.7, beforeWorst: 3, bestWorst: 3.7 }), QUICK_DEFAULTS), 'residual', 'a 0.7 pt change is below one lattice step');
});

// Difetti noti (piano §1 F2, F4), documentati come `todo`: il test descrive il
// comportamento voluto e fallisce finché la policy non cambia. Chi corregge la
// regola rimuove `todo`.
test('[100,100] ends as catastrophic, not converged', { todo: 'quick-policy: catastrophic ceiling' }, () => {
  assert.notEqual(stopOf([100, 100])[1], 'converged');
});

test('a plateau worse than the start is not convergence (bestWorst seeded with before)', { todo: 'quick-policy: seed bestWorst with beforeWorst' }, () => {
  // before 0.555, poi [2, 2]: oggi "converged" con il residuo peggiore dell'inizio.
  const r = replayDecisions([2, 2], QUICK_DEFAULTS, { beforeWorst: 0.555 });
  assert.notEqual(r.reason, 'converged');
});

test('a worn stick that ended worse than the start is told it got worse', { todo: 'quick-policy: worse-than-start before worn' }, () => {
  assert.equal(classifyOutcome(facts({ worst: 5, beforeWorst: 2, maxNoise: 2 }), QUICK_DEFAULTS), 'worse-than-start');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_DEFAULTS, QUICK_CATASTROPHIC_PCT, classifyOutcome, decideAfterPass } from '../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../js/calib/quick.js';
import { QUICK_CENTER_RADIUS } from '../js/quick-center-guard.js';
import { replayDecisions } from '../ops/sim/replay-sequences.mjs';
import { VARIANTS } from '../ops/sim/variants.mjs';

// Regola di arresto ed esito, su sequenze reali (telemetria PG, piano §1) o
// costruite. `replayDecisions` applica decideAfterPass passata per passata
// come fa runQuick, ripassando lo stato; oltre la fine della sequenza
// registrata ripete l'ultimo valore.
const FLOOR = 0.555;
const stopOf = (passes, { params = QUICK_DEFAULTS, beforeWorst = null, otherWorst = null } = {}) => {
  const r = replayDecisions(passes, params, { beforeWorst, otherWorst });
  return [r.stopAt, r.reason];
};
const LEGACY = { ...QUICK_DEFAULTS, ...VARIANTS.legacyStop };

test('the loop stops at the target, on a plateau, or when the four passes run out', () => {
  assert.deepEqual(stopOf([0.55]), [1, 'target']);
  assert.deepEqual(stopOf([1.24, 0.55]), [2, 'target']);
  assert.deepEqual(stopOf([2, 2]), [2, 'converged']);
  assert.deepEqual(stopOf([1.24, 1.24]), [2, 'converged']);
  assert.deepEqual(stopOf([3.1, 2.2, 1.9, 1.6]), [4, 'budget']);
  assert.equal(QUICK_DEFAULTS.maxPasses, 4);
});

test('a regression never stops the loop, and a plateau after a regression is not convergence', () => {
  const first = decideAfterPass({ pass: 1, worst: 5, prevWorst: null, bestWorst: null }, QUICK_DEFAULTS);
  const second = decideAfterPass({ pass: 2, worst: 5.4, prevWorst: first.prevWorst, bestWorst: first.bestWorst, bestPass: first.bestPass }, QUICK_DEFAULTS);
  assert.equal(second.regressed, true);
  assert.equal(second.stop, false);
  assert.equal(second.bestWorst, 5);
  assert.deepEqual(stopOf([5.0, 5.4, 5.35, 5.35]), [4, 'budget']);
  assert.deepEqual(stopOf([5.0, 5.4, 5.35, 5.35], { beforeWorst: 6, otherWorst: FLOOR }), [4, 'budget'], 'the floor cap limits only the passes this rule adds');
});

test('decideAfterPass is pure: the caller owns the state', () => {
  const state = Object.freeze({ pass: 2, worst: 2, beforeWorst: 3, prevWorst: 2.05, bestWorst: 2.05, bestPass: 2.05, otherWorst: 1.24, extraUsed: 0 });
  const d = decideAfterPass(state, QUICK_DEFAULTS);
  assert.deepEqual(d, { stop: true, reason: 'converged', regressed: false, extra: null, prevWorst: 2, bestWorst: 2, bestPass: 2, extraUsed: 0 });
  assert.deepEqual(decideAfterPass(state, QUICK_DEFAULTS), d);
});

test('params override the stop rule without touching the code', () => {
  assert.deepEqual(stopOf([2, 2], { params: { ...QUICK_DEFAULTS, convergeEps: 0 } }), [4, 'budget']);
  assert.deepEqual(stopOf([3, 2.5, 2, 1.6], { params: { ...QUICK_DEFAULTS, maxPasses: 3 } }), [3, 'budget']);
});

test('the physical ceiling is the preflight radius, and every default is exported through QUICK_DEFAULTS', () => {
  assert.equal(QUICK_CATASTROPHIC_PCT, QUICK_CENTER_RADIUS * 100);
  for (const [k, v] of Object.entries(POLICY_DEFAULTS)) assert.equal(QUICK_DEFAULTS[k], v, k);
  // Continuazione su plateau: spenta finché il rollout non la accende.
  assert.equal(QUICK_DEFAULTS.plateauExtraPasses, 0);
  assert.deepEqual(VARIANTS.baseline, {});
});

// Sequenze reali della coorte PG (telemetria, piano §1 F2/F3), con il punto di
// partenza e lo stick migliore a fine sessione. `legacy` è dove si fermava la
// regola precedente, `now` dove si ferma oggi.
const REAL = [
  // runaway dopo il guard: il tetto ferma il ciclo alla prima passata ≥15%
  { passes: [100, 100], before: 3.551, other: FLOOR, legacy: [2, 'converged'], now: [1, 'catastrophic'] },
  { passes: [30.2, 46.67, 46.67, 40.39], before: 8.245, other: FLOOR, legacy: [4, 'budget'], now: [1, 'catastrophic'] },
  { passes: [12.16, 21.57, 30.2, 18.44], before: 8.245, other: FLOOR, legacy: [4, 'budget'], now: [2, 'catastrophic'] },
  { passes: [16.08, 17.65, 16.08, 16.08], before: 10.595, other: FLOOR, legacy: [4, 'converged'], now: [1, 'catastrophic'] },
  // "convergenti" peggiori dell'inizio: ora chiedono almeno una passata in più
  { passes: [2, 2], before: FLOOR, other: FLOOR, legacy: [2, 'converged'], now: [3, 'floor-cap'] },
  { passes: [1.24, 1.24], before: FLOOR, other: FLOOR, legacy: [2, 'converged'], now: [3, 'floor-cap'] },
  { passes: [3.55, 3.55], before: 2.287, other: FLOOR, legacy: [2, 'converged'], now: [3, 'floor-cap'] },
  { passes: [7.46, 7.46], before: 1.24, other: FLOOR, legacy: [2, 'converged'], now: [3, 'floor-cap'] },
  { passes: [5.11, 5.11], before: 2.987, other: FLOOR, legacy: [2, 'converged'], now: [3, 'floor-cap'] },
  { passes: [5.23, 5.11], before: 4.332, other: FLOOR, legacy: [2, 'converged'], now: [3, 'floor-cap'] },
  { passes: [4.33, 3.55, 3.55], before: 1.24, other: FLOOR, legacy: [3, 'converged'], now: [4, 'budget'] },
  { passes: [9.81, 9.03, 9.03], before: 7.21, other: FLOOR, legacy: [3, 'converged'], now: [4, 'budget'] },
  // l'altro stick non è al pavimento: nessun tetto alle passate di recupero
  { passes: [3.55, 3.55], before: 2.773, other: 1.24, legacy: [2, 'converged'], now: [4, 'budget'] },
  // plateau non peggiore dell'inizio: convergenza come prima
  { passes: [1.24, 1.24], before: 1.24, other: FLOOR, legacy: [2, 'converged'], now: [2, 'converged'] },
  { passes: [2, 2], before: 3.551, other: FLOOR, legacy: [2, 'converged'], now: [2, 'converged'] },
];

test('real sequences: catastrophic stops, and a plateau worse than the start is never convergence', () => {
  for (const { passes, before, other, legacy, now } of REAL) {
    const label = `${before} → ${JSON.stringify(passes)}`;
    assert.deepEqual(stopOf(passes, { params: LEGACY, beforeWorst: before, otherWorst: other }), legacy, `legacy ${label}`);
    assert.deepEqual(stopOf(passes, { beforeWorst: before, otherWorst: other }), now, `now ${label}`);
  }
});

test('[100,100] ends as catastrophic, not converged', () => {
  assert.deepEqual(stopOf([100, 100]), [1, 'catastrophic']);
  assert.deepEqual(stopOf([100, 100], { beforeWorst: 3.551 }), [1, 'catastrophic']);
  // Anche dopo passate buone: il tetto vale a ogni passata, prima della convergenza.
  assert.deepEqual(stopOf([3, 15, 15]), [2, 'catastrophic']);
  assert.deepEqual(stopOf([3, 14.9, 14.9]), [4, 'budget'], 'just below the ceiling the old recovery rule applies');
});

test('a plateau worse than the start is not convergence (bestWorst seeded with before)', () => {
  // before 0.555, poi [2, 2]: con la regola precedente "converged" con il
  // residuo peggiore dell'inizio.
  const r = replayDecisions([2, 2], QUICK_DEFAULTS, { beforeWorst: 0.555 });
  assert.notEqual(r.reason, 'converged');
  assert.equal(r.bestWorst, 0.555);
  assert.equal(r.added.recovery, 2);
  const d = decideAfterPass({ pass: 1, worst: 2, beforeWorst: 0.555, prevWorst: null, bestWorst: null, bestPass: null }, QUICK_DEFAULTS);
  assert.equal(d.bestWorst, 0.555);
  assert.equal(d.bestPass, 2);
  // Con `seedBestWithBefore: false` torna la regola precedente.
  assert.deepEqual(stopOf([2, 2], { params: LEGACY, beforeWorst: 0.555 }), [2, 'converged']);
  // Un plateau entro convergeEps dall'inizio resta convergenza: 1 LSB sopra non lo è.
  assert.deepEqual(stopOf([2, 2], { beforeWorst: 1.9 }), [2, 'converged']);
  assert.deepEqual(stopOf([2, 2], { beforeWorst: 1.664 }), [4, 'budget']);
});

test('with the other stick at the floor, at most one pass is added over the previous rule', () => {
  const r = replayDecisions([2, 2], QUICK_DEFAULTS, { beforeWorst: FLOOR, otherWorst: FLOOR });
  assert.deepEqual([r.stopAt, r.reason, r.extra, r.added.recovery], [3, 'floor-cap', 1, 1]);
  // Il budget resta 4: il recupero all'ultima passata è semplicemente la fine.
  assert.deepEqual(stopOf([5, 5, 4, 4], { beforeWorst: 3, otherWorst: 2 }), [4, 'budget']);
  // Se la passata extra migliora, il ciclo prosegue normalmente.
  assert.deepEqual(stopOf([2, 2, 1.24, 0.55], { beforeWorst: FLOOR, otherWorst: FLOOR }), [4, 'target']);
});

test('plateau continuation is off by default and capped at one pass while the other stick is at the floor', () => {
  const plateau = n => ({ ...QUICK_DEFAULTS, plateauExtraPasses: n });
  assert.deepEqual(stopOf([3.55, 3.55], { beforeWorst: 5, otherWorst: 2 }), [2, 'converged']);
  const one = replayDecisions([3.55, 3.55], plateau(1), { beforeWorst: 5, otherWorst: 2 });
  assert.deepEqual([one.stopAt, one.reason, one.added.plateau], [3, 'converged', 1]);
  const two = replayDecisions([3.55, 3.55], plateau(2), { beforeWorst: 5, otherWorst: 2 });
  assert.deepEqual([two.stopAt, two.reason, two.added.plateau], [4, 'converged', 2]);
  const capped = replayDecisions([3.55, 3.55], plateau(3), { beforeWorst: 5, otherWorst: FLOOR });
  assert.deepEqual([capped.stopAt, capped.reason, capped.added.plateau], [3, 'converged', 1]);
  // Mai oltre il budget di 4 passate.
  assert.deepEqual(stopOf([4, 3.55, 3.55, 3.55], { params: plateau(1), beforeWorst: 5, otherWorst: 2 }), [4, 'converged']);
  assert.deepEqual(VARIANTS.plateau1, { plateauExtraPasses: 1 });
  // Il plateau non ferma mai una sequenza ≥15%.
  assert.deepEqual(stopOf([20, 20], { params: plateau(1) }), [1, 'catastrophic']);
});

const facts = over => ({ worst: 2, beforeWorst: 3, bestWorst: 2, maxNoise: 0.2, unstableEvents: 0, passes: [2.5, 2], ...over });
const outcome = over => classifyOutcome(facts(over), QUICK_DEFAULTS);

test('classifyOutcome: catastrophic > worse-than-start > lost-ground > worn > residual-deterministic > within-1-step > centered', () => {
  assert.equal(outcome({ worst: null }), 'unverified');
  assert.equal(outcome({ worst: 100, beforeWorst: 3.551, bestWorst: 3.551, passes: [100, 100], maxNoise: 9 }), 'catastrophic');
  assert.equal(outcome({ worst: 15, beforeWorst: 20, bestWorst: 15 }), 'catastrophic', 'the ceiling applies even when the start was worse');
  assert.equal(outcome({ worst: 4, beforeWorst: 3, maxNoise: 2 }), 'worse-than-start');
  assert.equal(outcome({ worst: 3, beforeWorst: 3, bestWorst: 1.24, maxNoise: 2 }), 'lost-ground');
  assert.equal(outcome({ maxNoise: 1.6, passes: [2, 2] }), 'worn');
  assert.equal(outcome({ unstableEvents: 1, passes: [2, 2] }), 'unstable');
  assert.equal(outcome({ passes: [2, 2] }), 'residual-deterministic');
  assert.equal(outcome({ passes: [2.5, 2] }), 'residual');
  assert.equal(outcome({ worst: 1.24, passes: [1.66, 1.24] }), 'within-1-step');
  // Un 1.24 che si ripete resta "entro un passo, salvabile".
  assert.equal(outcome({ worst: 1.24, passes: [1.24, 1.24] }), 'within-1-step');
  assert.equal(outcome({ worst: 0.555, maxNoise: 9 }), 'centered');
  assert.equal(outcome({ worst: 3.7, beforeWorst: 3, bestWorst: 3.7, passes: [3.7] }), 'residual', 'a 0.7 pt change is below one lattice step');
  // Una passata non verificata in mezzo non conta come ripetizione.
  assert.equal(outcome({ passes: [2, null, 2] }), 'residual');
});

test('a worn stick that ended worse than the start is told it got worse', () => {
  assert.equal(outcome({ worst: 5, beforeWorst: 2, maxNoise: 2 }), 'worse-than-start');
  // Seme con il punto di partenza: il peggioramento rispetto all'inizio resta
  // "worse-than-start", non "lost-ground".
  assert.equal(outcome({ worst: 5, beforeWorst: 2, bestWorst: 2, maxNoise: 2 }), 'worse-than-start');
});

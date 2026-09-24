import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuick } from '../js/calib/quick.js';

// La regola di arresto dentro il vero runQuick (js/calib/quick.js), con attese
// e misure sceneggiate: conta i calibEnd (le passate irreversibili) e
// controlla l'esito e lo stato che il ciclo ripassa a decideAfterPass.
const stick = (offset, noise = 0.2) => ({ offset, noise });
const reading = ([l, r], noise) => ({ left: stick(l, noise), right: stick(r, noise) });

async function runScripted({ before, verifies, noise = 0.2, params = {} }) {
  let ends = 0;
  let verify = 0;
  const logs = [];
  const run = await runQuick({
    controller: {
      calibBegin: async () => {},
      calibSample: async () => {},
      calibEnd: async () => { ends++; },
    },
    sampler: {
      waitForStable: async () => true,
      measureOffset: async (ms, options) => options?.requireCentered
        ? reading(before, 0.2)
        : reading(verifies[Math.min(verify++, verifies.length - 1)], noise),
    },
    clock: { sleep: async () => {} },
    log: line => logs.push(line),
    params,
  });
  return { ...run, ends, logs };
}

test('a plateau worse than the start is not convergence: one more pass when the other stick is centered', async () => {
  const r = await runScripted({ before: [0.555, 0.555], verifies: [[2, 0.555]] });
  assert.equal(r.ends, 3);
  assert.deepEqual(r.session.passes, [2, 2, 2]);
  assert.equal(r.outcome, 'worse-than-start');
  assert.equal(r.bestWorst, 0.555, 'bestWorst is seeded with the starting point');
  assert.equal(r.session.best, 2, 'session.best stays the best verified pass');
  assert.ok(r.logs.some(l => /worse than the starting point: one more pass/.test(l)));
});

test('with neither stick at the floor, recovery uses the whole budget', async () => {
  const r = await runScripted({ before: [1.664, 1.24], verifies: [[3.55, 2]] });
  assert.equal(r.ends, 4);
  assert.equal(r.outcome, 'worse-than-start');
});

test('a verified pass at 15% or more stops the loop as catastrophic', async () => {
  const r = await runScripted({ before: [3.551, 0.555], verifies: [[100, 0.555], [0.555, 0.555]] });
  assert.equal(r.ends, 1);
  assert.deepEqual(r.session.passes, [100]);
  assert.equal(r.outcome, 'catastrophic');
});

test('a worn stick that got worse is told it got worse, not "hardware limit"', async () => {
  const r = await runScripted({ before: [2, 0.555], verifies: [[5, 0.555]], noise: 2 });
  assert.equal(r.outcome, 'worse-than-start');
});

test('an identical residual is reported at the end and does not stop the loop early', async () => {
  // Plateau vicino all'inizio (non peggiore): convergenza alla passata 2, come prima.
  const r = await runScripted({ before: [3.55, 2], verifies: [[3.55, 2]] });
  assert.equal(r.ends, 2);
  assert.equal(r.outcome, 'residual-deterministic');
  const oneStep = await runScripted({ before: [1.24, 0.555], verifies: [[1.24, 0.555]] });
  assert.equal(oneStep.outcome, 'within-1-step');
});

test('plateau continuation is off by default and reaches runQuick only through params', async () => {
  const off = await runScripted({ before: [5, 2], verifies: [[3.55, 2]] });
  assert.equal(off.ends, 2);
  const on = await runScripted({ before: [5, 2], verifies: [[3.55, 2]], params: { plateauExtraPasses: 1 } });
  assert.equal(on.ends, 3);
  assert.ok(on.logs.some(l => /plateau continuation/.test(l)));
  // Altro stick al pavimento: al massimo una passata in più anche con un budget maggiore.
  const capped = await runScripted({ before: [5, 0.555], verifies: [[3.55, 0.555]], params: { plateauExtraPasses: 3 } });
  assert.equal(capped.ends, 3);
});

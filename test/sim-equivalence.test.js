import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runVariant } from '../ops/sim/run.mjs';
import { goldenRecord } from '../ops/sim/equivalence.mjs';

// Prova che l'estrazione di runQuick in js/calib/ non ha cambiato il
// comportamento. I golden sono stati prodotti dall'harness PRE-refactor
// (ops/sim/legacy, app.js monolitico al commit 40a08ed) sulla popolazione
// sintetica, perché la telemetria reale non entra nel repo né in CI. La prova
// completa sui 1.785 template reali è `node ops/sim/equivalence.mjs`.
// Risultati "model-verified": codice reale contro un controller simulato.
for (const scenario of ['normal', 'hold']) {
  test(`runQuick reproduces the pre-refactor harness session by session (synthetic, ${scenario})`, async () => {
    const golden = JSON.parse(await readFile(new URL(`./fixtures/sim-golden-synthetic-${scenario}.json`, import.meta.url), 'utf8'));
    assert.equal(golden.generatedBy, 'legacy');
    const sessions = await runVariant({ n: golden.n, seed: golden.seed, scenario, population: 'synthetic', impl: 'module' });
    assert.equal(sessions.length, golden.sessions.length);
    for (let i = 0; i < sessions.length; i++) {
      assert.deepEqual(goldenRecord(sessions[i]), golden.sessions[i], `session ${i}`);
    }
  });
}

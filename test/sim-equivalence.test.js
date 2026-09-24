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
//
// La regola di arresto è cambiata dopo il refactor (seme di `bestWorst` con il
// punto di partenza, tetto fisico al 15%): la variante `legacyStop` la
// riporta a com'era, così il resto del ciclo resta confrontato sessione per
// sessione. L'esito mostrato è cambiato di proposito (precedenza e nuovi
// esiti in quick-policy.js): è ammesso solo uno dei cambi elencati qui, e
// ognuno deve essere coerente con i numeri della sessione.
const OUTCOME_CHANGES = {
  'residual>within-1-step': r => Math.max(...r.s.after.off) <= 1.25,
  'residual>residual-deterministic': r => r.s.passes.length >= 2 && r.s.passes.at(-1) === r.s.passes.at(-2),
  'worn>worse-than-start': r => Math.max(...r.s.after.off) - Math.max(...r.s.before.off) > 0.8,
};
for (const scenario of ['normal', 'hold']) {
  test(`runQuick reproduces the pre-refactor harness session by session (synthetic, ${scenario})`, async () => {
    const golden = JSON.parse(await readFile(new URL(`./fixtures/sim-golden-synthetic-${scenario}.json`, import.meta.url), 'utf8'));
    assert.equal(golden.generatedBy, 'legacy');
    const sessions = await runVariant({ n: golden.n, seed: golden.seed, scenario, population: 'synthetic', impl: 'module', variant: 'legacyStop' });
    assert.equal(sessions.length, golden.sessions.length);
    for (let i = 0; i < sessions.length; i++) {
      const got = goldenRecord(sessions[i]);
      const want = golden.sessions[i];
      assert.deepEqual({ ...got, outcome: null }, { ...want, outcome: null }, `session ${i}`);
      if (got.outcome !== want.outcome) {
        const check = OUTCOME_CHANGES[`${want.outcome}>${got.outcome}`];
        assert.ok(check, `session ${i}: unexpected outcome change ${want.outcome} → ${got.outcome}`);
        assert.ok(check(got), `session ${i}: ${want.outcome} → ${got.outcome} does not match the session`);
      }
    }
  });
}

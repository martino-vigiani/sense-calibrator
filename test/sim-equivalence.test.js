import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runVariant } from '../ops/sim/run.mjs';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';
import { QUICK_REGRESSION_EPS } from '../js/calib/quick.js';

// I golden sono stati prodotti dall'harness PRE-refactor (ops/sim/legacy,
// app.js monolitico al commit 40a08ed) sulla popolazione sintetica, perché la
// telemetria reale non entra nel repo né in CI. Hanno provato che l'estrazione
// di runQuick in js/calib/ (WS0) non cambiava il comportamento.
//
// WS1 (quick-safety) cambia il comportamento di proposito: niente comandi su
// una partenza già centrata, tenuta prima di ogni passata, campioni solo dopo
// una finestra stabile e vicina al riferimento in sessione, verifica stabile,
// tetto al 15%. Audit 09 richiede ora 300 ms interamente osservati per ogni
// tenuta, invece dei precedenti 240 ms. Questo sposta la fase del rumore
// sintetico perfino nelle sessioni prima dette "untouched": le mediane byte
// esatte del legacy non sono più una invariante. Restano i limiti di sicurezza.
// Risultati "model-verified": codice reale contro un controller simulato.
//
// Si esegue la configurazione di PRODUZIONE (variante `baseline`): gli
// invarianti di sicurezza valgono su quella, compreso il tetto al 15% che la
// variante `legacyStop` (seme di `bestWorst` e tetto della regola di arresto,
// WS2) disattiverebbe. Gli esiti possono cambiare anche per il confronto
// per stick di audit 11. I golden fissano popolazione, seed e partenza.

for (const scenario of ['normal', 'hold']) {
  test(`runQuick preserves safety invariants on the legacy synthetic population (${scenario})`, async () => {
    const golden = JSON.parse(await readFile(new URL(`./fixtures/sim-golden-synthetic-${scenario}.json`, import.meta.url), 'utf8'));
    assert.equal(golden.generatedBy, 'legacy');
    const sessions = await runVariant({ n: golden.n, seed: golden.seed, scenario, population: 'synthetic', impl: 'module', variant: 'baseline' });
    assert.equal(sessions.length, golden.sessions.length);
    for (let i = 0; i < sessions.length; i++) {
      const r = sessions[i];
      const g = golden.sessions[i];
      assert.equal(r.i, g.i, `session ${i}: same synthetic controller`);
      const { begin, sample, end } = r.counts;
      if (r.outcome === 'stalled') {
        // la passata abbandonata non viene mai chiusa con calibEnd
        assert.equal(end, begin - 1, `session ${i}: the stalled pass stays open`);
        assert.ok(sample - 12 * end < 12, `session ${i}`);
      } else {
        assert.equal(end, begin, `session ${i}`);
        assert.equal(sample, 12 * end, `session ${i}: every committed pass has exactly 12 samples`);
      }
      if (g.s.before && Math.max(...g.s.before.off) < 1.2) {
        assert.equal(r.outcome, 'already-centered', `session ${i}`);
        assert.equal(begin + sample + end, 0, `session ${i}: no command on an already-centered start`);
      }
      if (r.s.after && Math.max(...r.s.after.off) >= 15) assert.equal(r.outcome, 'catastrophic', `session ${i}`);
      if (r.s.before?.off && r.s.after?.off
        && r.s.after.off.some((after, j) => after - r.s.before.off[j] > QUICK_REGRESSION_EPS)
        && !['catastrophic', 'moved', 'stalled', 'error', 'unverified'].includes(r.outcome))
        assert.equal(r.outcome, 'worse-than-start', `session ${i}: a stick worsened`);
      if (r.s.gate !== undefined) {
        assert.ok(r.s.gate <= DRIFT_MOVE_SPREAD, `session ${i}: gate <= movement spread`);
        assert.ok(r.s.gateMax <= DRIFT_MOVE_SPREAD, `session ${i}: widest gate <= movement spread`);
      }
    }
  });
}

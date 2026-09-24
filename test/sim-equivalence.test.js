import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runVariant } from '../ops/sim/run.mjs';
import { goldenRecord } from '../ops/sim/equivalence.mjs';

// I golden sono stati prodotti dall'harness PRE-refactor (ops/sim/legacy,
// app.js monolitico al commit 40a08ed) sulla popolazione sintetica, perché la
// telemetria reale non entra nel repo né in CI. Hanno provato che l'estrazione
// di runQuick in js/calib/ (WS0) non cambiava il comportamento.
//
// WS1 (quick-safety) cambia il comportamento di proposito: niente comandi su
// una partenza già centrata, tenuta prima di ogni passata, campioni solo dopo
// una finestra stabile e vicina al riferimento in sessione, verifica stabile,
// tetto al 15%. Il confronto campo per campo resta quindi solo dove nessuna di
// queste regole può intervenire: una sola passata, partenza ≥ 1.2, nessun
// evento instabile, residuo sotto il tetto. Lì la sessione deve essere
// identica, perché la tenuta della passata 1 è la seconda tenuta di sempre e il
// primo campione fissa il riferimento senza attese aggiuntive. Su tutte le
// sessioni valgono gli invarianti di sicurezza.
// Risultati "model-verified": codice reale contro un controller simulato.
const untouchedByWs1 = g => g.s.passes.length === 1
  && Math.max(...g.s.before.off) >= 1.2
  && g.s.unstableEvents === 0
  && g.s.passes[0] < 15;

for (const scenario of ['normal', 'hold']) {
  test(`runQuick matches the pre-refactor harness where no WS1 rule applies and keeps the safety invariants elsewhere (synthetic, ${scenario})`, async () => {
    const golden = JSON.parse(await readFile(new URL(`./fixtures/sim-golden-synthetic-${scenario}.json`, import.meta.url), 'utf8'));
    assert.equal(golden.generatedBy, 'legacy');
    const sessions = await runVariant({ n: golden.n, seed: golden.seed, scenario, population: 'synthetic', impl: 'module' });
    assert.equal(sessions.length, golden.sessions.length);
    let compared = 0;
    for (let i = 0; i < sessions.length; i++) {
      const r = sessions[i];
      const g = golden.sessions[i];
      if (untouchedByWs1(g)) {
        compared++;
        assert.deepEqual(goldenRecord(r), g, `session ${i}`);
      }
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
    }
    if (scenario === 'normal') assert.ok(compared >= 15, `${compared} sessions compared field by field`);
  });
}

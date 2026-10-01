import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runVariant } from '../ops/sim/run.mjs';
import { compareGolden } from '../ops/sim/equivalence.mjs';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';
import { QUICK_REGRESSION_EPS } from '../js/calib/quick.js';

// Golden sintetici rigenerati dopo la tenuta completa di 300 ms e i fix del
// secondo audit. La fase dei campioni cambia anche nelle vecchie sessioni
// dette "untouched", quindi il legacy pre-refactor non può più essere un
// confronto campo per campo. Questo test ricontrolla OGNI campo del nuovo
// baseline (tranne passXY e verification, sola telemetria) e gli invarianti di sicurezza.
// Risultati model-verified, non una prova hardware.

for (const scenario of ['normal', 'hold']) {
  test(`runQuick matches its reviewed synthetic golden field by field (${scenario})`, async () => {
    const golden = JSON.parse(await readFile(new URL(`./fixtures/sim-golden-synthetic-${scenario}.json`, import.meta.url), 'utf8'));
    assert.equal(golden.generatedBy, 'module');
    const sessions = await runVariant({ n: golden.n, seed: golden.seed, scenario, population: 'synthetic', impl: 'module', variant: 'baseline' });
    assert.deepEqual(compareGolden(golden, sessions), {
      compared: golden.n, changedSessions: 0, changedFields: 0, outcomeChanges: 0, examples: [],
    });
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
        && Math.max(...r.s.after.off) - Math.max(...r.s.before.off) > QUICK_REGRESSION_EPS
        && !['catastrophic', 'moved', 'stalled', 'error', 'unverified'].includes(r.outcome))
        assert.equal(r.outcome, 'worse-than-start', `session ${i}: the worst stick worsened`);
      if (r.s.gate !== undefined) {
        assert.ok(r.s.gate <= DRIFT_MOVE_SPREAD, `session ${i}: gate <= movement spread`);
        assert.ok(r.s.gateMax <= DRIFT_MOVE_SPREAD, `session ${i}: widest gate <= movement spread`);
      }
    }
  });
}

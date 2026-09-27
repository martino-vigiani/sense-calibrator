// Report degli eventi v2 su una popolazione sintetica: il join calibrazione →
// save, i motivi del mancato salvataggio, i riassunti di rumore, lo scarto
// delle righe fuori contratto e l'assenza di identificativi in uscita.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildEventsReport, saveReason, formatEventsSummary } from '../events-report.mjs';
import { parseArgs, runCli } from '../events-report-cli.mjs';

const FIXTURES = JSON.parse(fs.readFileSync(new URL('../contract/events-v2.fixtures.json', import.meta.url), 'utf8'));
const base = type => structuredClone(FIXTURES.valid.find(f => f.event.type === type).event);

const quick = (sid, seq, extra = {}) => {
  const e = { ...base('quick'), sid, seq, ...extra };
  if (!Object.hasOwn(extra, 'beforeAxes')) e.beforeAxes = null;
  if (!Object.hasOwn(extra, 'afterAxes')) e.afterAxes = null;
  if (!Object.hasOwn(extra, 'passAxes')) e.passAxes = e.passes.map(() => null);
  return e;
};
const guided = (sid, seq, extra = {}) => ({ ...base('guided'), sid, seq, ...extra });
const save = (sid, seq, extra = {}) => ({ ...base('save'), sid, seq, ...extra });
const flash = (sid, seq, extra = {}) => ({ ...base('flash'), sid, seq, ...extra });
const rest = (sid, seq, p95, extra = {}) => {
  const e = { ...base('rest'), sid, seq, ...extra };
  e.sticks = e.sticks.map(s => ({ ...s, p95, max: p95 + 1 }));
  return e;
};
const line = (event, day = '2026-09-28') => JSON.stringify({ ...event, receivedDay: day });

function population() {
  const lines = [
    // A: salvata
    quick('aaaaaaaa', 0), flash('aaaaaaaa', 1), save('aaaaaaaa', 2, { ref: 0 }),
    // B: pagina chiusa con Write spento (catastrofico)
    quick('bbbbbbbb', 0, { outcome: 'catastrophic' }),
    save('bbbbbbbb', 1, { result: 'left', ref: 0, lock: 'disabled', reasons: ['catastrophic'], attempts: 0, lastFlash: null, opens: 0 }),
    // C: nessun evento save (keepalive perso): esito ignoto
    quick('cccccccc', 0),
    // D: rifatta prima di salvare: la prima è sostituita, la seconda salvata
    quick('dddddddd', 0), quick('dddddddd', 1), save('dddddddd', 2, { ref: 1, sessions: 2 }),
    // E: Cancel e poi scollegato
    quick('eeeeeeee', 0), save('eeeeeeee', 1, { result: 'disconnected', ref: 0, cancels: 1, attempts: 0, lastFlash: null }),
    // F: flash fallito, poi pagina chiusa
    quick('ffffffff', 0), flash('ffffffff', 1, { result: 'nv-unknown', nv: null }),
    save('ffffffff', 2, { result: 'left', ref: 0, attempts: 1, lastFlash: 'nv-unknown' }),
    // H: scollegato a metà Quick: il save 'disconnected' arriva PRIMA dell'evento
    // quick (teardown), poi un'altra calibrazione salvata nella stessa visita
    quick('77777777', 0), save('77777777', 1, { result: 'disconnected', ref: 0, attempts: 0, lastFlash: null }),
    quick('77777777', 2, { outcome: 'disconnected' }),
    quick('77777777', 3), save('77777777', 4, { ref: 3 }),
    // G: un preflight (nessun commit) e sei finestre di rumore
    quick('99999999', 0, { outcome: 'preflight', committed: false, before: null, after: null, passes: [] }),
    ...[0.5, 0.5, 1, 1, 2, 4].map((p95, i) => rest('99999999', i + 1, p95)),
  ].map(e => line(e));
  lines.push('not json', JSON.stringify({ ...quick('12345678', 0), serial: 'E1' }), line({ ...quick('12345678', 1) }, '2026-09-01'));
  lines.push(JSON.stringify(quick('abcdef01', 0))); // senza receivedDay
  return `${lines.join('\n')}\n`;
}

test('every committed calibration is joined to the save event that closes its period', () => {
  const r = buildEventsReport(population(), { minimumCohortSize: 1 });
  assert.deepEqual(r.saving.byType.quick.reasons, {
    'cancelled': 1, 'disconnected': 2, 'flash-failed': 1, 'locked:catastrophic': 1, 'saved': 3, 'unknown': 2,
  }, 'C and the old line with no save event are unknown; H is disconnected twice, then saved');
  assert.equal(r.saving.byType.quick.n, 10);
  assert.equal(r.saving.byType.quick.saveRate, 0.3);
  assert.equal(r.saving.byTypeOutcome['quick:disconnected'].reasons.disconnected, 1);
  assert.equal(r.saving.byType['quick:superseded'], 1);
  assert.equal(r.calibrations.notCommitted['quick:preflight'], 1);
  assert.equal(r.saving.byTypeOutcome['quick:catastrophic'].reasons['locked:catastrophic'], 1);
  assert.deepEqual(r.saving.periods.byResult, { disconnected: 2, left: 2, saved: 3 });
  assert.equal(r.flash.byResult['nv-unknown'], 1);
});

test('rates and distributions are withheld below the minimum cohort, counts are not', () => {
  const r = buildEventsReport(population(), { minimumCohortSize: 11 });
  assert.equal(r.saving.byType.quick.saveRate, null);
  assert.equal(r.saving.byType.quick.n, 10);
  assert.deepEqual(r.restNoise.all, { n: 6, suppressed: true }, 'six windows, under the cohort of 11');
});

test('rest noise: quantiles and histograms per stick', () => {
  const r = buildEventsReport(population(), { minimumCohortSize: 5 });
  const right = r.restNoise.all.right;
  assert.deepEqual(right.p95Lsb, { n: 6, p10: 0.5, p50: 1, p90: 4, max: 4 });
  assert.equal(right.p95Histogram.reduce((a, b) => a + b.n, 0), 6);
  assert.equal(right.p95Histogram.find(b => b.lt === 1).n, 2);
  assert.ok(r.restNoise.byBoard['BDM-030'].n === 6);
});

test('signed final residuals retain half-step sign and axis, grouped by board', () => {
  const events = [
    quick('11111111', 0, { board: 'BDM-030', afterAxes: [[3, -1], [2, 0]] }),
    quick('22222222', 0, { board: 'BDM-030', afterAxes: [[-3, 1], [0, 0]] }),
    guided('33333333', 0, { board: 'BDM-020', afterAxes: [[-1, 2], [0, -2]] }),
    quick('44444444', 0, { board: 'BDM-020', afterAxes: null }),
  ];
  const r = buildEventsReport(events.map(e => line(e)).join('\n'), { minimumCohortSize: 1 });
  assert.equal(r.input.invalidEvent, 0);
  assert.equal(r.residualAxes.final.byBoard['BDM-030'].withMeasurement, 2);
  assert.deepEqual(r.residualAxes.final.byBoard['BDM-030'].byAxis.lx.distribution, [
    { halfLsb: -3, n: 1 }, { halfLsb: 3, n: 1 },
  ]);
  assert.deepEqual(r.residualAxes.final.byBoard['BDM-030'].byAxis.ly.distribution, [
    { halfLsb: -1, n: 1 }, { halfLsb: 1, n: 1 },
  ]);
  assert.deepEqual(r.residualAxes.final.byBoard['BDM-020'].byAxis.ry.distribution, [{ halfLsb: -2, n: 1 }]);
  assert.equal(r.residualAxes.final.byBoard['BDM-020'].events, 2);
  assert.equal(r.residualAxes.final.byBoard['BDM-020'].withMeasurement, 1);
});

test('Quick repeat counts use adjacent verified pairs and exact nonzero signed axes', () => {
  const events = [
    quick('11111111', 0, {
      board: 'BDM-030', passes: [2, 2, 2],
      passAxes: [[[3, -1], [0, 0]], [[3, -1], [2, 0]], [[3, 1], [2, 0]]],
    }),
    // Una verifica mancante interrompe la sequenza: passata 1 e 3 non sono adiacenti.
    quick('22222222', 0, {
      board: 'BDM-030', passes: [2, null, 2],
      passAxes: [[[3, 1], [0, 0]], null, [[3, 1], [0, 0]]],
    }),
    quick('33333333', 0, {
      board: 'BDM-020', passes: [2, 2],
      passAxes: [[[0, 0], [0, 0]], [[0, 0], [0, 0]]],
    }),
    quick('44444444', 0, {
      board: 'BDM-030', passes: [2, 2],
      passAxes: [[[1, 0], [1, 0]], [[-1, 0], [1, 0]]],
    }),
    quick('55555555', 0, {
      board: 'BDM-020', passes: [2, 2],
      passAxes: [[[1, 0], [0, 0]], [[-1, 0], [0, 0]]],
    }),
  ];
  const r = buildEventsReport(events.map(e => line(e)).join('\n'), { minimumCohortSize: 1 });
  assert.equal(r.input.invalidEvent, 0);
  const repeats = r.residualAxes.quickPassRepeats.all;
  assert.deepEqual(repeats.runs, { comparable: 4, eligible: 3, withExactRepeat: 2, rateAmongEligible: 0.667 });
  assert.deepEqual(repeats.adjacentPairs, { comparable: 5, withBothNonzero: 4, withExactRepeat: 3, rateAmongBothNonzero: 0.75 });
  assert.deepEqual(repeats.byAxis.lx, { comparablePairs: 5, bothNonzeroPairs: 4, exactRepeats: 2, rateAmongBothNonzero: 0.5 });
  assert.deepEqual(repeats.byAxis.ly, { comparablePairs: 5, bothNonzeroPairs: 2, exactRepeats: 1, rateAmongBothNonzero: 0.5 });
  assert.deepEqual(repeats.byAxis.ry, { comparablePairs: 5, bothNonzeroPairs: 0, exactRepeats: 0, rateAmongBothNonzero: null });
  assert.equal(repeats.byAxis.rx.exactRepeats, 2);
  assert.equal(r.residualAxes.quickPassRepeats.byBoard['BDM-020'].runs.withExactRepeat, 0);
});

test('old v2 events without any axis fields are validated after null migration; partial new rows are rejected', () => {
  const oldQuick = quick('11111111', 0);
  delete oldQuick.beforeAxes;
  delete oldQuick.afterAxes;
  delete oldQuick.passAxes;
  const oldGuided = guided('22222222', 0);
  delete oldGuided.beforeAxes;
  delete oldGuided.afterAxes;
  const partial = quick('33333333', 0);
  delete partial.passAxes;
  const malformed = { ...oldQuick, sid: '44444444', serial: 'must-be-rejected' };
  const r = buildEventsReport([oldQuick, oldGuided, partial, malformed].map(e => line(e)).join('\n'), { minimumCohortSize: 1 });
  assert.equal(r.input.accepted, 2);
  assert.equal(r.input.legacyAxes, 2);
  assert.equal(r.input.invalidEvent, 2);
  assert.equal(r.residualAxes.final.all.withMeasurement, 0);
  assert.equal(r.residualAxes.quickPassRepeats.all.eligibleRuns, 0);
});

test('axis distributions and repeat rates are suppressed below the cohort size', () => {
  const r = buildEventsReport(line(quick('11111111', 0, {
    afterAxes: [[1, -1], [0, 0]], passes: [2, 2],
    passAxes: [[[1, -1], [0, 0]], [[1, -1], [0, 0]]],
  })), { minimumCohortSize: 2 });
  assert.deepEqual(r.residualAxes.final.all, { events: 1, withMeasurement: 1, suppressed: true });
  assert.deepEqual(r.residualAxes.quickPassRepeats.all, { quickRuns: 1, eligibleRuns: 1, suppressed: true });
});

test('lines outside the contract are counted and dropped, never read', () => {
  const r = buildEventsReport(population(), { since: '2026-09-10' });
  assert.equal(r.input.invalidJson, 1);
  assert.equal(r.input.invalidEvent, 2, 'an extra field and a missing receivedDay');
  assert.equal(r.input.beforeCutoff, 1);
});

test('the report holds aggregates only: no sid, no single event', () => {
  const text = JSON.stringify(buildEventsReport(population(), { minimumCohortSize: 1 }));
  for (const sid of ['aaaaaaaa', 'bbbbbbbb', '99999999', '12345678']) assert.ok(!text.includes(sid), sid);
  assert.doesNotMatch(text, /"seq"|"sid"|receivedDay/);
});

test('saveReason precedence: flash failure, then lock, then cancel, then how it ended', () => {
  assert.equal(saveReason(undefined), 'unknown');
  const s = base('save');
  assert.equal(saveReason({ ...s, result: 'left', attempts: 2, lastFlash: 'lock-failed', lock: 'disabled', cancels: 1 }), 'flash-failed');
  assert.equal(saveReason({ ...s, result: 'left', attempts: 0, lock: 'disabled', reasons: ['pinned', 'range-incomplete'], cancels: 1 }), 'locked:pinned+range-incomplete');
  assert.equal(saveReason({ ...s, result: 'left', attempts: 0, lock: 'guarded', cancels: 2 }), 'cancelled');
  assert.equal(saveReason({ ...s, result: 'disconnected', attempts: 0, lock: 'allowed', cancels: 0 }), 'disconnected');
});

test('the CLI writes the report atomically with mode 0600 and prints a summary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-report-'));
  const input = path.join(dir, 'events-v2.jsonl');
  const output = path.join(dir, 'out', 'events-latest.json');
  fs.writeFileSync(input, population());
  assert.throws(() => parseArgs(['--since', '2026/09/01']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  await runCli(['--input', input, '--output', output]);
  const written = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(written.schema, 'sense-calibrator.telemetry-events.v2');
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  await assert.rejects(runCli(['--input', input, '--output', input]), /must not/);
  assert.match(formatEventsSummary(written), /^events \d+ \(invalid \d+\) · visits \d+ · quick saved 3\/10/);
  fs.rmSync(dir, { recursive: true, force: true });
});

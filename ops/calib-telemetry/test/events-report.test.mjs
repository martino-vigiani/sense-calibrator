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

const quick = (sid, seq, extra = {}) => ({ ...base('quick'), sid, seq, ...extra });
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
    'cancelled': 1, 'flash-failed': 1, 'locked:catastrophic': 1, 'saved': 2, 'unknown': 2,
  }, 'C and the old line with no save event are unknown');
  assert.equal(r.saving.byType.quick.n, 7);
  assert.equal(r.saving.byType.quick.saveRate, 0.286);
  assert.equal(r.saving.byType['quick:superseded'], 1);
  assert.equal(r.calibrations.notCommitted['quick:preflight'], 1);
  assert.equal(r.saving.byTypeOutcome['quick:catastrophic'].reasons['locked:catastrophic'], 1);
  assert.deepEqual(r.saving.periods.byResult, { disconnected: 1, left: 2, saved: 2 });
  assert.equal(r.flash.byResult['nv-unknown'], 1);
});

test('rates and distributions are withheld below the minimum cohort, counts are not', () => {
  const r = buildEventsReport(population(), { minimumCohortSize: 8 });
  assert.equal(r.saving.byType.quick.saveRate, null);
  assert.equal(r.saving.byType.quick.n, 7);
  assert.deepEqual(r.restNoise.all, { n: 6, suppressed: true });
});

test('rest noise: quantiles and histograms per stick', () => {
  const r = buildEventsReport(population(), { minimumCohortSize: 5 });
  const right = r.restNoise.all.right;
  assert.deepEqual(right.p95Lsb, { n: 6, p10: 0.5, p50: 1, p90: 4, max: 4 });
  assert.equal(right.p95Histogram.reduce((a, b) => a + b.n, 0), 6);
  assert.equal(right.p95Histogram.find(b => b.lt === 1).n, 2);
  assert.ok(r.restNoise.byBoard['BDM-030'].n === 6);
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
  assert.match(formatEventsSummary(written), /^events \d+ \(invalid \d+\) · visits \d+ · quick saved 2\/7/);
  fs.rmSync(dir, { recursive: true, force: true });
});

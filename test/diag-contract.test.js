// Contratto del report diagnostico (POST /api/calib/v2/diagnostics), lato
// client, e il registratore puro (js/diag/recorder.js) con le sue viste.
//
// Lo schema JSON in ops/calib-telemetry/contract/diagnostics-v1.schema.json è
// l'unica fonte: server/calib-telemetry/contract/ ne tiene una copia identica,
// con le stesse fixture, e calib-diagnostics.test.js fissa le stesse impronte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import {
  DIAGNOSTICS_ENDPOINT, DIAG_LIMITS, createDiagRecorder, diagnosticsBytes, diagnosticsContents,
  uploadDiagnostics, validateDiagnostics,
} from '../js/diag/recorder.js';
import { DIAGNOSTICS_V1_SCHEMA } from '../js/diag/diagnostics-schema.js';
import { clockOf, diagChartLabel, diagChartSvg, landingRowsHtml, landingSummaryText, sendSummaryText } from '../js/diag/view.js';
import { EVENTS_V2_ENDPOINT, TELEMETRY_APP_BUILD } from '../js/telemetry-v2.js';
import { DIAGNOSTICS_MODULE, renderSchemaModule } from '../ops/calib-telemetry/contract/sync-schema.mjs';

const CONTRACT = new URL('../ops/calib-telemetry/contract/', import.meta.url);
const SERVER_CONTRACT = new URL('../server/calib-telemetry/contract/', import.meta.url);
const SCHEMA_TEXT = fs.readFileSync(new URL('diagnostics-v1.schema.json', CONTRACT), 'utf8');
const FIXTURES_TEXT = fs.readFileSync(new URL('diagnostics-v1.fixtures.json', CONTRACT), 'utf8');
const FIXTURES = JSON.parse(FIXTURES_TEXT);
const V2_FIXTURES = JSON.parse(fs.readFileSync(new URL('events-v2.fixtures.json', CONTRACT), 'utf8'));
const sha256 = text => createHash('sha256').update(text).digest('hex');

// Stessi valori in server/calib-telemetry/calib-diagnostics.test.js.
const CONTRACT_SHA256 = {
  schema: '0f829930cddb647ae4d16ae37670232d68f8551ed5fce9a51f664274ac01c9e5',
  fixtures: 'cb5776792363f132a7c0752d4403415d3c3349df819d32b82d291427b2d7caea',
};

const LSB = 1 / 127.5;
const REST = { lx: 0, ly: 0, rx: 0, ry: 0 };

test('contract: pinned hashes, byte-identical server copy, generated JS module in sync', () => {
  assert.equal(sha256(SCHEMA_TEXT), CONTRACT_SHA256.schema, 'schema changed: copy it to the server and update both pins');
  assert.equal(sha256(FIXTURES_TEXT), CONTRACT_SHA256.fixtures, 'fixtures changed: copy them to the server and update both pins');
  for (const name of ['diagnostics-v1.schema.json', 'diagnostics-v1.fixtures.json']) {
    assert.equal(fs.readFileSync(new URL(name, SERVER_CONTRACT), 'utf8'), fs.readFileSync(new URL(name, CONTRACT), 'utf8'), name);
  }
  const generated = fs.readFileSync(new URL('../js/diag/diagnostics-schema.js', import.meta.url), 'utf8');
  assert.equal(generated, renderSchemaModule(SCHEMA_TEXT, DIAGNOSTICS_MODULE), 'run node ops/calib-telemetry/contract/sync-schema.mjs');
  assert.deepEqual(DIAGNOSTICS_V1_SCHEMA, JSON.parse(SCHEMA_TEXT));
});

test('contract: every valid fixture passes and every invalid one is rejected by the browser validator', () => {
  assert.ok(FIXTURES.valid.length >= 3 && FIXTURES.invalid.length >= 20);
  for (const { name, report } of FIXTURES.valid) assert.equal(validateDiagnostics(report), null, name);
  for (const { name, report } of FIXTURES.invalid) assert.notEqual(validateDiagnostics(report), null, name);
});

test('the endpoint sits next to the v2 events endpoint', () => {
  assert.equal(EVENTS_V2_ENDPOINT, 'https://subralabs.com/api/calib/v2/events');
  assert.equal(DIAGNOSTICS_ENDPOINT, 'https://subralabs.com/api/calib/v2/diagnostics');
});

// ------------------------------------------------------------------ registratore

function feedRest(r, t0, t1, at = () => REST) {
  for (let t = t0; t < t1; t += 4) r.push(at(t), t);
}

test('recorder: times are relative to the start, the trace has one row per second', () => {
  const r = createDiagRecorder();
  r.start(50_000);
  feedRest(r, 50_000, 54_100, () => ({ ...REST, lx: 2 * LSB, ry: -3 * LSB }));
  r.note(51_234.4, 'unsaved', { on: true });
  r.stop(54_100);
  const rep = r.report(60_000);
  assert.equal(validateDiagnostics(rep), null);
  assert.equal(rep.app, TELEMETRY_APP_BUILD);
  assert.equal(rep.durMs, 4100);
  assert.deepEqual(rep.events, [{ t: 1234, type: 'unsaved', on: true }]);
  assert.deepEqual(rep.trace.map(row => row.t), [0, 1000, 2000, 3000, 4000]);
  assert.deepEqual(rep.trace[1].l, [2, 0, 0]);
  assert.deepEqual(rep.trace[1].r, [0, -3, 0]);
  assert.equal(rep.trace[1].n, 250);
});

test('recorder: builders keep only contract fields; anything else is dropped, never passed', () => {
  const r = createDiagRecorder();
  r.start(0);
  assert.deepEqual(r.note(1, 'connect', { board: 'BDM-030', fw: 7, serial: 'E12345', color: 'Red', buildDate: 'Jun 24 2021' }),
    { t: 1, type: 'connect', board: 'BDM-030', fw: 7 });
  assert.deepEqual(r.note(2, 'connect', { board: 'My pad', fw: -1 }), { t: 2, type: 'connect', board: null, fw: null });
  assert.equal(r.note(3, 'note', { text: 'hello' }), null, 'unknown type');
  assert.equal(r.note(4, 'start', { op: 'something' }), null);
  assert.equal(r.note(5, 'power-cycle', { lock: 'maybe' }), null);
  const bad = { ...V2_FIXTURES.valid[0].event, serial: 'E1' };
  assert.equal(r.note(6, 'calib', { event: bad }), null, 'a v2 event outside its contract never enters');
  assert.equal(r.note(7, 'drift', { res: { off: [1, 2] } }), null, 'incomplete drift result');
  assert.deepEqual(r.note(8, 'drift', { auto: true, res: { off: [1.234, 0.5], noise: [0.3, 0.4], xy: [[1.234, 0], [0, -0.5]] }, unstable: false }),
    { t: 8, type: 'drift', auto: true, off: [1.23, 0.5], noise: [0.3, 0.4], axes: [[1.6, 0], [0, -0.6]], unstable: false });
  const rep = r.report(10);
  assert.equal(validateDiagnostics(rep), null);
  assert.equal(rep.events.length, 3);
  assert.ok(!JSON.stringify(rep).includes('E12345'));
});

test('recorder: a stopped or never started recorder records nothing', () => {
  const r = createDiagRecorder();
  assert.equal(r.note(0, 'disconnect'), null);
  assert.deepEqual(r.push(REST, 0), { landings: [], row: null, stopped: false });
  r.start(0);
  r.stop(1000);
  assert.equal(r.note(2000, 'disconnect'), null);
  feedRest(r, 2000, 5000);
  assert.equal(r.report(5000).trace.length, 0);
  assert.equal(r.report(5000).durMs, 1000);
});

test('recorder: stops itself at 30 minutes, from a report or from the page timer', () => {
  const r = createDiagRecorder();
  r.start(0);
  feedRest(r, 0, 2000);
  assert.equal(r.push(REST, 30 * 60_000 - 1).stopped, false);
  assert.equal(r.push(REST, 30 * 60_000).stopped, true);
  assert.equal(r.active, false);
  assert.equal(r.report(40 * 60_000).stop, 'time-limit');
  assert.equal(r.report(40 * 60_000).durMs, 30 * 60_000);
  const t = createDiagRecorder();
  t.start(100);
  assert.equal(t.tick(100 + 30 * 60_000 - 1), false);
  assert.equal(t.tick(100 + 30 * 60_000 + 5000), true);
  assert.equal(t.report(0).durMs, 30 * 60_000);
});

test('recorder: caps are counted in dropped, and the report stays valid', () => {
  const r = createDiagRecorder({ limits: { maxEvents: 3, maxLandings: 1, maxTrace: 2 } });
  r.start(0);
  for (let i = 0; i < 5; i++) r.note(i, 'disconnect');
  // Due flick: il secondo rilascio supera il tetto.
  const flick = at => t => (t >= at && t < at + 200 ? { ...REST, lx: 0.9 } : REST);
  feedRest(r, 0, 2000, flick(800));
  feedRest(r, 2000, 4000, flick(2800));
  const rep = r.report(4000);
  assert.equal(validateDiagnostics(rep), null);
  assert.equal(rep.events.length, 3);
  assert.equal(rep.landings.length, 1);
  assert.equal(rep.trace.length, 2);
  assert.deepEqual(rep.dropped, { events: 2, landings: 1, trace: 1 });
});

test('recorder: a gap (disconnect) forgets a release in flight', () => {
  const r = createDiagRecorder();
  r.start(0);
  feedRest(r, 0, 1000);
  feedRest(r, 1000, 1100, () => ({ ...REST, lx: 0.9 }));
  r.gap();
  feedRest(r, 1100, 3000);
  assert.equal(r.landings.length, 0);
});

test('recorder: the largest report it can build stays under the 512 KB server limit', () => {
  const quick = V2_FIXTURES.valid.filter(f => f.event.type === 'quick').map(f => f.event)
    .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
  const r = createDiagRecorder();
  r.start(0);
  for (let i = 0; i < DIAG_LIMITS.maxEvents + 10; i++) r.note(1_799_000, 'calib', { event: quick });
  const rep = r.report(DIAG_LIMITS.maxMs);
  assert.ok(rep.dropped.events > 0, 'the byte budget is what stops the events');
  const landing = { t: 1_799_999, stick: 'right', peak: 141.4, landAxes: [-127.4, -127.4], landPct: 141.29, settleMs: 59_999 };
  rep.landings = Array.from({ length: DIAG_LIMITS.maxLandings }, () => ({ ...landing }));
  rep.trace = Array.from({ length: DIAG_LIMITS.maxTrace }, (_, i) => ({ t: Math.min(1_859_000, i * 1000), n: 1999, l: [-127.4, -127.4, 254.9], r: [-127.4, -127.4, 254.9] }));
  rep.dropped = { events: 99_999, landings: 99_999, trace: 99_999 };
  assert.equal(validateDiagnostics(rep), null);
  const bytes = diagnosticsBytes(rep);
  assert.ok(bytes < DIAG_LIMITS.maxBytes, `${bytes} bytes`);
});

test('recorder: a typical 30-minute recording is well under the limit', () => {
  // Uno stick a riposo con rumore, un flick ogni 20 s per 30 minuti.
  const r = createDiagRecorder();
  r.start(0);
  let s = 7;
  const noise = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 2 ** 32 - 0.5) * 2 * LSB; };
  for (let t = 0; t < DIAG_LIMITS.maxMs; t += 4) {
    const phase = t % 20_000;
    const lx = phase >= 10_000 && phase < 10_200 ? 0.9 : 3 * LSB + noise();
    r.push({ lx, ly: noise(), rx: noise(), ry: -2 * LSB + noise() }, t);
  }
  for (let i = 0; i < 20; i++) r.note(i * 60_000, 'calib', { event: V2_FIXTURES.valid[i % V2_FIXTURES.valid.length].event });
  r.stop(DIAG_LIMITS.maxMs);
  const rep = r.report(DIAG_LIMITS.maxMs);
  assert.equal(validateDiagnostics(rep), null);
  assert.equal(rep.landings.length, 90);
  assert.equal(rep.trace.length, 1800);
  const info = diagnosticsContents(rep);
  assert.ok(info.bytes > 60_000 && info.bytes < 160_000, `${info.bytes} bytes`);
  assert.equal(info.minutes, 30);
});

// ------------------------------------------------------------------ invio

const okFetch = (calls, code = 'SC-ABCDEFG2') => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201, json: async () => ({ code }) }; };

test('upload: posts the validated JSON once and returns the server code', async () => {
  const calls = [];
  const report = FIXTURES.valid[0].report;
  assert.equal(await uploadDiagnostics(report, { fetchImpl: okFetch(calls) }), 'SC-ABCDEFG2');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DIAGNOSTICS_ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), report);
  assert.equal(calls[0].init.keepalive, undefined, 'not a background beacon: the page waits for the code');
});

test('upload: an invalid report never calls fetch; errors and odd replies throw', async () => {
  const calls = [];
  await assert.rejects(uploadDiagnostics({ ...FIXTURES.valid[0].report, serial: 'E1' }, { fetchImpl: okFetch(calls) }), e => e.reason === 'invalid');
  assert.equal(calls.length, 0);
  await assert.rejects(uploadDiagnostics(FIXTURES.valid[0].report, { fetchImpl: async () => ({ ok: false, status: 429 }) }), e => e.status === 429);
  await assert.rejects(uploadDiagnostics(FIXTURES.valid[0].report, { fetchImpl: okFetch([], '<script>') }), e => e.reason === 'reply');
});

// ------------------------------------------------------------------ viste

test('views: chart uses only token classes, no colors; label and rows are plain text', () => {
  const rep = FIXTURES.valid[0].report;
  const svg = diagChartSvg(rep, { width: 400, height: 180 });
  assert.match(svg, /^<svg width="400" height="180" viewBox="0 0 400 180" aria-hidden="true"/);
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b|rgb\(|fill="(?!none)|stroke="/i, 'no inline colors');
  assert.match(svg, />Q</, 'Quick marker');
  assert.match(svg, />W</, 'Write marker');
  assert.match(svg, /class="diag-dot diag-left"/);
  assert.match(diagChartLabel(rep), /^Resting offset over time, 0:0\d recorded\. Now: left [\d.]+%, right [\d.]+%\. 1 release marked\.$/);
  assert.equal(diagChartLabel({ trace: [], landings: [] }), 'Resting offset over time: no data yet.');
  assert.match(landingRowsHtml(rep.landings), /^<tr><td>0:0\d<\/td><td>Left<\/td><td>x [+−]\d+\.\d · y [+−]?\d+\.\d<\/td><td>[^<]+<\/td><td>\d+%<\/td><td>\d+ ms<\/td><\/tr>$/);
  assert.equal(clockOf(61_999), '1:01');
  assert.match(landingSummaryText(rep.summary), /^Left: 1 release, typical stop [\d.]+% from center, stops vary by 0\.0 LSB \(95% within 0\.0\)\. Right: no releases yet\.$/);
  assert.equal(sendSummaryText({ bytes: 150_000, seconds: 1800, minutes: 30, events: 1, landings: 2, trace: 1800 }),
    'About 146 KB: 30 minutes of recording, 1 event, 2 releases and 1800 one-second resting positions.');
  assert.equal(sendSummaryText({ bytes: 900, seconds: 2, minutes: 1, events: 2, landings: 0, trace: 2 }),
    'About 1 KB: 2 seconds of recording, 2 events, 0 releases and 2 one-second resting positions.');
});

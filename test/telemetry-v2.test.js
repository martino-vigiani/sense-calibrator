// Contratto della telemetria v2 (POST /api/calib/v2/events), lato client.
//
// Lo schema JSON in ops/calib-telemetry/contract/ è l'unica fonte: il servizio
// (subralabs-v2/code/calib-telemetry/contract/) ne tiene una copia identica
// byte per byte, con le stesse fixture, e il suo test fa gli stessi controlli
// col proprio validatore. L'impronta SHA-256 qui sotto è la stessa scritta nel
// test del server: cambiare lo schema da una parte sola fa fallire l'altra.
// Con CALIB_CONTRACT_PEER=<cartella contract del server> il test confronta
// anche i file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

import {
  EVENTS_V2_ENDPOINT, TELEMETRY_APP_BUILD, TELEMETRY_SCOPE,
  buildFlashEvent, buildGuidedEvent, buildQuickEvent, buildRangeEvent, buildRestEvent, buildSaveEvent,
  flashResultFor, uploadEventV2, validateEventV2,
} from '../js/telemetry-v2.js';
import { EVENTS_V2_SCHEMA } from '../js/telemetry-v2-schema.js';
import { renderSchemaModule } from '../ops/calib-telemetry/contract/sync-schema.mjs';
import { createRestNoiseCollector } from '../js/calib/rest-noise.js';
import { DS5 } from '../js/ds5.js';
import { VClock } from '../ops/sim/vclock.mjs';
import { FakeDualSense } from '../ops/sim/fake-dualsense.mjs';
import { makeSimInstance } from '../ops/sim/harness.mjs';

const CONTRACT = new URL('../ops/calib-telemetry/contract/', import.meta.url);
const SCHEMA_TEXT = fs.readFileSync(new URL('events-v2.schema.json', CONTRACT), 'utf8');
const FIXTURES_TEXT = fs.readFileSync(new URL('events-v2.fixtures.json', CONTRACT), 'utf8');
const FIXTURES = JSON.parse(FIXTURES_TEXT);
const sha256 = text => createHash('sha256').update(text).digest('hex');

// Stessi valori in subralabs-v2/code/calib-telemetry/calib-telemetry-v2.test.js.
const CONTRACT_SHA256 = {
  schema: '282796145fb4416ccd6295207226915cadce7d176b8f9530e1b75cf7d1a7ccc7',
  fixtures: '9e945ac15bdbfb61b7d6afe73a7671cae51e4794724134d3adea5af424878c78',
};

const CTX = { sid: '3f9a01bc', seq: 0, board: 'BDM-030', fw: 16777258 };

test('the contract files match the pinned hashes shared with the server', () => {
  assert.equal(sha256(SCHEMA_TEXT), CONTRACT_SHA256.schema, 'schema changed: copy it to the server and update both pins');
  assert.equal(sha256(FIXTURES_TEXT), CONTRACT_SHA256.fixtures, 'fixtures changed: copy them to the server and update both pins');
  const peer = process.env.CALIB_CONTRACT_PEER;
  if (peer) {
    for (const name of ['events-v2.schema.json', 'events-v2.fixtures.json']) {
      assert.equal(fs.readFileSync(`${peer}/${name}`, 'utf8'), fs.readFileSync(new URL(name, CONTRACT), 'utf8'), name);
    }
  }
});

test('the browser copy of the schema is generated from the JSON contract', () => {
  const module = fs.readFileSync(new URL('../js/telemetry-v2-schema.js', import.meta.url), 'utf8');
  assert.equal(module, renderSchemaModule(SCHEMA_TEXT), 'run node ops/calib-telemetry/contract/sync-schema.mjs');
  assert.deepEqual(JSON.parse(JSON.stringify(EVENTS_V2_SCHEMA)), JSON.parse(SCHEMA_TEXT));
});

test('every valid fixture passes and every invalid fixture is rejected', () => {
  assert.ok(FIXTURES.valid.length >= 10 && FIXTURES.invalid.length >= 30);
  for (const { name, event } of FIXTURES.valid) assert.equal(validateEventV2(event), null, name);
  for (const { name, event } of FIXTURES.invalid) assert.notEqual(validateEventV2(event), null, name);
  const types = new Set(FIXTURES.valid.map(f => f.event.type));
  assert.deepEqual([...types].sort(), ['flash', 'guided', 'quick', 'range', 'rest', 'save']);
});

test('the schema is closed: every object rejects unknown fields and every string is an enum or the sid pattern', () => {
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if ([node.type].flat().includes('object')) {
      assert.equal(node.additionalProperties, false, `${path} must reject unknown fields`);
      const optional = { '#/$defs/QuickEvent': ['verification'], '#/$defs/RangeEvent': ['completion'] }[path] ?? [];
      assert.deepEqual([...node.required, ...optional].sort(), Object.keys(node.properties).sort(), `${path}: only backward-compatible diagnostics are optional`);
    }
    const types = [node.type].flat();
    if (types.includes('string')) assert.ok(node.pattern || node.enum || 'const' in node, `${path}: free string`);
    for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`);
  };
  walk(EVENTS_V2_SCHEMA, '#');
  // Nessun campo che identifichi il controller, la persona o l'ora.
  const fields = new Set();
  const collect = node => {
    if (!node || typeof node !== 'object') return;
    if (node.properties) for (const k of Object.keys(node.properties)) fields.add(k);
    for (const v of Object.values(node)) collect(v);
  };
  collect(EVENTS_V2_SCHEMA);
  for (const name of fields) {
    assert.doesNotMatch(name, /serial|mac|^ip$|agent|^t$|^time$|stamp|date|key|color|build|err|msg|text|name/i, `field ${name}`);
  }
});

test('an unsupported schema keyword makes the validator throw instead of passing silently', () => {
  const schema = { ...EVENTS_V2_SCHEMA, $defs: { ...EVENTS_V2_SCHEMA.$defs, Sid: { type: 'string', format: 'uuid' } } };
  assert.throws(() => validateEventV2(FIXTURES.valid[0].event, schema), /Unsupported schema keyword format/);
});

function modelDevice(clock, seed = 5) {
  return new FakeDualSense({
    clock, seed,
    sticks: [[8, -3], [-0.1, 0.4]].map(d => ({ drift: d, noise: 0.05, bias: { axis: 0, B: 3 } })),
    fw: { sf: 0, cmdMs: [2, 6] },
    timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    hand: { schedule: [] },
  });
}

test('a real runQuick session maps to a valid quick event with rounded offsets and nothing else', async () => {
  const clock = new VClock();
  const dev = modelDevice(clock);
  const inst = makeSimInstance(clock, dev, { board: 'BDM-030', fw: 16777258 });
  const res = await clock.run(inst.run());
  dev.stopped = true;
  // campi locali che non devono mai uscire
  res.session.err = 'free text from an exception';
  res.session.sid = 'local123';
  const event = buildQuickEvent(CTX, { session: res.session, outcome: res.outcome, committed: res.committed, durMs: 23_456 });
  assert.equal(validateEventV2(event), null);
  assert.deepEqual(Object.keys(event).sort(), ['after', 'afterAxes', 'app', 'before', 'beforeAxes', 'board', 'committed', 'durS', 'fw', 'needsPowerCycle',
    'outcome', 'passAxes', 'passes', 'seq', 'sid', 'start', 'truncated', 'type', 'v', 'verification']);
  assert.equal(event.outcome, res.outcome);
  assert.equal(event.durS, 23);
  assert.equal(event.app, TELEMETRY_APP_BUILD);
  assert.equal(event.passes.length, res.session.passes.length);
  assert.equal(event.passAxes.length, event.passes.length);
  assert.deepEqual(event.passAxes, res.session.passXY.map(xy => xy?.map(stick => stick.map(value => Math.min(128, Math.max(-128, Math.round(value * 2.55))))) ?? null));
  assert.deepEqual(event.beforeAxes, res.session.before.xy.map(stick => stick.map(value => Math.min(128, Math.max(-128, Math.round(value * 2.55))))));
  assert.deepEqual(event.afterAxes, res.session.after.xy.map(stick => stick.map(value => Math.min(128, Math.max(-128, Math.round(value * 2.55))))));
  for (const v of [...event.before, ...event.after, ...event.passes]) assert.equal(v, Math.round(v * 100) / 100);
  assert.ok(!JSON.stringify(event).includes('free text'));
});

test('quick builder: unknown outcomes, boards and firmware never pass through as text', () => {
  const event = buildQuickEvent({ ...CTX, board: 'Custom <b>', fw: 1.5 }, {
    session: { passes: [null, 2.345678, 999], passXY: [[[9, 0], [0, 0]], null, [[100, -100], [0, 0]]],
      before: { off: [4.2, 'x'], xy: [[9, 0], [0, 0]] }, after: null, truncated: 'time-limit' },
    outcome: 'weird', start: 'forced', committed: true, durMs: 9e9,
  });
  assert.equal(validateEventV2(event), null);
  assert.deepEqual([event.board, event.fw, event.outcome, event.before, event.after, event.truncated, event.durS],
    [null, null, 'error', null, null, true, 3600]);
  assert.deepEqual(event.passes, [null, 2.35, 200]);
  assert.deepEqual(event.passAxes, [null, null, [[128, -128], [0, 0]]]);
  assert.deepEqual([event.beforeAxes, event.afterAxes], [[[23, 0], [0, 0]], null]);
});

test('per-axis residuals retain sign and half steps; unavailable readings stay null and passes align', () => {
  const event = buildQuickEvent(CTX, { session: {
    before: { off: [0.55, 0.55], xy: [[-0.392, 0.392], [-1.176, 1.176]] },
    after: { off: [0.55, 0.55], xy: [[0, -0.392], [0.392, 0]] },
    passes: [0.55, null, 1.24],
    passXY: [[[0.392, -0.392], [-0.392, 0.392]], [[99, 99], [99, 99]]],
  }, outcome: 'unverified' });
  assert.equal(validateEventV2(event), null);
  assert.deepEqual(event.beforeAxes, [[-1, 1], [-3, 3]]);
  assert.deepEqual(event.afterAxes, [[0, -1], [1, 0]]);
  assert.deepEqual(event.passAxes, [[[1, -1], [-1, 1]], null, null]);
  assert.equal(event.passAxes.length, event.passes.length);
  assert.deepEqual(event.passAxes.map((value, i) => value === null ? i : null).filter(value => value !== null), [1, 2]);
});

test('malformed per-axis readings are discarded as a whole measurement', () => {
  const event = buildGuidedEvent(CTX, {
    outcome: 'done', committed: true, needsPowerCycle: false, step: 5,
    before: { off: [1, 1], xy: [[1, Infinity], [0, 0]] },
    after: { off: [1, 1], xy: [[1, 2], null] },
    timeouts: 0, escaped: false, durMs: 1_000,
  });
  assert.equal(validateEventV2(event), null);
  assert.deepEqual([event.beforeAxes, event.afterAxes], [null, null]);
});

test('guided, range, flash and save builders produce valid events', () => {
  const guided = buildGuidedEvent(CTX, {
    outcome: 'done', committed: true, needsPowerCycle: false, step: 5,
    before: { off: [22.4, 0.555], noise: [1, 1], xy: [[1, 2], [3, 4]] }, after: { off: [1.2403, 0.555] },
    timeouts: 2, escaped: true, durMs: 95_000,
  });
  assert.equal(validateEventV2(guided), null);
  assert.deepEqual([guided.before, guided.after], [[22.4, 0.56], [1.24, 0.56]]);
  assert.deepEqual([guided.beforeAxes, guided.afterAxes], [[[3, 5], [8, 10]], null]);

  const range = buildRangeEvent(CTX, { outcome: 'incomplete', committed: true, coverage: [0.917, 1], turns: [2.46, 3.1], allEdges: false, durMs: 31_200 });
  assert.equal(validateEventV2(range), null);
  assert.deepEqual(range.coverage, [0.92, 1]);

  const flash = buildFlashEvent(CTX, { result: 'lock-failed', nv: { status: 'unlocked', raw: 0x03030200 }, attempt: 2, lock: 'guarded' });
  assert.equal(validateEventV2(flash), null);
  assert.equal(flash.nv, 'unlocked');
  assert.ok(!('raw' in flash));

  const save = buildSaveEvent(CTX, {
    result: 'left', ref: 4, sessions: 2,
    lock: { mode: 'disabled', reasons: [{ code: 'range-incomplete', text: 'a sentence' }, { code: 'catastrophic', text: 'x' }, { code: 'catastrophic' }] },
    opens: 1, reminderOpens: 0, cancels: 1, attempts: 0, lastFlash: null, seen: true, waitMs: 12_600,
  });
  assert.equal(validateEventV2(save), null);
  assert.deepEqual(save.reasons, ['catastrophic', 'range-incomplete'], 'codes only, in a fixed order, no copy text');
  assert.equal(save.waitS, 13);
  assert.ok(!('board' in save) && !('fw' in save), 'save carries no device fields');
});

test('flash results are classified from the error flags, never from the message', () => {
  assert.equal(flashResultFor(null, { status: 'locked' }), 'ok');
  assert.equal(flashResultFor(null, { status: 'pending_reboot' }), 'ok');
  assert.equal(flashResultFor(null, { status: 'unlocked' }), 'not-confirmed');
  for (const status of ['error', 'unknown', null])
    assert.equal(flashResultFor(null, status ? { status } : null), 'not-confirmed');
  assert.equal(flashResultFor({ nvUnknown: true, flashStage: 'lock' }, null), 'nv-unknown');
  assert.equal(flashResultFor({ flashStage: 'unlock' }, null), 'unlock-failed');
  assert.equal(flashResultFor({ flashStage: 'lock' }, null), 'lock-failed');
  assert.equal(flashResultFor(new Error('NVS unlock failed'), null), 'error');
});

test('DS5.flash tags a failed unlock and a failed lock with their stage', async () => {
  const fake = { opened: true, collections: [], log() {} };
  const ds = new DS5(fake, () => {}, { timers: { setTimeout: fn => { fn(); return 0; }, clearTimeout() {} } });
  ds.nvsUnlock = async () => { throw new Error('refused'); };
  await assert.rejects(ds.flash(), err => err.flashStage === 'unlock');
  ds.nvsUnlock = async () => {};
  ds.nvsLock = async () => { throw new Error('refused'); };
  await assert.rejects(ds.flash(), err => err.flashStage === 'lock');
});

test('a rest summary from the collector maps to a valid rest event', () => {
  const c = createRestNoiseCollector();
  let summary = null;
  for (let t = 0; !summary && t < 40_000; t += 4) {
    const flick = (t / 4) % 7 === 0 ? 1 / 127.5 : 0;
    summary = c.push({ lx: 0.5 / 127.5 + flick, ly: 0.5 / 127.5, rx: -3.5 / 127.5, ry: 0.5 / 127.5 }, t);
  }
  const event = buildRestEvent(CTX, { summary, drift: summary.drift, state: 'none', discarded: summary.discarded });
  assert.equal(validateEventV2(event), null, validateEventV2(event));
  assert.equal(event.durS, 30);
  assert.ok(!('fw' in event), 'rest carries the board only');
});

test('uploadEventV2 never calls fetch for an invalid event', async () => {
  let calls = 0;
  const sent = await uploadEventV2({ ...FIXTURES.valid[0].event, serial: 'E123' }, { fetchImpl: async () => { calls += 1; } });
  assert.equal(sent, false);
  assert.equal(calls, 0);
});

test('uploadEventV2 posts exactly the event as JSON with keepalive, and rejects HTTP errors', async () => {
  let request;
  const event = FIXTURES.valid[0].event;
  const sent = await uploadEventV2(event, {
    signal: new AbortController().signal,
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 204 }; },
  });
  assert.equal(sent, true);
  assert.equal(request.url, EVENTS_V2_ENDPOINT);
  assert.equal(EVENTS_V2_ENDPOINT, 'https://subralabs.com/api/calib/v2/events');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.equal(request.options.keepalive, true);
  assert.deepEqual(JSON.parse(request.options.body), event);
  await assert.rejects(uploadEventV2(event, {
    signal: new AbortController().signal, fetchImpl: async () => ({ ok: false, status: 429 }),
  }), /HTTP 429/);
});

test('the consent scope is 4 and the app build is inside the contract range', () => {
  assert.equal(TELEMETRY_SCOPE, 4);
  assert.equal(validateEventV2({ ...FIXTURES.valid[0].event, app: TELEMETRY_APP_BUILD }), null);
});

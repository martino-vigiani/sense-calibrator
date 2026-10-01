// Contratto diagnostico: solo misure già disponibili, nessun identificativo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { buildQuickEvent, buildRangeEvent, validateEventV2 } from '../js/telemetry-v2.js';
import { buildEventsReport } from '../ops/calib-telemetry/events-report.mjs';

const require = createRequire(import.meta.url);
const serverValidate = require('../server/calib-telemetry/events-v2.js').validateEventV2;
const ctx = { sid: '1234abcd', seq: 0, board: 'BDM-040', fw: 17825834 };
const attempt = (extra = {}) => ({ pass: 1, attempt: 1, off: [18, 0.55], noise: [0.5, 0],
  stableFraction: 0.9, rawNoise: 0.5, hold: 'not-required', accepted: false, criterion: 'stable-fraction', ...extra });
const verification = (attempts = [attempt()]) => ({ baselineNoise: [0.5, 0], baselineRawNoise: 0.5, attempts });
const quick = (v = verification()) => buildQuickEvent(ctx, { session: {
  before: { off: [2, 0.55] }, after: { off: [18, 0.55] }, passes: [18], verification: v,
}, outcome: 'catastrophic', committed: true, durMs: 12_000 });
const range = (completion = { reversed: [false, true], reverseTurns: [0, 1.3], missing: [['reverse'], []] }) =>
  buildRangeEvent(ctx, { outcome: 'incomplete', committed: true, coverage: [1, 1], turns: [3, 4], allEdges: true, completion, durMs: 25_000 });
const assertValid = e => { assert.equal(validateEventV2(e), null); assert.equal(serverValidate(e), null); };

test('both validators continue to accept every old event without diagnostic fields', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../ops/calib-telemetry/contract/events-v2.fixtures.json', import.meta.url)));
  for (const { event } of fixtures.valid) {
    const old = structuredClone(event);
    delete old.verification; delete old.completion;
    assertValid(old);
  }
});

test('Quick builder preserves the distinction between stable, unstable and missing verification', () => {
  const e = quick(verification([
    attempt({ stableFraction: 0.1, rawNoise: 24, criterion: 'none' }),
    attempt({ attempt: 2, off: null, noise: null, stableFraction: null, rawNoise: null, hold: 'not-released', criterion: 'none' }),
  ]));
  assertValid(e);
  assert.equal(e.verification.attempts[0].criterion, 'none');
  assert.equal(e.verification.attempts[1].off, null);
  assert.equal(e.verification.attempts[1].hold, 'not-released');
  assert.equal(e.outcome, 'catastrophic');
  assert.equal(e.committed, true);
  const legacySource = buildQuickEvent(ctx, { session: {}, outcome: 'preflight' });
  assert.equal(legacySource.verification, null, 'missing data must not pretend that verification ran');
});

test('diagnostic builders round and sanitize only explicitly allowed measurements', () => {
  const e = quick({ baselineNoise: [1.23456, Infinity], baselineRawNoise: Infinity, serial: 'secret', attempts: [attempt({
    off: [2000, 0.55459], noise: [1.23456, 0], stableFraction: 0.987654, rawNoise: 1234, message: 'secret',
  })] });
  assertValid(e);
  assert.deepEqual(e.verification.baselineNoise, null);
  assert.equal(e.verification.baselineRawNoise, null);
  assert.deepEqual(e.verification.attempts[0].off, [200, 0.55]);
  assert.deepEqual(e.verification.attempts[0].noise, [1.23, 0]);
  assert.equal(e.verification.attempts[0].stableFraction, 0.988);
  assert.equal(e.verification.attempts[0].rawNoise, 200);
  assert.ok(!JSON.stringify(e).includes('secret'));
  const r = range({ reversed: [false, true], reverseTurns: [0.123456, 1234], missing: [['reverse', 'reverse', 'serial'], []], serial: 'secret' });
  assertValid(r);
  assert.deepEqual(r.completion.reverseTurns, [0.1, 100]);
  assert.deepEqual(r.completion.missing, [['reverse'], []]);
  assert.ok(!JSON.stringify(r).includes('secret'));
});

test('malformed diagnostic objects fail closed in both validators', () => {
  const bad = [
    e => { e.verification.attempts[0].serial = 'hidden'; },
    e => { delete e.verification.attempts[0].hold; },
    e => { e.verification.attempts[0].criterion = 'a free explanation'; },
    e => { e.verification.attempts[0].off = [18]; },
    e => { e.verification.attempts[0].stableFraction = 1.01; },
    e => { e.verification.attempts[0].rawNoise = 201; },
    e => { e.verification.attempts[0].attempt = 3; },
    e => { e.verification.attempts[0].pass = 9; },
    e => { e.verification.attempts.push(attempt()); },
    e => { e.verification.attempts = Array(17).fill(attempt()); },
    e => { e.verification.attempts[0].accepted = true; e.verification.attempts[0].criterion = 'none'; },
  ];
  for (const mutate of bad) {
    const e = quick(); mutate(e);
    assert.notEqual(validateEventV2(e), null);
    assert.notEqual(serverValidate(e), null);
  }
  for (const completion of [
    { reversed: [false], reverseTurns: [0, 1], missing: [['reverse'], []] },
    { reversed: [false, true], reverseTurns: [0, 1], missing: [['other'], []] },
    { reversed: [false, true], reverseTurns: [0, 1], missing: [['reverse', 'reverse'], []] },
    { reversed: [false, true], reverseTurns: [0, 1], missing: [['reverse'], []], serial: 'x' },
  ]) {
    const e = range(); e.completion = completion;
    assert.notEqual(validateEventV2(e), null); assert.notEqual(serverValidate(e), null);
  }
});

test('the largest diagnostic Quick payload fits the unchanged 4 KiB HTTP body limit', () => {
  const e = buildQuickEvent({ ...ctx, seq: 255, board: 'BDM-060R', fw: 4294967295 }, { session: {
    before: { off: [199.99, 199.99], xy: [[-100, -100], [-100, -100]] },
    after: { off: [199.99, 199.99], xy: [[-100, -100], [-100, -100]] },
    passes: Array(8).fill(199.99), passXY: Array(8).fill([[-100, -100], [-100, -100]]),
    verification: { baselineNoise: [199.99, 199.99], baselineRawNoise: 199.99,
      attempts: Array.from({ length: 16 }, (_, i) => attempt({ pass: Math.floor(i / 2) + 1, attempt: i % 2 + 1,
        off: [199.99, 199.99], noise: [199.99, 199.99], stableFraction: 0.999, rawNoise: 199.99,
        hold: i % 2 ? 'not-released' : 'not-required' })) },
  }, outcome: 'residual-deterministic', start: 'recovery', committed: true, needsPowerCycle: true, durMs: 9e9 });
  assertValid(e);
  assert.equal(e.verification.attempts.length, 16);
  assert.ok(Buffer.byteLength(JSON.stringify(e), 'utf8') < 4096);
});

test('report separates legacy unknowns, stable extremes and unstable extremes without leaking visits', () => {
  const old = quick(); delete old.verification;
  const stable = quick();
  const unstable = quick(verification([attempt({ criterion: 'none', stableFraction: 0.1, rawNoise: 30 })]));
  const missing = quick(verification([attempt({ off: null, noise: null, criterion: 'none', stableFraction: null, rawNoise: null })]));
  const oldRange = range(); delete oldRange.completion;
  const reverse = range();
  const coverage = range({ reversed: [true, true], reverseTurns: [3, 2], missing: [['coverage'], []] });
  const events = [old, stable, unstable, missing, oldRange, reverse, coverage];
  const lines = events.map((e, i) => JSON.stringify({ ...e, sid: (i + 1).toString(16).padStart(8, '0'), receivedDay: '2026-10-01' })).join('\n');
  const r = buildEventsReport(lines);
  assert.equal(r.input.invalidEvent, 0);
  assert.deepEqual(r.diagnostics.quick.catastrophic, { n: 4, stableMeasurement: 1, unstableMeasurement: 1, unknownMeasurement: 2 });
  assert.equal(r.diagnostics.quick.withoutVerification, 1);
  assert.equal(r.diagnostics.range.incomplete.reversalOnly, 1);
  assert.equal(r.diagnostics.range.incomplete.coverageOnly, 1);
  assert.equal(r.diagnostics.range.incomplete.unknown, 1);
  const serialized = JSON.stringify(r.diagnostics);
  for (const e of events) assert.ok(!serialized.includes(e.sid));
  assert.ok(!serialized.includes('"sid"') && !serialized.includes('"seq"'));
});

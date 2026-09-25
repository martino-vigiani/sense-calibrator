import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCalibrationUpload, uploadCalibrationEvent } from '../js/telemetry.js';
import { VClock } from '../ops/sim/vclock.mjs';
import { FakeDualSense } from '../ops/sim/fake-dualsense.mjs';
import { makeSimInstance } from '../ops/sim/harness.mjs';

function validQuick(overrides = {}) {
  return {
    kind: 'quick',
    sid: 'local123',
    t: '2026-09-16T10:00:00.000Z',
    board: 'BDM-030',
    fw: 123456,
    before: { off: [4.2, 1.5], noise: [0.4, 0.6], xy: [[4, 1], [1, 1]] },
    after: { off: [0.8, 0.7], noise: [0.3, 0.4], xy: [[0, 1], [1, 0]] },
    passes: [2.1, 0.8],
    unstableEvents: 0,
    gate: 0.015,
    gateOff: false,
    best: 0.8,
    gateMax: 0.024,
    gateBase: 0.015,
    gateWidenings: 1,
    settled: true,
    ...overrides,
  };
}

test('non-quick events stay local and do not call fetch', async () => {
  let calls = 0;
  const sent = await uploadCalibrationEvent(
    { kind: 'drift', t: '2026-09-16T10:00:00.000Z', sid: 'local123' },
    { fetchImpl: async () => { calls += 1; } },
  );

  assert.equal(sent, false);
  assert.equal(calls, 0);
});

test('quick events map to exactly the strict v1 contract', () => {
  assert.deepEqual(buildCalibrationUpload(validQuick()), {
    t: '2026-09-16T10:00:00.000Z',
    board: 'BDM-030',
    fw: 123456,
    before: { off: [4.2, 1.5], noise: [0.4, 0.6] },
    after: { off: [0.8, 0.7], noise: [0.3, 0.4] },
    passes: [2.1, 0.8],
    unstableEvents: 0,
    gate: 0.015,
    gateOff: false,
  });
});

test('an unverified result stays local instead of becoming misleading training data', async () => {
  let calls = 0;
  const entry = validQuick({ after: null, aborted: 'no-data' });
  const sent = await uploadCalibrationEvent(entry, {
    fetchImpl: async () => { calls += 1; },
  });

  assert.equal(buildCalibrationUpload(entry), null);
  assert.equal(sent, false);
  assert.equal(calls, 0);
});

test('empty or invalid pass measurements stay local', () => {
  assert.equal(buildCalibrationUpload(validQuick({ passes: [] })), null);
  assert.equal(buildCalibrationUpload(validQuick({ passes: [2.1, null] })), null);
});

test('timestamps must match the canonical format emitted by the app', () => {
  assert.equal(buildCalibrationUpload(validQuick({ t: '2026-09-16' })), null);
  assert.ok(buildCalibrationUpload(validQuick({ t: '2026-09-16T10:00:00.000Z' })));
});

test('incomplete quick events stay local and do not call fetch', async () => {
  let calls = 0;
  const entry = validQuick({ gate: undefined, gateOff: undefined, aborted: 'error' });
  const sent = await uploadCalibrationEvent(entry, {
    fetchImpl: async () => { calls += 1; },
  });

  assert.equal(sent, false);
  assert.equal(calls, 0);
});

test('HTTP errors are not reported as successful uploads', async () => {
  await assert.rejects(
    uploadCalibrationEvent(validQuick(), {
      fetchImpl: async () => ({ ok: false, status: 400 }),
      signal: new AbortController().signal,
    }),
    /HTTP 400/,
  );
});

test('HTTP 204 sends the mapped contract and returns true', async () => {
  let request;
  const sent = await uploadCalibrationEvent(validQuick(), {
    endpoint: 'https://example.test/calibration',
    signal: new AbortController().signal,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 204 };
    },
  });

  assert.equal(sent, true);
  assert.equal(request.url, 'https://example.test/calibration');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['content-type'], 'application/json');
  assert.equal(request.options.keepalive, true);
  assert.deepEqual(JSON.parse(request.options.body), buildCalibrationUpload(validQuick()));
});

test('network failures reject without changing calibration state', async () => {
  await assert.rejects(
    uploadCalibrationEvent(validQuick(), {
      fetchImpl: async () => { throw new Error('offline'); },
      signal: new AbortController().signal,
    }),
    /offline/,
  );
});

// Review 2: una corsa Quick fermata prima del suo esito ('moved') o troncata
// dal tetto di durata resta locale, anche se i suoi campi sono tutti validi.
test('stopped or truncated quick runs stay local and never call fetch', async () => {
  for (const entry of [validQuick({ aborted: 'moved' }), validQuick({ truncated: 'time-limit' })]) {
    let calls = 0;
    assert.equal(buildCalibrationUpload(entry), null);
    const sent = await uploadCalibrationEvent(entry, { fetchImpl: async () => { calls += 1; } });
    assert.equal(sent, false);
    assert.equal(calls, 0);
  }
});

function modelDevice(clock) {
  return new FakeDualSense({
    clock, seed: 5,
    sticks: [[8, -3], [-0.1, 0.4]].map(d => ({ drift: d, noise: 0.05, bias: { axis: 0, B: 3 } })),
    fw: { sf: 0, cmdMs: [2, 6] },
    timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    hand: { schedule: [] },
  });
}
const canonical = session => ({ ...session, t: new Date(Date.parse(session.t)).toISOString() });

test('model: a run stopped by a held stick before pass 2 ("moved") is not uploadable', async () => {
  const clock = new VClock();
  const dev = modelDevice(clock);
  let touched = false;
  const onProgress = e => {
    if (e.phase !== 'next' || touched) return;
    touched = true;
    dev.touches.push({ stick: 0, t0: clock.now() + 5, dur: 120_000, tail: 150, amp: [40, 0], at: () => 40 });
  };
  const inst = makeSimInstance(clock, dev, { board: 'BDM-030', fw: 1 }, {}, { onProgress });
  const res = await clock.run(inst.run());
  dev.stopped = true;
  assert.equal(res.outcome, 'moved');
  assert.equal(res.session.aborted, 'moved');
  assert.ok(res.session.after, 'the record itself looks complete');
  assert.equal(buildCalibrationUpload(canonical(res.session)), null);
  assert.ok(buildCalibrationUpload(canonical({ ...res.session, aborted: undefined })), 'only the marker keeps it local');
});

test('model: a run cut by the session time limit is marked truncated and not uploadable', async () => {
  const clock = new VClock();
  const dev = modelDevice(clock);
  // Tetto appena sopra una passata: la passata 2 non ha il tempo di partire.
  const inst = makeSimInstance(clock, dev, { board: 'BDM-030', fw: 1 }, { maxSessionMs: 30_000 });
  const res = await clock.run(inst.run());
  dev.stopped = true;
  assert.equal(res.session.truncated, 'time-limit');
  assert.equal(res.session.passes.length, 1);
  assert.equal(res.session.aborted, undefined);
  assert.equal(buildCalibrationUpload(canonical(res.session)), null);
});

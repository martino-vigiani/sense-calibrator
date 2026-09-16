import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCalibrationUpload, uploadCalibrationEvent } from '../js/telemetry.js';

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

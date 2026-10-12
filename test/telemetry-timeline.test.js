// Cronologia della visita (js/telemetry-timeline.js) e i due builder che la
// portano in rete (rest con i tempi, landing): ancora, operazioni, controller
// diverso, soglia e tetto degli invii, arrotondamenti. Pura, tempi sintetici.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createCalTimeline, TIMELINE_DEFAULTS } from '../js/telemetry-timeline.js';
import { buildLandingEvent, buildRestEvent, sinceCalSFor, validateEventV2 } from '../js/telemetry-v2.js';

const CTX = { sid: '3f9a01bc', seq: 5, board: 'BDM-030', fw: 16777258 };
const land = (stick, x, y) => ({ t: 0, stick, peak: 80, landAxes: [x, y], landPct: Math.hypot(x, y) / 1.275, settleMs: 40 });
const REST_SUMMARY = {
  durMs: 30_000, reports: 7400, intervalMs: [4, 4.3, 21.7], gaps: 0,
  sticks: [0, 1].map(() => ({ off: 0.61, p50: 0.5, p95: 1.12, max: 2.06, sx: 0.41, sy: 0.38, ex: [42, 3, 0] })),
};

test('no calibration: rest fields are null and releases wait for the page exit', () => {
  const tl = createCalTimeline();
  tl.connected('k1');
  assert.deepEqual(tl.rest(1000), { sinceMs: null, ops: null, landings: null });
  for (let i = 0; i < 30; i++) assert.equal(tl.landing(land('left', 1, 0), i * 1000), false, 'no count trigger before a calibration');
  assert.equal(tl.pending('count', 40_000), null);
  const left = tl.pending('left', 40_000);
  assert.deepEqual([left.ref, left.sinceMs, left.ops, left.counts], [null, null, null, { left: 30, right: 0 }]);
  assert.ok(left.landings.every(l => l.sinceMs === null));
});

test('a committed Quick or Guided anchors the time; Range, Write, reconnect and power cycle follow once each, in order', () => {
  const tl = createCalTimeline();
  tl.connected('k1');
  tl.calibration({ type: 'quick', committed: false, ref: 0 }, 1000);
  assert.equal(tl.anchored, false, 'a Quick that changed nothing is not a calibration');
  tl.calibration({ type: 'range', committed: true, ref: 1 }, 1500);
  assert.equal(tl.anchored, false, 'Range alone is not the anchor');
  tl.calibration({ type: 'guided', committed: true, ref: 2 }, 2000);
  tl.calibration({ type: 'range', committed: false, ref: 3 }, 3000);
  tl.op('flash');
  tl.calibration({ type: 'range', committed: true, ref: 4 }, 4000);
  tl.op('flash');
  tl.disconnected();
  tl.connected('k1');
  tl.op('power-cycle');
  tl.op('unplug');
  assert.deepEqual(tl.rest(65_000), { sinceMs: 63_000, ops: ['guided', 'flash', 'range', 'reconnect', 'power-cycle'], landings: 0 });
  // Una calibrazione nuova riparte da capo.
  tl.landing(land('right', 2, 2), 66_000);
  tl.calibration({ type: 'quick', committed: true, ref: 9 }, 70_000);
  assert.deepEqual(tl.rest(70_000), { sinceMs: 0, ops: ['quick'], landings: 0 });
});

test('a different controller drops the anchor and the releases; an unreadable serial is a reconnect', () => {
  const tl = createCalTimeline();
  tl.connected('k1');
  tl.calibration({ type: 'quick', committed: true, ref: 0 }, 0);
  tl.landing(land('left', 1, 1), 1000);
  tl.disconnected();
  tl.connected('k2');
  assert.deepEqual(tl.rest(5000), { sinceMs: null, ops: null, landings: null });
  assert.equal(tl.pending('left', 5000), null, 'the other controller’s releases are gone');

  const tl2 = createCalTimeline();
  tl2.connected('k1');
  tl2.calibration({ type: 'quick', committed: true, ref: 0 }, 0);
  tl2.disconnected();
  tl2.connected(null);
  assert.deepEqual(tl2.rest(1000).ops, ['quick', 'reconnect']);
  tl2.disconnected();
  tl2.connected('k1');
  assert.deepEqual(tl2.rest(1000).ops, ['quick', 'reconnect'], 'the same controller again: still one reconnect entry');
});

test('20 releases after a calibration ask for one event; the page exit sends the rest; never more than two', () => {
  const tl = createCalTimeline();
  tl.connected('k1');
  tl.calibration({ type: 'quick', committed: true, ref: 3 }, 0);
  const asks = [];
  for (let i = 1; i <= 25; i++) if (tl.landing(land(i % 2 ? 'left' : 'right', i % 3, -1), i * 2000)) asks.push(i);
  assert.deepEqual(asks, [20, 21, 22, 23, 24, 25], 'asks until the caller says it was sent');
  const p = tl.pending('count', 50_000);
  assert.deepEqual([p.trigger, p.ref, p.sinceMs, p.ops, p.counts], ['count', 3, 50_000, ['quick'], { left: 13, right: 12 }]);
  tl.sent('count');
  assert.equal(tl.landing(land('left', 0, 0), 52_000), false);
  assert.equal(tl.pending('count', 52_000), null, 'once per calibration');
  assert.ok(tl.pending('left', 52_000), 'new releases since the count event');
  tl.sent('left');
  assert.equal(tl.sends, TIMELINE_DEFAULTS.maxSends);
  tl.calibration({ type: 'guided', committed: true, ref: 7 }, 60_000);
  for (let i = 0; i < 25; i++) assert.equal(tl.landing(land('left', 0, 0), 61_000 + i), false, 'budget spent');
  assert.equal(tl.pending('left', 70_000), null);
});

test('the page exit sends nothing new when nothing changed since the last event, and revocation forgets the releases', () => {
  const tl = createCalTimeline();
  tl.calibration({ type: 'quick', committed: true, ref: 0 }, 0);
  for (let i = 0; i < 20; i++) tl.landing(land('left', 0, 0), i);
  tl.sent('count');
  assert.equal(tl.pending('left', 100), null);
  tl.landing(land('left', 0, 0), 200);
  tl.clearLandings();
  assert.equal(tl.pending('left', 300), null);
  assert.equal(tl.rest(300).landings, 0);
});

test('only the most recent releases are kept for the summary; the count covers all of them', () => {
  const tl = createCalTimeline({ maxStored: 10 });
  tl.calibration({ type: 'quick', committed: true, ref: 0 }, 0);
  for (let i = 0; i < 15; i++) tl.landing(land('right', i, 0), i * 1000);
  const p = tl.pending('left', 20_000);
  assert.equal(p.counts.right, 15);
  assert.equal(p.landings.length, 10);
  assert.equal(p.landings[0].landAxes[0], 5);
  const e = buildLandingEvent(CTX, p);
  assert.equal(validateEventV2(e), null);
  assert.equal(e.sticks[1].count, 15);
  assert.equal(e.sticks[1].recent.length, 10);
});

test('sinceCalS is rounded to 10 s and capped at an hour; null stays null', () => {
  assert.deepEqual([0, 4_999, 5_000, 64_000, 3_594_999, 3_600_000, 9e9, -2000, null, undefined, NaN].map(sinceCalSFor),
    [0, 0, 10, 60, 3590, 3600, 3600, 0, null, null, null]);
});

test('rest event: timing fields are rounded and appear only with a calibration', () => {
  const timed = buildRestEvent(CTX, { summary: REST_SUMMARY, drift: false, state: 'unsaved', discarded: 0,
    timing: { sinceMs: 123_456, ops: ['quick', 'range', 'bogus', 'range'], landings: 12 } });
  assert.equal(validateEventV2(timed), null);
  assert.deepEqual([timed.sinceCalS, timed.opsSince, timed.landings], [120, ['quick', 'range'], 12]);
  const none = buildRestEvent(CTX, { summary: REST_SUMMARY, drift: false, state: 'none', discarded: 0,
    timing: { sinceMs: null, ops: ['quick'], landings: 3 } });
  assert.deepEqual([none.sinceCalS, none.opsSince, none.landings], [null, null, null]);
  assert.equal(validateEventV2(none), null);
  // Le pagine in cache mandano rest senza i campi nuovi: restano valide.
  const legacy = { ...none };
  for (const k of ['sinceCalS', 'opsSince', 'landings']) delete legacy[k];
  assert.equal(validateEventV2(legacy), null);
});

test('landing event: signed half-LSB points, the last 20 per stick, relative times only and nothing else', () => {
  const landings = [];
  for (let i = 0; i < 30; i++) landings.push({ stick: 'right', landAxes: [4.3 + (i % 2), -2.26], sinceMs: i * 7_000, t: 123456 + i, peak: 90, settleMs: 30 });
  const e = buildLandingEvent(CTX, { trigger: 'count', ref: 2, sinceMs: 215_000, ops: ['quick', 'flash'], counts: { left: 0, right: 30 }, landings });
  assert.equal(validateEventV2(e), null);
  assert.deepEqual(Object.keys(e).sort(), ['app', 'board', 'opsSince', 'ref', 'seq', 'sid', 'sinceCalS', 'sticks', 'trigger', 'type', 'v']);
  assert.deepEqual(e.sticks[0], { count: 0, median: null, spread: null, firstS: null, lastS: null, recent: [] });
  const r = e.sticks[1];
  assert.deepEqual([r.count, r.median, r.firstS, r.lastS, r.recent.length], [30, [10, -5], 0, 200, 20]);
  assert.deepEqual(r.recent[0], { axes: [9, -5], sinceCalS: 70 }, 'oldest of the last 20 first; 4.3 LSB → 9 half-LSB');
  assert.deepEqual(r.recent[1].axes, [11, -5], '5.3 LSB → 11 half-LSB');
  assert.deepEqual(r.spread, [0.5, 0.5]);
  assert.equal(e.sinceCalS, 220);
  const text = JSON.stringify(e);
  assert.doesNotMatch(text, /123456|peak|settle|"t"/);
});

test('the largest landing event stays well under the 4 KB body limit of the server', () => {
  const landings = [];
  for (let i = 0; i < 40; i++) landings.push({ stick: i % 2 ? 'right' : 'left', landAxes: [-63.95, -63.95 + i * 0.01], sinceMs: 3_600_000 });
  const e = buildLandingEvent({ sid: 'ffffffff', seq: 255, board: 'BDM-060R' }, {
    trigger: 'count', ref: 255, sinceMs: 3_600_000, ops: ['quick', 'guided', 'range', 'flash', 'reconnect', 'power-cycle'],
    counts: { left: 10_000, right: 10_000 }, landings,
  });
  assert.equal(validateEventV2(e), null);
  assert.equal(e.sticks[0].recent.length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < 2048, `${Buffer.byteLength(JSON.stringify(e))} bytes`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_CENTER_RADIUS as RADIUS,
  QUICK_CENTER_HOLD_MS as HOLD_MS,
  QUICK_CENTER_MAX_GAP_MS as GAP_MS,
  createQuickCenterHold,
  sticksWithinQuickCenter,
} from '../js/quick-center-guard.js';

const resting = { lx: 0, ly: 0, rx: 0, ry: 0 };
const hidAxis = byte => (byte - 127.5) / 127.5;
const firstOutsideByte = Math.floor(127.5 + RADIUS * 127.5) + 1;
const outside = hidAxis(firstOutsideByte);

function feed(hold, from, until, sticks = resting) {
  let ready;
  for (let now = from; now <= until; now += 10) ready = hold(sticks, now);
  return ready;
}

test('a steady held stick never passes, independently for each stick and direction', () => {
  for (const axis of ['lx', 'ly', 'rx', 'ry']) {
    for (const sign of [-1, 1]) {
      const hold = createQuickCenterHold();
      const sticks = { ...resting, [axis]: sign * outside };
      for (let now = 0; now <= HOLD_MS * 3; now += 10) {
        assert.equal(hold(sticks, now), false, `${axis} must reject stable deflection`);
      }
    }
  }
});

test('both sticks need a full centered hold and at least ten fresh reports', () => {
  const hold = createQuickCenterHold();
  assert.equal(feed(hold, 0, HOLD_MS - 10), false);
  assert.equal(hold(resting, HOLD_MS), true);

  const sparse = createQuickCenterHold();
  // Long enough, but only seven reports (each gap is still permitted).
  const step = HOLD_MS / 6;
  assert.ok(step <= GAP_MS);
  for (let n = 0; n < 7; n++) assert.equal(sparse(resting, step * n), false);
  assert.equal(sparse(resting, HOLD_MS + 1), false);
  assert.equal(sparse(resting, HOLD_MS + 2), false);
  assert.equal(sparse(resting, HOLD_MS + 3), true);
});

test('one deflected report just before readiness restarts the entire hold', () => {
  const hold = createQuickCenterHold();
  feed(hold, 0, HOLD_MS - 10);
  assert.equal(hold({ ...resting, ry: outside }, HOLD_MS - 1), false);
  assert.equal(feed(hold, HOLD_MS, 2 * HOLD_MS - 10), false);
  assert.equal(hold(resting, 2 * HOLD_MS), true);
});

test('radial checks reject diagonals even when each axis is under the limit', () => {
  const diagonal = RADIUS * 0.8;
  assert.ok(diagonal < RADIUS);
  assert.equal(sticksWithinQuickCenter({ ...resting, lx: diagonal, ly: diagonal }), false);
  assert.equal(sticksWithinQuickCenter({ ...resting, rx: diagonal, ry: diagonal }), false);
});

test('center boundary is inclusive and respects neighboring normalized HID values', () => {
  const inside = hidAxis(firstOutsideByte - 1);
  assert.ok(inside <= RADIUS && outside > RADIUS);
  assert.equal(sticksWithinQuickCenter({ ...resting, lx: RADIUS }), true);
  assert.equal(sticksWithinQuickCenter({ ...resting, lx: inside, rx: -inside }), true);
  assert.equal(sticksWithinQuickCenter({ ...resting, lx: outside }), false);
  assert.equal(sticksWithinQuickCenter({ ...resting, rx: -outside }), false);
  // The hardware midpoint is between bytes 127 and 128, not exactly zero.
  assert.equal(sticksWithinQuickCenter({ lx: hidAxis(127), ly: hidAxis(128), rx: hidAxis(128), ry: hidAxis(127) }), true);
});

test('missing, invalid, stale or nonmonotonic reports invalidate a completed hold', () => {
  const interruptions = [
    { sticks: resting, time: HOLD_MS + GAP_MS + 1 },
    { sticks: resting, time: HOLD_MS },
    { sticks: resting, time: HOLD_MS - 1 },
    { sticks: resting, time: NaN },
    { sticks: { ...resting, lx: NaN }, time: HOLD_MS + 1 },
    { sticks: { ...resting, ry: Infinity }, time: HOLD_MS + 1 },
    { sticks: { lx: 0, ly: 0, rx: 0 }, time: HOLD_MS + 1 },
    { sticks: null, time: HOLD_MS + 1 },
  ];
  for (const interruption of interruptions) {
    const hold = createQuickCenterHold();
    assert.equal(feed(hold, 0, HOLD_MS), true);
    assert.equal(hold(interruption.sticks, interruption.time), false);
    const restart = HOLD_MS + GAP_MS + 10;
    assert.equal(feed(hold, restart, restart + HOLD_MS - 10), false);
    assert.equal(hold(resting, restart + HOLD_MS), true);
  }
});

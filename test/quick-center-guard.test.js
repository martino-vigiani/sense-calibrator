import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUICK_CENTER_RADIUS as RADIUS,
  QUICK_CENTER_HOLD_MS as HOLD_MS,
  QUICK_CENTER_MAX_GAP_MS as GAP_MS,
  createQuickCenterHold,
  createQuickPreflightProbe,
  sticksWithinQuickCenter,
} from '../js/quick-center-guard.js';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';

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

// ------------------------------------------- diagnosi della preflight fallita

// La sonda dice soltanto PERCHÉ la tenuta non passa; la decisione resta a
// createQuickCenterHold. Report ogni 4 ms come un DualSense via USB.
function probeFeed(probe, from, until, at) {
  for (let now = from; now <= until; now += 4) probe.push(typeof at === 'function' ? at(now) : at, now);
}
const newProbe = () => createQuickPreflightProbe({ spread: DRIFT_MOVE_SPREAD });

test('preflight probe: no reports, too few reports or a silent controller read as no-input', () => {
  const probe = newProbe();
  assert.equal(probe.status(1000).reason, 'no-input');
  for (let i = 0; i < 9; i++) probe.push(resting, i * 4);
  assert.equal(probe.status(40).reason, 'no-input', 'nine reports are not enough');
  probeFeed(probe, 40, 1000, resting);
  assert.equal(probe.status(1000).reason, 'settled');
  assert.equal(probe.status(1300).reason, 'no-input', '300 ms with no report');
});

test('preflight probe: a still stick past the radius is off-center, a moving one is moving', () => {
  const still = newProbe();
  const held = { ...resting, lx: 0.4 };
  probeFeed(still, 0, 2000, held);
  const status = still.status(2000);
  assert.equal(status.reason, 'off-center');
  assert.equal(status.side, 'left');
  assert.ok(Math.abs(status.offset - 40) < 0.01, `offset ${status.offset}`);
  assert.equal(status.result.unstable, false);
  assert.ok(status.result.left.noise < 0.01);
  // Fermo fuori raggio da 300 ms dopo il primo report (la prima finestra completa).
  assert.ok(Math.abs(still.stillOffMs(2000) - (2000 - HOLD_MS)) <= 4, `${still.stillOffMs(2000)}`);
  const hold = createQuickCenterHold();
  assert.equal(feed(hold, 0, 2000, held), false, 'the guard itself never passes it');

  const moving = newProbe();
  probeFeed(moving, 0, 2000, now => ({ ...resting, rx: 0.2 * Math.sin(now / 30) }));
  assert.equal(moving.status(2000).reason, 'moving');
  assert.equal(moving.stillOffMs(2000), 0);

  // Movimento sotto lo spread ma dentro il raggio: è "fermo e centrato".
  const tremor = newProbe();
  probeFeed(tremor, 0, 2000, now => ({ ...resting, ly: 0.02 * Math.sin(now / 30) }));
  assert.equal(tremor.status(2000).reason, 'settled');
});

test('preflight probe: a still stick straddling the 15% radius is off-center, as the guard rejects it', () => {
  const probe = newProbe();
  const hold = createQuickCenterHold();
  const straddle = now => ({ ...resting, rx: (now / 4) % 2 ? RADIUS - 0.01 : RADIUS + 0.01 });
  let ready = false;
  for (let now = 0; now <= 2000; now += 4) {
    probe.push(straddle(now), now);
    ready ||= hold(straddle(now), now);
  }
  assert.equal(ready, false);
  const status = probe.status(2000);
  assert.equal(status.reason, 'off-center');
  assert.equal(status.side, 'right');
  assert.ok(status.offset < RADIUS * 100 + 0.5);

  // Il lato è quello fuori raggio, anche se l'altro stick legge di più dentro.
  const other = newProbe();
  const dips = now => ({ ...resting, lx: RADIUS - 0.001, rx: (now / 4) % 2 ? RADIUS - 0.03 : RADIUS + 0.001 });
  probeFeed(other, 0, 2000, dips);
  const st = other.status(2000);
  assert.ok(st.result.left.offset > st.result.right.offset, 'the left stick reads more, inside the radius');
  assert.equal(st.side, 'right');
});

test('preflight probe: a report gap or a release restarts the off-center time', () => {
  const probe = newProbe();
  const held = { ...resting, ry: -0.5 };
  probeFeed(probe, 0, 1500, held);
  assert.ok(probe.stillOffMs(1500) > 1000);
  probeFeed(probe, 1500 + GAP_MS + 4, 1700, held);
  assert.equal(probe.stillOffMs(1700), 0, 'a gap over 100 ms restarts the window');
  probeFeed(probe, 1704, 2500, held);
  assert.ok(probe.stillOffMs(2500) > 0);
  probeFeed(probe, 2504, 2600, resting);
  assert.equal(probe.stillOffMs(2600), 0, 'released');
  assert.notEqual(probe.status(2600).reason, 'off-center');
  // Report non validi non contano e non lanciano.
  probe.push({ ...resting, lx: NaN }, 2604);
  probe.push(null, 2608);
  probe.push(resting, NaN);
});

test('preflight probe: reports that keep pausing are "gaps", not a moving stick', () => {
  // Revisione 12/10: un buco oltre 100 ms azzera la finestra, e con buchi
  // ricorrenti non si arriva mai a 300 ms continui. Prima lo stato restava
  // 'moving' e la pagina diceva "Release both sticks" (e "Stick held") a una
  // mano che non c'era. Lo stick qui è fermo e centrato.
  const probe = newProbe();
  let t = 0;
  for (let burst = 0; burst < 10; burst++) {
    probeFeed(probe, t, t + 200, resting); // 200 ms di report, poi un buco
    t += 200 + GAP_MS + 50;
  }
  const last = t - GAP_MS - 50;
  assert.equal(probe.status(last).reason, 'gaps');
  // Una finestra intera dopo l'ultimo buco si giudica di nuovo.
  probeFeed(probe, t, t + 400, resting);
  assert.equal(probe.status(t + 400).reason, 'settled');
  // Un buco solo, poi movimento continuo: 'moving' come prima.
  const moving = newProbe();
  probeFeed(moving, 0, 500, resting);
  probeFeed(moving, 500 + GAP_MS + 50, 1500, now => ({ ...resting, rx: 0.2 * Math.sin(now / 30) }));
  assert.equal(moving.status(1500).reason, 'moving');
  // Una mano vista in movimento, poi un buco proprio prima della fine
  // dell'attesa: resta 'moving' (sim sintetica, seed 7, sessione 301).
  const touched = newProbe();
  probeFeed(touched, 0, 1000, now => ({ ...resting, rx: 0.2 * Math.sin(now / 30) }));
  probeFeed(touched, 1000 + GAP_MS + 50, 1300, resting);
  assert.equal(touched.status(1300).reason, 'moving');
  // All'avvio, prima di 300 ms continui e senza buchi: invariato ('moving').
  const early = newProbe();
  probeFeed(early, 0, 100, resting);
  assert.equal(early.status(100).reason, 'moving');
});

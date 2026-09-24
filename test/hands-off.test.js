import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDS_OFF_AMBER_MAX, HANDS_OFF_GREEN_MAX, HANDS_OFF_LABELS, HANDS_OFF_RED_HOLD_MS, createHandsOffMeter, renderHandsOff,
} from '../js/ui/hands-off.js';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';
import { QUICK_STABLE_SPREAD } from '../js/calib/sampling.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

const LSB = 1 / 127.5;
const PERIOD = 4; // ~250 Hz, come il DualSense via USB

// Generatore deterministico: niente Math.random, i test devono ripetersi.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Stick a riposo con lo sfarfallio di un LSB tra i byte 127/128, più un tocco
// sceneggiato: `touch(t)` restituisce lo spostamento { lx, ly, rx, ry }.
function feed(meter, { from = 0, to, touch = () => null, seed = 1 }) {
  const r = rng(seed);
  const levels = [];
  for (let t = from; t <= to; t += PERIOD) {
    const flick = () => (r() < 0.5 ? -0.5 : 0.5) * LSB;
    const d = touch(t) ?? {};
    const s = { lx: flick() + (d.lx ?? 0), ly: flick() + (d.ly ?? 0), rx: flick() + (d.rx ?? 0), ry: flick() + (d.ry ?? 0) };
    levels.push({ t, level: meter.push(s, t) });
  }
  return levels;
}
const firstRed = (levels, after) => levels.find(l => l.t >= after && l.level === 'red')?.t ?? null;

test('the thresholds are the algorithm’s own: Quick’s stability gate and the "hand on the stick" spread', () => {
  assert.equal(HANDS_OFF_GREEN_MAX, QUICK_STABLE_SPREAD);
  assert.equal(HANDS_OFF_AMBER_MAX, DRIFT_MOVE_SPREAD);
});

test('released sticks read green; the meter says unknown until it has enough reports', () => {
  const meter = createHandsOffMeter();
  const levels = feed(meter, { to: 1000 });
  assert.equal(levels[0].level, 'unknown');
  assert.ok(levels.slice(20).every(l => l.level === 'green'), 'one-LSB flicker is not movement');
  assert.equal(meter.level(1000 + 1000), 'unknown', 'no reports for a second: the controller went quiet');
});

// Accettazione WS5: tocchi sceneggiati diventano rossi entro 300 ms.
const TOUCHES = {
  // pollice che spinge in 150 ms fino al 30%
  'thumb push': t0 => t => (t < t0 ? null : { lx: Math.min(1, (t - t0) / 150) * 0.3 }),
  // sfioramento: ±6% a 8 Hz
  'brush': t0 => t => (t < t0 ? null : { ry: 0.06 * Math.sin(2 * Math.PI * 8 * (t - t0) / 1000) }),
  // scatto a gradino (il modello del DualSense virtuale)
  'step': t0 => t => (t < t0 ? null : { rx: 20 * LSB }),
  // presa lenta: 12% in 250 ms sui due assi
  'slow grab': t0 => t => (t < t0 ? null : { lx: Math.min(1, (t - t0) / 250) * 0.12, ly: Math.min(1, (t - t0) / 250) * 0.12 }),
};

test('scripted touches turn the meter red within 300 ms', () => {
  for (const [name, make] of Object.entries(TOUCHES)) {
    for (const t0 of [800, 1203, 2001]) {
      const meter = createHandsOffMeter();
      const levels = feed(meter, { to: t0 + 600, touch: make(t0), seed: t0 });
      assert.ok(levels.filter(l => l.t < t0 && l.t > 100).every(l => l.level === 'green'), `${name}: green before the touch`);
      const red = firstRed(levels, t0);
      assert.ok(red !== null && red - t0 <= 300, `${name} @ ${t0}: red after ${red === null ? 'never' : red - t0} ms`);
    }
  }
});

test('a light tremor is amber, not red; red lingers briefly after the hand leaves, then clears', () => {
  const tremor = createHandsOffMeter();
  const levels = feed(tremor, { to: 1500, touch: t => (t < 500 ? null : { lx: 0.025 * Math.sin(2 * Math.PI * 6 * t / 1000) }) });
  const during = levels.filter(l => l.t > 800).map(l => l.level);
  assert.ok(during.includes('amber'));
  assert.ok(!during.includes('red'), 'a 5% wobble stays under the hand-on-the-stick spread');

  const meter = createHandsOffMeter();
  const touch = t => (t >= 500 && t < 700 ? { lx: 0.3 } : null);
  const after = feed(meter, { to: 2000, touch });
  const releasedRed = after.filter(l => l.t >= 700 && l.level === 'red').map(l => l.t);
  assert.ok(releasedRed.length > 0, 'still red just after release');
  const last = releasedRed.at(-1);
  assert.ok(last <= 700 + 250 + HANDS_OFF_RED_HOLD_MS, `red until ${last}`);
  assert.equal(after.at(-1).level, 'green');
});

test('the renderer touches the DOM only when the level changes', () => {
  const el = { dataset: {}, textContent: '' };
  assert.equal(renderHandsOff(el, 'green'), true);
  assert.equal(el.textContent, HANDS_OFF_LABELS.quick.green);
  assert.equal(renderHandsOff(el, 'green'), false);
  assert.equal(renderHandsOff(el, 'red', HANDS_OFF_LABELS.guided), true);
  assert.equal(el.dataset.level, 'red');
  assert.equal(el.textContent, 'Sticks moving');
});

test('in the page, a touch during Quick turns the meter red from the HID reports', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[0.2, -0.3], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.click('btn-quick');
  await h.advance(400);
  assert.equal(h.$('quick-handsoff').dataset.level, 'green');
  const t0 = clock.now();
  dev.touches.push({ stick: 1, t0, dur: 800, tail: 50, amp: [30, 0] });
  let redAt = null;
  for (let t = 0; t <= 400 && redAt === null; t += 10) {
    await h.advance(10);
    if (h.$('quick-handsoff').dataset.level === 'red') redAt = clock.now() - t0;
  }
  assert.ok(redAt !== null && redAt <= 300, `red after ${redAt} ms`);
  assert.match(h.$('quick-handsoff').textContent, /let go of the sticks/);
  await h.advance(2000);
  assert.equal(h.$('quick-handsoff').dataset.level, 'green', 'back to green once released');
});

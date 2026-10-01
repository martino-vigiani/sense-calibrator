import test from 'node:test';
import assert from 'node:assert/strict';
import { createRangeTracker, createStickRange, pushStick, stickCoverage, stickCoverageThreshold } from '../js/calib/range-coverage.js';
import { rangeProgress, rangeRequirementsHtml } from '../js/ui/range-progress.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

const TAU = 2 * Math.PI;
const req = (view, id) => view.requirements.find(item => item.id === id);

// Snapshot sintetici espliciti: ogni requisito può mancare indipendentemente.
function readyStick(stick, { coverage = 1, turns = 2.5, reverseTurns = 0.5, missingSide = null } = {}) {
  stick.bins.fill(0.7);
  stick.bins.fill(1, 0, Math.round(coverage * stick.p.bins));
  stick.min = { x: -1, y: -1 };
  stick.max = { x: 1, y: 1 };
  if (missingSide === 'up') stick.min.y = -0.899999;
  stick.travel = { pos: (turns - reverseTurns) * TAU, neg: reverseTurns * TAU };
  stick.reversals = reverseTurns > 0 ? 1 : 0;
  return stick;
}

function snapshot(left = {}, right = {}, params = {}) {
  const tracker = createRangeTracker(params);
  readyStick(tracker.left, left);
  readyStick(tracker.right, right);
  return tracker;
}

test('100% coverage and many turns keep reversal visibly pending on each stick', () => {
  const view = rangeProgress(snapshot({ turns: 24, reverseTurns: 0 }, { turns: 24, reverseTurns: 0 }), 40_000);
  assert.equal(view.status.coverage, 1);
  assert.equal(view.status.complete, false);
  assert.equal(view.status.finishAnyway, true);
  assert.equal(view.action, 'reverse');
  assert.match(view.hint, /^Reverse both sticks for at least half a turn/);
  for (const side of ['left', 'right']) {
    assert.deepEqual(view[side].requirements.map(item => item.met), [true, true, true, false]);
    assert.equal(req(view[side], 'reverse').value, '½ turn');
  }
  assert.equal(view.help, '', 'missing reversal never becomes a short-edge diagnosis');
});

test('a finished left stick leaves one clear instruction for the right stick', () => {
  const view = rangeProgress(snapshot({}, { turns: 3, reverseTurns: 0 }));
  assert.equal(view.left.complete, true);
  assert.equal(view.right.complete, false);
  assert.match(view.hint, /^The left stick is complete\. Reverse the right stick/);
});

test('reverse, turns, sides and sector coverage are independent requirements', () => {
  for (const [options, missing, action] of [
    [{ coverage: 0.86, turns: 20 }, 'coverage', 'edge'],
    [{ missingSide: 'up' }, 'sides', 'sides'],
    [{ turns: 1.9 }, 'turns', 'turns'],
    [{ reverseTurns: 0.49 }, 'reverse', 'reverse'],
  ]) {
    const view = rangeProgress(snapshot(options), 2000);
    assert.equal(view.status.complete, false, missing);
    assert.equal(req(view.left, missing).met, false, missing);
    assert.equal(view.action, action, missing);
    assert.ok(view.left.requirements.filter(item => item.id !== missing).every(item => item.met), missing);
  }
});

test('presentation follows exact turn, reversal and coverage boundaries', () => {
  for (const turns of [2 - 1e-7, 2, 2 + 1e-7]) {
    const view = rangeProgress(snapshot({ turns }));
    assert.equal(req(view.left, 'turns').met, turns >= 2, `turns ${turns}`);
  }
  for (const reverseTurns of [0.5 - 1e-7, 0.5, 0.5 + 1e-7]) {
    const view = rangeProgress(snapshot({ reverseTurns }));
    assert.equal(req(view.left, 'reverse').met, reverseTurns >= 0.5, `reverse ${reverseTurns}`);
  }
  // 100 settori permettono il confine esatto 89/90/91% senza arrotondarlo.
  for (const coverage of [0.89, 0.9, 0.91]) {
    const view = rangeProgress(snapshot({ coverage }, {}, { bins: 100 }));
    assert.equal(req(view.left, 'coverage').met, coverage >= 0.9, `coverage ${coverage}`);
    assert.equal(view.status.complete, coverage >= 0.9);
    if (coverage >= 0.9) {
      assert.equal(view.left.areasText, '');
      assert.deepEqual(view.left.shortBins, [], 'a passed check creates no extra 100% requirement');
    }
  }
});

test('short sectors share the coverage threshold unchanged for wide, narrow and unmoved ranges', () => {
  for (const max of [0, 0.49, 0.5, 0.7, 0.99, 1, 1.4]) {
    const stick = createStickRange();
    stick.bins = Array.from({ length: stick.p.bins }, (_, index) => max * index / (stick.p.bins - 1));
    const expected = Math.max(stick.p.okRadius, Math.min(1, max) * stick.p.relThreshold);
    assert.equal(stickCoverageThreshold(stick), expected, `max ${max}`);
    const oldCoverage = max < stick.p.minExtent ? 0 : stick.bins.filter(value => value >= expected).length / stick.p.bins;
    assert.equal(stickCoverage(stick), oldCoverage, `coverage unchanged at max ${max}`);
    const tracker = createRangeTracker();
    tracker.left = stick;
    const view = rangeProgress(tracker);
    assert.deepEqual(view.left.shortBins, stick.bins.flatMap((value, bin) => value < expected ? [bin] : []));
  }
});

test('repeated short sectors offer a movement suggestion without a hardware diagnosis', () => {
  const tracker = snapshot({ coverage: 31 / 36, turns: 24 });
  const early = rangeProgress(tracker, tracker.params.unlockMs - 1);
  const later = rangeProgress(tracker, tracker.params.unlockMs);
  assert.equal(early.help, '');
  assert.match(later.hint, /dashed edge sectors on the left stick/);
  assert.match(later.help, /Slow down and pause gently against the rim/);
  assert.match(later.help, /incomplete finish keeps Write disabled/);
  assert.doesNotMatch(later.help, /broken|worn|fault|sensor|replace/i);
  assert.equal(later.status.complete, false);
  assert.equal(req(later.left, 'coverage').value, '86%');
  assert.equal(later.left.shortBins.length, 5);
});

test('near-center jitter cannot become turns, completed checks or a hardware diagnosis', () => {
  const tracker = createRangeTracker();
  for (let i = 0; i < 5000; i++) {
    const angle = i * 0.09;
    tracker.push({ lx: 0.01 * Math.cos(angle), ly: 0.01 * Math.sin(angle), rx: 0, ry: 0 });
  }
  const view = rangeProgress(tracker, 90_000);
  assert.equal(view.status.canFinish, false);
  assert.equal(view.left.requirements.every(item => !item.met), true);
  assert.equal(view.help, '');
  assert.doesNotMatch(view.hint, /broken|worn|fault|sensor|replace/i);
  const html = rangeRequirementsHtml(view.left);
  assert.equal((html.match(/data-met="false"/g) ?? []).length, 4);
  assert.equal((html.match(/Still needed\./g) ?? []).length, 4, 'pending is explicit text, not color alone');
});

function rotate(dev, from, { sticks = [0, 1], turns = 2.2, dir = 1, period = 1000 } = {}) {
  const dur = turns * period;
  for (const stick of sticks) dev.touches.push({
    stick, t0: from, dur, tail: 1,
    at: (time, axis) => {
      const angle = dir * TAU * (time - from) / period;
      return 127.5 * (axis === 0 ? Math.cos(angle) : Math.sin(angle));
    },
  });
  return from + dur;
}

test('real app keeps Done off at 100% until both sticks reverse, then clears calibration checklist for check step', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { seed: 21, drift: [[0, 0], [0, 0]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  const end = rotate(dev, clock.now() + 10);
  await h.advance(end - clock.now() + 1200);
  assert.equal(h.$('range-pct').textContent, 'Coverage 100%');
  assert.equal(h.$('btn-range-done').disabled, true);
  assert.equal(dev.counts.range, 1);
  assert.match(h.$('range-hint').textContent, /^Reverse both sticks/);
  assert.equal(h.$('range-state-l').textContent, 'In progress');
  const endLeft = rotate(dev, clock.now() + 10, { sticks: [0], turns: 0.7, dir: -1 });
  await h.advance(endLeft - clock.now() + 1200);
  assert.equal(h.$('btn-range-done').disabled, true);
  assert.equal(h.$('range-state-l').textContent, 'Complete');
  assert.equal(h.$('range-state-r').textContent, 'In progress');
  assert.match(h.$('range-hint').textContent, /^The left stick is complete\. Reverse the right stick/);
  const endRight = rotate(dev, clock.now() + 10, { sticks: [1], turns: 0.7, dir: -1 });
  await h.advance(endRight - clock.now() + 300);
  assert.equal(h.$('btn-range-done').disabled, false);
  assert.equal(h.$('btn-range-done').textContent, 'Done');
  assert.equal(h.$('range-state-r').textContent, 'Complete');
  assert.match(h.$('range-hint').textContent, /Both sticks are ready: press Done/);
  await h.run(h.click('btn-range-done'));
  assert.ok(h.peek().rangeCheck);
  assert.equal(h.$('range-requirements-l').hidden, true);
  assert.equal(h.$('range-requirements-r').hidden, true);
  assert.equal(h.$('range-legend').hidden, true);
  assert.equal(h.$('range-help').hidden, true);
  assert.equal(h.$('dial-range-l').getAttribute('aria-label'), 'Left stick range check');
  assert.equal(h.$('dial-range-r').getAttribute('aria-label'), 'Right stick range check');
  assert.equal(h.$('btn-range-done').textContent, 'Skip check');
});

test('completed requirements can update the live instruction inside the one-second throttle', async () => {
  const h = await loadApp();
  // Isola solo la presentazione: fixture pronta meno inversione, poi l'esatto
  // stesso tracker diventa completo 121 ms dopo l'ultimo annuncio.
  h.eval(`rangeSession = { startTs: 0, tracker: createRangeTracker() };
    for (const s of [rangeSession.tracker.left, rangeSession.tracker.right]) {
      s.bins.fill(1); s.min = { x: -1, y: -1 }; s.max = { x: 1, y: 1 };
      s.travel = { pos: 3 * Math.PI * 2, neg: 0 };
    }
    lastMinmax = -Infinity; lastRangeHint = -Infinity; updateRangeUI(1000);`);
  assert.match(h.$('range-hint').textContent, /^Reverse both sticks/);
  h.eval(`for (const s of [rangeSession.tracker.left, rangeSession.tracker.right]) {
      s.travel.neg = Math.PI; s.reversals = 1;
    }
    updateRangeUI(1121);`);
  assert.match(h.$('range-hint').textContent, /Both sticks are ready: press Done/);
});

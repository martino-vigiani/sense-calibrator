import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuick, QUICK_DEFAULTS } from '../js/calib/quick.js';
import { decideBeforeStart } from '../js/calib/quick-policy.js';
import { STICK_LSB, measureOffset, waitForStable } from '../js/calib/sampling.js';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';
import { VClock } from '../ops/sim/vclock.mjs';
import { FakeDualSense } from '../ops/sim/fake-dualsense.mjs';
import { makeSimInstance } from '../ops/sim/harness.mjs';
import { onCommand } from '../ops/sim/scenarios/_hooks.mjs';
import { replayCohort } from '../ops/sim/replay-sequences.mjs';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';

// WS1 quick-safety: una verifica per frame, 12 campioni per commit, nessun
// calibSample dopo un timeout, nessun comando su una partenza già centrata o
// su un controller sostituito. I test girano il VERO runQuick contro il
// DualSense virtuale di ops/sim (risultati "model-verified", non hardware) o
// contro attese sceneggiate, e l'app reale nell'harness DOM-stub.

const LSB = 1; // gli spostamenti del fake sono in LSB del byte di report
const DRIFTING = [[3.2, -0.3], [-0.1, 0.4]]; // stick sinistro ~2.5%
const CENTERED = [[0.2, -0.3], [-0.1, 0.4]];

async function simRun({ drift = DRIFTING, noise = 0.05, bias = [0, 0], schedule = [], params = {}, runOpts = {}, isCurrent, hook, clock = new VClock(), dev } = {}) {
  dev ??= new FakeDualSense({
    clock,
    seed: 5,
    sticks: drift.map((d, i) => ({ drift: d, noise, bias: { axis: 0, B: bias[i] } })),
    fw: { sf: 0, cmdMs: [2, 6] },
    timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    hand: { schedule },
  });
  hook?.(dev, clock);
  const events = [];
  const inst = makeSimInstance(clock, dev, { board: 'TEST', fw: 0 }, params, {
    isCurrent,
    onProgress: e => { if (e.phase) events.push({ t: clock.now(), ...e }); runOpts.onEvent?.(e); },
    runOpts: { ...runOpts, onEvent: undefined },
  });
  const res = await clock.run(inst.run());
  return { res, dev, clock, events, probe: inst.probe, logs: inst.logs };
}
const phases = events => events.map(e => e.phase);
const times = (dev, op) => dev.commandLog.filter(c => c.op === op).map(c => c.t);

// ---------------------------------------------------------------- policy (6)

test('already centered means both sticks at the floor: 1.24 starts still calibrate', () => {
  assert.equal(decideBeforeStart({ beforeWorst: 0.555 }, QUICK_DEFAULTS).skip, true);
  assert.equal(decideBeforeStart({ beforeWorst: 1.19 }, QUICK_DEFAULTS).skip, true);
  assert.equal(decideBeforeStart({ beforeWorst: 1.24 }, QUICK_DEFAULTS).skip, false);
  assert.equal(decideBeforeStart({ beforeWorst: 1.2 }, QUICK_DEFAULTS).skip, false);
  assert.equal(decideBeforeStart({ beforeWorst: NaN }, QUICK_DEFAULTS).skip, false);
});

test('the real-sequence replay skips exactly the starts below 1.2 and never a 1.24 start', () => {
  const pair = w => ({ off: [w, 0.555], noise: [0, 0] });
  const rows = [0.555, 0.555, 1.19, 1.24, 1.24, 2, 7].map(w => ({ t: 'x', before: pair(w), after: pair(0.555), passes: [0.55] }));
  const { summary } = replayCohort(rows, QUICK_DEFAULTS);
  assert.equal(summary.skippedBeforeStart, 3);
  assert.equal(summary.skippedAtOrAboveOkMax, 0);
  assert.equal(summary.startsAtOneStep, 2);
});

test('an already-centered start sends no command; force calibrates anyway', async () => {
  const skipped = await simRun({ drift: CENTERED });
  assert.equal(skipped.res.outcome, 'already-centered');
  assert.equal(skipped.res.committed, false);
  assert.equal(skipped.res.session.aborted, 'already-centered');
  assert.equal(skipped.res.session.after, null, 'never uploaded as a v1 session');
  assert.deepEqual([skipped.dev.counts.begin, skipped.dev.counts.sample, skipped.dev.counts.end], [0, 0, 0]);

  const forced = await simRun({ drift: CENTERED, runOpts: { force: true } });
  assert.equal(forced.res.outcome, 'centered');
  assert.equal(forced.dev.counts.begin, 1);
  assert.equal(forced.dev.counts.sample, 12);
});

// ---------------------------------------------------------------- campionamento (2)

function scriptedSource() {
  const listeners = new Set();
  const source = {
    sticks: { lx: 0, ly: 0, rx: 0, ry: 0 },
    t: 0,
    now: () => source.t,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(ms, sticks) {
      for (const end = source.t + ms; source.t < end; source.t += 4) {
        if (sticks) source.sticks = sticks;
        for (const fn of listeners) fn();
      }
    },
    listeners,
  };
  return source;
}
const idleClock = { setTimeout: () => 1, clearTimeout: () => {} };

test('waitForStable returns the window mean and rejects a steady window away from the reference', async () => {
  const ref = { lx: 0.02, ly: 0, rx: 0, ry: 0 };
  // stabile e vicino: 3 LSB dal riferimento
  let source = scriptedSource();
  let promise = waitForStable(source, idleClock, { near: ref, tol: 4 * STICK_LSB });
  source.emit(400, { lx: 0.02 + 3 * STICK_LSB, ly: 0, rx: 0, ry: 0 });
  const ok = await promise;
  assert.ok(ok && Math.abs(ok.center.lx - (0.02 + 3 * STICK_LSB)) < 1e-9);

  // stabile (spread 0) ma a 6 LSB: mai accettato, scade
  source = scriptedSource();
  promise = waitForStable(source, idleClock, { near: ref, tol: 4 * STICK_LSB, timeoutMs: 1000 });
  source.emit(1100, { lx: 0.02 + 6 * STICK_LSB, ly: 0, rx: 0, ry: 0 });
  assert.equal(await promise, false);
  assert.equal(source.listeners.size, 0);

  // pollice sul bordo (spread 0, 80%): respinto dal raggio di plausibilità
  source = scriptedSource();
  promise = waitForStable(source, idleClock, { maxRadius: 0.5, timeoutMs: 1000 });
  source.emit(1100, { lx: 0.8, ly: 0, rx: 0, ry: 0 });
  assert.equal(await promise, false);

  // Cancel interrompe l'attesa al report successivo
  source = scriptedSource();
  let cancelled = false;
  promise = waitForStable(source, idleClock, { isCancelled: () => cancelled, timeoutMs: 60_000 });
  source.emit(100, { lx: 0.3, ly: 0, rx: 0, ry: 0.3 });
  cancelled = true;
  source.emit(8);
  assert.equal(await promise, false);
  assert.equal(source.listeners.size, 0);
});

test('measureOffset reports the stable fraction of its samples', async () => {
  const source = scriptedSource();
  let finish;
  const promise = measureOffset(source, { sleep: () => new Promise(r => { finish = r; }) }, 1000);
  source.emit(1000, { lx: 0.01, ly: 0, rx: 0, ry: 0 });
  finish();
  const r = await promise;
  assert.equal(r.stableFraction, 1);
});

// ---------------------------------------------------------------- passata (1)(2)(3)

test('a thumb that lands on the rim right after calibBegin never becomes the in-session reference', async () => {
  let t0 = null;
  const { res, dev } = await simRun({
    hook: (d, clock) => onCommand(d, 'begin', 1, () => {
      t0 = clock.now() + 20;
      d.touches.push({ stick: 0, t0, dur: 3000, tail: 100, amp: [100 * LSB, 0] });
    }),
  });
  assert.equal(res.outcome, 'centered');
  assert.equal(dev.counts.sample, 12);
  assert.ok(times(dev, 'sample').every(t => t > t0 + 3000), 'no sample while the thumb pressed the rim');
});

test('a hand that arrives mid-pass pauses sampling: no sample until it leaves, and never after a timeout', async () => {
  let t0 = null;
  const { res, dev, probe } = await simRun({
    hook: (d, clock) => onCommand(d, 'sample', 3, () => {
      t0 = clock.now() + 10;
      // 8 LSB (6%): dentro il raggio del 15%, stabile, ma lontano dal riferimento
      d.touches.push({ stick: 0, t0, dur: 7000, tail: 100, amp: [8 * LSB, 0] });
    }),
  });
  assert.equal(res.outcome, 'centered');
  assert.equal(dev.counts.sample, 12);
  assert.equal(dev.counts.end, 1);
  const held = times(dev, 'sample').filter(t => t > t0 + 20 && t < t0 + 7000);
  assert.deepEqual(held, [], 'no sample while the hand was on the stick');
  assert.ok(res.session.unstableEvents >= 1, 'the 5 s wait timed out at least once');
  assert.equal(probe.samplesAfterTimeout, 0);
});

test('a pass that cannot collect 12 samples is abandoned without calibEnd and needs a power cycle', async () => {
  const { res, dev, events, probe, clock } = await simRun({
    hook: (d, clk) => onCommand(d, 'sample', 2, () => {
      d.touches.push({ stick: 0, t0: clk.now() + 10, dur: 120_000, tail: 100, amp: [8 * LSB, 0] });
    }),
  });
  assert.equal(res.outcome, 'stalled');
  assert.equal(res.needsPowerCycle, true);
  assert.equal(res.committed, true, 'the open session leaves the RAM state unknown: unsaved');
  assert.equal(res.session.aborted, 'stalled');
  assert.deepEqual([dev.counts.begin, dev.counts.end], [1, 0], 'never calibEnd with fewer than 12 samples');
  assert.ok(dev.counts.sample < 12);
  assert.equal(probe.samplesAfterTimeout, 0);
  const begin = times(dev, 'begin')[0];
  const prompt = events.find(e => e.phase === 'stalled');
  assert.ok(prompt && prompt.t - begin >= QUICK_DEFAULTS.stallMs && prompt.t - begin < QUICK_DEFAULTS.stallMs + 6000);
  assert.ok(clock.now() - begin >= QUICK_DEFAULTS.stallMs + QUICK_DEFAULTS.stallGraceMs);
  assert.ok(clock.now() - begin < QUICK_DEFAULTS.stallMs + QUICK_DEFAULTS.stallGraceMs + 6000);
});

test('Cancel during the stall prompt abandons the pass at once', async () => {
  let cancelled = false;
  const { res, dev, events, clock } = await simRun({
    hook: (d, clk) => onCommand(d, 'sample', 2, () => {
      d.touches.push({ stick: 0, t0: clk.now() + 10, dur: 120_000, tail: 100, amp: [8 * LSB, 0] });
    }),
    runOpts: { isCancelled: () => cancelled, onEvent: e => { if (e.phase === 'stalled') cancelled = true; } },
  });
  assert.equal(res.outcome, 'stalled');
  assert.equal(dev.counts.end, 0);
  const prompt = events.find(e => e.phase === 'stalled');
  assert.ok(clock.now() - prompt.t < 100, 'aborted on the next report');
});

test('letting go after the stall prompt resumes the pass and commits 12 samples', async () => {
  const { res, dev, events } = await simRun({
    hook: (d, clk) => onCommand(d, 'sample', 2, () => {
      d.touches.push({ stick: 0, t0: clk.now() + 10, dur: 20_000, tail: 100, amp: [8 * LSB, 0] });
    }),
  });
  assert.equal(res.outcome, 'centered');
  assert.ok(res.session.unstableEvents > 0);
  assert.deepEqual([dev.counts.begin, dev.counts.sample, dev.counts.end], [1, 12, 1]);
  const p = phases(events);
  assert.ok(p.indexOf('stalled') >= 0 && p.indexOf('resumed') > p.indexOf('stalled'));
});

// ---------------------------------------------------------------- verifica (4)(5)

test('a hand resting beyond the ceiling during verify is waited out, not taken for the calibration', async () => {
  const { res, dev } = await simRun({
    hook: (d, clock) => onCommand(d, 'end', 1, () => {
      d.touches.push({ stick: 0, t0: clock.now() + 30, dur: 3000, tail: 100, amp: [60 * LSB, 0] });
    }),
  });
  assert.equal(res.outcome, 'centered');
  assert.ok(res.worst < 1.2);
  assert.equal(dev.counts.end, 1);
});

test('a verified residual beyond 15% ends the loop as catastrophic; the opt-in recovery pass is gated by the hold', async () => {
  const clock = new VClock();
  // Errore di cattura del firmware di 30 LSB (~24%): il centro nuovo è sbagliato.
  const first = await simRun({ clock, bias: [30, 0] });
  assert.equal(first.res.outcome, 'catastrophic');
  assert.ok(first.res.worst >= 15);
  assert.equal(first.res.session.passes.length, 1, 'no automatic recovery pass');
  assert.equal(first.dev.counts.begin, 1);
  assert.ok(first.res.session.after, 'the result stays visible (and in telemetry)');

  const recovery = await simRun({ clock, dev: first.dev, params: { maxPasses: 1 }, runOpts: { force: true } });
  assert.equal(recovery.res.outcome, 'preflight', 'the stick reads beyond 15%: no command');
  assert.equal(first.dev.counts.begin, 1);
});

// ---------------------------------------------------------------- attese sceneggiate

const drifting = { left: { offset: 2.4, noise: 0.2 }, right: { offset: 0.6, noise: 0.2 } };
const good = { left: { offset: 0.5, noise: 0.2 }, right: { offset: 0.6, noise: 0.2 } };
const middling = { left: { offset: 2.0, noise: 0.2 }, right: { offset: 0.6, noise: 0.2 } };

function scripted({ holds = [], verifies = [], goneWhen = () => false } = {}) {
  const events = [];
  let holdIndex = 0;
  let verifyIndex = 0;
  const controller = {
    calibBegin: async () => events.push('begin'),
    calibSample: async () => events.push('sample'),
    calibEnd: async () => events.push('end'),
  };
  const sampler = {
    waitForStable: async options => {
      if (options.requireCentered) {
        events.push('hold');
        return holds[holdIndex++] ?? true;
      }
      return { center: { lx: 0, ly: 0, rx: 0, ry: 0 } };
    },
    measureOffset: async (ms, options) => {
      if (options?.requireCentered) return drifting;
      events.push('verify');
      return verifies.length ? verifies[Math.min(verifyIndex++, verifies.length - 1)] : good;
    },
  };
  const run = (extra = {}) => runQuick({
    controller, sampler, clock: { sleep: async () => {} },
    isCurrent: () => !goneWhen(events),
    ...extra,
  });
  return { run, events };
}

test('an unverified pass is excluded from bestWorst, cannot converge, and the next pass waits for the hold', async () => {
  const h = scripted({ verifies: [null, null, good] });
  const { session, outcome, bestWorst } = await h.run();
  assert.equal(outcome, 'centered');
  assert.deepEqual(session.passes, [null, 0.6]);
  assert.equal(bestWorst, 0.6);
  assert.equal(session.verifyFailures, 1);
  const secondBegin = h.events.lastIndexOf('begin');
  assert.equal(h.events[secondBegin - 1], 'hold', 'the step-1 hold runs right before the next calibBegin');
  // tra i due tentativi di verifica c'è una tenuta
  const firstEnd = h.events.indexOf('end');
  assert.deepEqual(h.events.slice(firstEnd + 1, firstEnd + 4), ['verify', 'hold', 'verify']);
});

test('a failed hold before pass 2 sends nothing more and reports the applied pass-1 result', async () => {
  // tenute: preflight, passata 1, passata 2 (fallisce)
  const h = scripted({ holds: [true, true, false], verifies: [middling] });
  const { session, outcome, committed, worst } = await h.run();
  assert.equal(outcome, 'moved');
  assert.equal(committed, true);
  assert.equal(session.aborted, 'moved');
  assert.equal(h.events.filter(e => e === 'begin').length, 1);
  assert.equal(worst, 2.0);
  assert.deepEqual(session.after.off, [2, 0.6]);
});

test('a controller that goes away mid-pass gets no further command', async () => {
  const samples = events => events.filter(e => e === 'sample').length;
  for (const [goneWhen, committed, label] of [
    [events => samples(events) >= 3, false, 'during pass 1 sampling'],
    [events => events.includes('end') && samples(events) >= 15, true, 'during pass 2 sampling'],
  ]) {
    const h = scripted({ verifies: [middling, middling, middling, middling], goneWhen });
    const res = await h.run();
    assert.equal(res.outcome, 'disconnected', label);
    assert.equal(res.session.aborted, 'disconnected');
    assert.equal(res.committed, committed, label);
    const gone = h.events.findIndex((e, i) => goneWhen(h.events.slice(0, i + 1)));
    assert.deepEqual(h.events.slice(gone + 1).filter(e => ['begin', 'sample', 'end'].includes(e)), [], label);
  }
});

test('a noisy start prompts to release the sticks without touching the adaptive gate', async () => {
  const noisy = { left: { offset: 2.4, noise: 3.2 }, right: { offset: 0.6, noise: 0.2 } };
  const phasesSeen = [];
  const controller = { calibBegin: async () => {}, calibSample: async () => {}, calibEnd: async () => {} };
  const res = await runQuick({
    controller,
    clock: { sleep: async () => {} },
    sampler: {
      waitForStable: async () => ({ center: { lx: 0, ly: 0, rx: 0, ry: 0 } }),
      measureOffset: async (ms, o) => (o?.requireCentered ? noisy : good),
    },
    onProgress: e => e.phase && phasesSeen.push(e.phase),
  });
  assert.ok(phasesSeen.includes('noisy'));
  // stesso gate di prima: rumore 3.2% × 2.5, limitato a DRIFT_MOVE_SPREAD
  assert.equal(res.session.gateBase, +Math.min(DRIFT_MOVE_SPREAD, 0.032 * QUICK_DEFAULTS.gateNoiseFactor).toFixed(3));
});

// ---------------------------------------------------------------- app reale

async function appWith({ drift = DRIFTING, hook } = {}) {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift });
  hook?.(dev, clock);
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  return { h, dev };
}

test('app: an already-centered start keeps the modal open, sends nothing, and offers Calibrate anyway', async () => {
  const { h, dev } = await appWith({ drift: CENTERED });
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.equal(dev.counts.begin + dev.counts.sample + dev.counts.end, 0);
  assert.equal(h.visible('modal-quick'), true);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate anyway');
  assert.match(h.$('quick-msg').innerHTML, /already centered/);
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.peek().busy, false);
  await h.run(h.click('btn-quick-go'));
  assert.equal(dev.counts.begin, 1);
  assert.equal(h.peek().unsaved, true);
});

test('app: a stalled pass leaves unsaved set and blocks every command until the controller is reconnected', async () => {
  const { h, dev } = await appWith({
    hook: (d, clock) => onCommand(d, 'sample', 2, () => {
      d.touches.push({ stick: 0, t0: clock.now() + 10, dur: 600_000, tail: 100, amp: [8, 0] });
    }),
  });
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(22_000);
  assert.match(h.$('quick-msg').innerHTML, /not settling/);
  assert.equal(h.$('btn-quick-cancel').disabled, false, 'Cancel is offered during the stall');
  await h.click('btn-quick-cancel');
  await h.run(running);
  assert.equal(dev.counts.end, 0);
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.peek().busy, false);
  assert.match(h.$('calib-outcome').innerHTML, /never settled/);
  assert.equal(h.$('btn-flash').disabled, true, 'Write is off until the controller is power-cycled');
  await h.advance(1000); // animazione di chiusura del modale
  assert.equal(h.visible('modal-quick'), false);
  const sent = dev.commandLog.length;
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), false, 'Quick does not open');
  await h.click('btn-wizard');
  await h.run(h.click('btn-range'));
  await h.run(h.click('btn-flash-go'));
  assert.equal(dev.commandLog.length, sent, 'no command reaches the controller');
  assert.equal(h.peek().busy, false);
});

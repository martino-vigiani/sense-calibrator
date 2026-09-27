import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuick, QUICK_DEFAULTS } from '../js/calib/quick.js';
import { DS5 } from '../js/ds5.js';
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

test('audit 09: a report gap cannot complete a 300 ms hold or a stale offset measurement', async () => {
  const source = scriptedSource();
  let resolved = false;
  const hold = waitForStable(source, idleClock, { holdMs: 300, timeoutMs: 1000 });
  hold.then(() => { resolved = true; });
  source.emit(36, { lx: 0, ly: 0, rx: 0, ry: 0 });
  source.t = 240;
  source.emit(4);
  await Promise.resolve();
  assert.equal(resolved, false, 'a 208 ms gap cannot make nine fresh reports a hold');
  source.t = 1100;
  source.emit(4);
  assert.equal(await hold, false);

  const measureSource = scriptedSource();
  let finish;
  const measurement = measureOffset(measureSource, { sleep: () => new Promise(r => { finish = r; }) }, 1000);
  measureSource.emit(300, { lx: 0, ly: 0, rx: 0, ry: 0 });
  measureSource.t = 1000;
  finish();
  assert.equal(await measurement, null, 'readings from the first 300 ms cannot represent 1 s');

  const clock = new VClock();
  const dev = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  h.eval('startDriftTest()');
  await h.advance(300);
  dev.stopped = true;
  await h.advance(4000);
  assert.match(h.$('drift-status').textContent, /Interrupted/i);
});

test('B2: a moving window followed by 300 ms stillness completes without a second hold', async () => {
  const source = scriptedSource();
  let doneAt = null;
  const hold = waitForStable(source, idleClock, { holdMs: 300, timeoutMs: 2000 });
  hold.then(() => { doneAt = source.t; });
  for (; source.t < 1700 && doneAt === null; source.t += 4) {
    source.sticks = { lx: source.t < 1000 ? (source.t % 8 ? 0.2 : -0.2) : 0, ly: 0, rx: 0, ry: 0 };
    for (const fn of [...source.listeners]) fn();
    await Promise.resolve();
  }
  assert.ok(await hold);
  assert.ok(doneAt >= 1290 && doneAt <= 1320, `hold ended at ${doneAt} ms`);
});

test('N1: one report gap restarts an offset window, with a finite retry budget', async () => {
  const source = scriptedSource();
  const sleepers = [];
  const measurement = measureOffset(source, { sleep: () => new Promise(r => sleepers.push(r)) }, 1000);
  source.emit(400, { lx: 0.02, ly: 0, rx: 0, ry: 0 });
  source.t += 200;
  source.emit(400);
  sleepers.shift()();
  await Promise.resolve();
  assert.equal(sleepers.length, 1, 'one gap starts another full window');
  source.emit(1000);
  sleepers.shift()();
  const result = await measurement;
  assert.ok(result && result.left.offset > 1.5, 'the fresh full window is measured');
  assert.equal(source.listeners.size, 0, 'no reports sampled after the window expires');
});

test('N1: a gap on the last retry cannot validate its trailing partial window', async () => {
  let wall = 0, reportTime = 0;
  const listeners = new Set();
  const sleepers = [];
  const source = {
    sticks: { lx: 0.02, ly: 0, rx: 0, ry: 0 },
    now: () => wall,
    get reportTime() { return reportTime; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  const emit = t => {
    wall = t;
    reportTime = t - 20; // report HID arrivato 20 ms prima del callback
    for (const fn of [...listeners]) fn();
  };
  const measurement = measureOffset(source, { sleep: () => new Promise(r => sleepers.push(r)) }, 1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const start = wall;
    emit(start);
    emit(start + 101); // gap reale: nessun report per oltre 100 ms
    for (let t = start + 105; t <= start + 1005; t += 4) emit(t);
    sleepers.shift()();
    await Promise.resolve();
  }
  assert.equal(await measurement, null);
  assert.equal(listeners.size, 0);
});

test('N1: report event time keeps a main-thread delay from looking like a device gap', async () => {
  let handledAt = 0, reportAt = 0;
  const listeners = new Set();
  const source = { sticks: { lx: 0, ly: 0, rx: 0, ry: 0 }, now: () => handledAt,
    get reportTime() { return reportAt; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  let finished = false;
  const hold = waitForStable(source, idleClock, { holdMs: 300, timeoutMs: 2000 });
  hold.then(() => { finished = true; });
  for (let i = 0; i <= 76 && !finished; i++) {
    reportAt = i * 4;
    handledAt = reportAt + (i >= 25 ? 200 : 0);
    for (const fn of [...listeners]) fn();
    await Promise.resolve();
  }
  assert.ok(await hold);
  assert.equal(listeners.size, 0);
});

test('N1: a single HID gap restarts Quick startup and drift-test windows', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: DRIFTING });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  h.eval('startDriftTest()');
  await h.advance(800);
  dev.stopped = true;
  await h.advance(200);
  dev.stopped = false; dev.schedule();
  await h.advance(3400);
  assert.ok(h.peek().lastDriftResult, 'a fresh full drift window was measured');
  assert.doesNotMatch(h.$('drift-status').textContent, /Interrupted/);

  await h.click('btn-quick');
  const go = h.click('btn-quick-go');
  await h.advance(700);
  dev.stopped = true;
  await h.advance(200);
  dev.stopped = false; dev.schedule();
  await h.run(go);
  assert.ok(dev.counts.begin >= 1, 'the startup measurement restarted and calibration began');
});

test('N1: the app forwards a plausible HID event timestamp to the sampler', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  const reportAt = clock.now() - 40;
  h.eval(`onInputReport({ reportId: 1, data: new DataView(new Uint8Array(64).buffer), timeStamp: ${reportAt} })`);
  assert.equal(h.eval('lastStickReportAt'), reportAt);
});

test('audit 08: a small quiet minority cannot verify a mostly moving Quick result', async () => {
  const quietMinority = {
    left: { offset: 0.55, noise: 0, x: 0, y: 0 },
    right: { offset: 0.55, noise: 0, x: 0, y: 0 },
    stableFraction: 0.17,
  };
  const h = scripted({ verifies: [quietMinority] });
  const res = await h.run({ params: { maxPasses: 1, verifyAttempts: 1 } });
  assert.equal(h.events.filter(e => e === 'end').length, 1);
  assert.equal(res.outcome, 'unverified');
  assert.equal(res.session.passXY[0], null);
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
  assert.equal(res.committed, false, 'opening a session is not a commit');
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

test('audit 15: first-pass stall reports no commit while retaining the power-cycle lock', async () => {
  const { res, dev } = await simRun({
    hook: (d, clk) => onCommand(d, 'sample', 2, () => {
      d.touches.push({ stick: 0, t0: clk.now() + 10, dur: 120_000, tail: 100, amp: [8, 0] });
    }),
  });
  assert.equal(res.outcome, 'stalled');
  assert.equal(dev.counts.end, 0);
  assert.equal(res.committed, false);
  assert.equal(res.committedBefore, false);
  assert.equal(res.needsPowerCycle, true);
});

test('B1: Quick keeps the worst-stick verdict when the other stick worsens below the starting worst', async () => {
  const h = scripted({ verifies: [{
    left: { offset: 0.55, noise: 0.2, x: 0, y: 0 },
    right: { offset: 1.8, noise: 0.2, x: 0.018, y: 0 },
    stableFraction: 1,
  }] });
  const res = await h.run({ params: { maxPasses: 1 } });
  assert.equal(res.beforeWorst, 2.4);
  assert.equal(res.worst, 1.8);
  assert.equal(res.outcome, 'residual');
});

test('N2: an unstable final Quick measurement above 15% remains catastrophic', async () => {
  const dangerous = { left: { offset: 22, noise: 8, x: 0.22, y: 0 },
    right: { offset: 0.6, noise: 0.2, x: 0, y: 0 }, stableFraction: 0.1 };
  const h = scripted({ verifies: [dangerous, dangerous] });
  const res = await h.run({ params: { maxPasses: 1, verifyAttempts: 2 } });
  assert.equal(res.outcome, 'catastrophic');
  assert.ok(res.worst >= 15);
  assert.equal(h.events.filter(e => e === 'end').length, 1);
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

test('an unverified Quick pass keeps a null axis slot before the next measured pass', async () => {
  // Regressione telemetry v2: senza la posizione nulla, gli assi della seconda
  // verifica verrebbero attribuiti alla prima passata non verificata.
  const measured = {
    left: { offset: 2, noise: 0.2, x: 0.02, y: -0.01 },
    right: { offset: 0.6, noise: 0.2, x: -0.006, y: 0 },
  };
  const h = scripted({ verifies: [null, null, measured] });

  const { session } = await h.run({ params: { maxPasses: 2 } });

  assert.deepEqual(session.passes, [null, 2], 'the first verification has no trusted radius');
  assert.deepEqual(session.passXY, [null, [[2, -1], [-0.6, 0]]], 'axis readings stay aligned to pass 2');
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

test('app: a first-pass stall leaves no commit and blocks every command until a power cycle', async () => {
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
  assert.equal(h.peek().unsaved, false, 'no calibEnd or repair commit occurred');
  assert.equal(h.peek().busy, false);
  assert.match(h.$('calib-outcome').innerHTML, /never settled/);
  assert.equal(h.$('btn-flash').disabled, true, 'Write is off until the controller is power-cycled');
  await h.advance(1000); // animazione di chiusura del modale
  assert.equal(h.visible('modal-quick'), false);
  const sent = dev.commandLog.length;
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), false, 'Quick does not open');
  await h.click('btn-wizard');
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await h.run(h.click('btn-flash-go'));
  assert.equal(dev.commandLog.length, sent, 'no command reaches the controller');
  assert.equal(h.peek().busy, false);
});

// ------------------------------------------- sessione aperta e commit (review)

// Dispositivo WebHID sceneggiato per il VERO DS5: `reply(op)` dà i 4 byte di
// 0x83 per l'ultimo comando 0x82 (op 1 begin, 2 end, 3 sample).
class ScriptedHid {
  constructor(clock, reply) {
    this.clock = clock;
    this.opened = true;
    this.collections = [{ inputReports: [{ reportId: 1 }], featureReports: [] }];
    this.sent = [];
    this.reply = reply;
  }
  sendFeatureReport(id, buf) { this.sent.push({ id, bytes: [...buf] }); return new Promise(r => this.clock.setTimeout(r, 2)); }
  receiveFeatureReport() {
    const b = new Uint8Array(63);
    b.set(this.reply(this.sent.at(-1).bytes[0]));
    return new Promise(r => this.clock.setTimeout(() => r(new DataView(b.buffer)), 3));
  }
}
const REST = { center: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } } };
const DRIFTING_RESULT = { left: { offset: 5, noise: 0.2, x: 0.05, y: 0 }, right: { offset: 0.6, noise: 0.2, x: 0.006, y: 0 } };
async function scriptedRun(reply) {
  const clock = new VClock();
  const dev = new ScriptedHid(clock, reply);
  const ds5 = new DS5(dev, null, { timers: clock });
  const phasesSeen = [];
  const res = await clock.run(runQuick({
    controller: ds5,
    clock: { sleep: ms => new Promise(r => clock.setTimeout(r, ms)) },
    onProgress: e => { if (e.phase) phasesSeen.push(e.phase); },
    sampler: { waitForStable: async () => REST, measureOffset: async () => DRIFTING_RESULT },
  }));
  const ends = dev.sent.filter(s => s.id === 0x82 && s.bytes[0] === 2).length;
  return { res, ends, phasesSeen };
}

test('a calibBegin repair that committed makes a later in-pass error committed, with a power cycle', async () => {
  let begins = 0;
  const { res, ends, phasesSeen } = await scriptedRun(op => {
    if (op === 1) return ++begins === 1 ? [0x83, 0, 0, 0] : [0x83, 1, 1, 1]; // sessione rimasta aperta
    if (op === 2) return [0x83, 1, 1, 2]; // calibEnd di riparazione: COMMIT
    return [0x83, 1, 1, 3]; // calibSample rifiutato
  });
  assert.equal(ends, 1, 'only the repair calibEnd');
  assert.equal(res.outcome, 'error');
  assert.equal(res.committed, true, 'the repair calibEnd wrote RAM');
  assert.equal(res.needsPowerCycle, true, 'the second session is still open');
  assert.ok(phasesSeen.includes('committed'), 'the page is told at once');
});

test('an HID error inside an open session needs a power cycle but is not a commit', async () => {
  const { res, ends } = await scriptedRun(op => (op === 1 ? [0x83, 1, 1, 1] : [0x83, 1, 1, 3]));
  assert.equal(ends, 0);
  assert.equal(res.outcome, 'error');
  assert.equal(res.committed, false);
  assert.equal(res.needsPowerCycle, true);
});

test('a refused begin and malformed repair reply keep the possible commit and open-session lock', async () => {
  const { res } = await scriptedRun(() => [0x83, 0, 0, 0]); // begin rifiutato due volte, riparazione rifiutata
  assert.equal(res.outcome, 'error');
  assert.equal(res.committed, true, 'the malformed repair reply follows a possible calibEnd commit');
  assert.equal(res.needsPowerCycle, true);
});

test('app: an HID error mid-pass blocks every command until a power cycle and never says nothing changed', async () => {
  const clock = new VClock();
  let n = 0;
  const faults = [({ op }) => (op === 'sample' && ++n === 5 ? new Error('NotAllowedError: Failed to write the feature report.') : null)];
  const dev = makeDevice(clock, { drift: [[6, -3], [-0.1, 0.4]], faults });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  await h.advance(1500);
  assert.deepEqual([dev.counts.begin, dev.counts.sample, dev.counts.end], [1, 4, 0]);
  assert.equal(h.peek().unsaved, false, 'an open session is not a commit');
  assert.equal(h.$('btn-flash').disabled, true);
  const panel = h.$('calib-outcome').innerHTML;
  assert.doesNotMatch(panel, /Nothing was changed/);
  assert.match(panel, /left mid-calibration/);
  const sent = dev.commandLog.length;
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), false, 'Quick refuses until the controller is power-cycled');
  await h.click('btn-wizard');
  assert.equal(h.visible('modal-wizard'), false);
  assert.equal(dev.commandLog.length, sent);
});

test('app: unsaved is raised as soon as a Quick pass commits, so an unplug in pass 2 still warns', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[6, -3], [-0.1, 0.4]], sf: 1.5 });
  const session = new Map();
  const h = await loadApp({ clock, authorized: [dev], session });
  await h.advance(5000);
  let unsavedInPass2 = null;
  onCommand(dev, 'begin', 2, () => {
    unsavedInPass2 = h.peek().unsaved;
    clock.setTimeout(() => { dev.unplug(); h.hid.fire('disconnect', dev); }, 50);
  });
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  await h.advance(2000);
  assert.equal(dev.counts.end, 1);
  assert.equal(unsavedInPass2, true, 'unsaved during pass 2');
  assert.equal(session.get('sense-unsaved-in-tab'), '1', 'the tab flag survives a reload');
  assert.ok(h.toasts().some(t => /never written to memory/.test(t)), 'the unsaved-on-exit notice is shown');
});

test('app: a calibEnd that never answers shows the poisoned copy, not an earlier pass or a raw HID message', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[6, -3], [-0.1, 0.4]] });
  const send = dev.sendFeatureReport.bind(dev);
  dev.sendFeatureReport = (id, buf) => (id === 0x82 && buf[0] === 2 && buf[2] === 1 ? new Promise(() => {}) : send(id, buf));
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  await h.advance(1500);
  const panel = h.$('calib-outcome').innerHTML;
  assert.match(panel, /stopped responding/);
  assert.match(panel, /may or may not have been applied/);
  assert.doesNotMatch(panel, /earlier pass|sendFeatureReport|timed out|Restart|save/i);
  assert.equal(h.peek().unsaved, true, 'a timed-out commit may have landed');
  assert.equal(h.$('btn-flash').disabled, true);
});

// Review finding: una preflight fallita su uno stick che RIPOSA oltre il 15%
// (Severe/Pinned all'ultimo test drift) non è una mano. Niente "Stick held",
// il testo lo dice per primo e il bottone porta a Guided. Model-verified.
test('a stick resting past the Quick radius is routed to Guided, not told to let go', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[25, 0], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(6000);
  assert.equal(h.eval("stickTier(lastDriftResult, 'left')?.id"), 'guided-only');
  await h.click('btn-quick');
  const go = h.click('btn-quick-go');
  await h.advance(20_000);
  await h.run(go);
  assert.equal(dev.counts.begin, 0, 'nothing sent');
  const msg = h.$('quick-msg').innerHTML;
  assert.match(msg, /^Calibration has not started\. <b>The left stick rests too far off-center for Quick calibration/);
  assert.doesNotMatch(msg, /Release both sticks/);
  assert.equal(h.eval('quickHoldKnown'), false, 'the meter is not forced to "Stick held"');
  assert.equal(h.$('btn-quick-go').textContent, 'Guided calibration');
  await h.run(h.click('btn-quick-go'));
  await h.advance(500);
  assert.equal(h.visible('modal-wizard'), true, 'the main button opens Guided');
  assert.equal(dev.counts.begin, 0);
});

test('a preflight failure with no drift-test evidence of a resting offset still says "Release both sticks"', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[0.2, -0.3], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(6000);
  dev.touches.push({ stick: 0, t0: clock.now(), dur: 60_000, tail: 100, amp: [30, 0] });
  await h.click('btn-quick');
  const go = h.click('btn-quick-go');
  await h.advance(20_000);
  await h.run(go);
  assert.match(h.$('quick-msg').innerHTML, /Release both sticks/);
  assert.equal(h.eval('quickHoldKnown'), true);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now');
});

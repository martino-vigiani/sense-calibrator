import test from 'node:test';
import assert from 'node:assert/strict';
import { runQuick } from '../js/calib/quick.js';
import { measureOffset, waitForStable } from '../js/calib/sampling.js';
import { QUICK_CENTER_RADIUS } from '../js/quick-center-guard.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

// Esegue il vero runQuick (js/calib/quick.js) con attese sceneggiate: niente
// browser, controller fisico o attese di wall clock. La UI del prompt bloccato
// si verifica sull'app reale nell'harness DOM-stub.
const result = { left: { offset: 0.5, noise: 0.2 }, right: { offset: 0.6, noise: 0.2 } };
// Baseline con drift vero: sotto 1.2% la partenza è "già centrata" e non parte
// alcun comando (WS1), quindi il percorso di calibrazione va provato da qui.
const drifting = { left: { offset: 2.4, noise: 0.2 }, right: { offset: 0.6, noise: 0.2 } };

function quickHarness({ holds = [true, true], baseline = drifting, disconnectAtHold = -1 } = {}) {
  const events = [];
  let holdIndex = 0;
  let current = true;
  const controller = {
    calibBegin: async () => events.push('begin'),
    calibSample: async () => events.push('sample'),
    calibEnd: async () => events.push('end'),
  };
  const sampler = {
    waitForStable: async options => {
      const index = holdIndex++;
      events.push({ type: 'hold', centered: options.requireCentered === true });
      if (index === disconnectAtHold) current = false;
      return holds[index] ?? true;
    },
    measureOffset: async (ms, options) => {
      events.push({ type: 'measure', centered: options?.requireCentered === true });
      return options?.requireCentered ? baseline : result;
    },
  };
  const run = () => runQuick({
    controller,
    sampler,
    clock: { sleep: async () => {} },
    isCurrent: () => current,
  });
  return { run, events };
}

test('failed initial/final preflight, invalid baseline and disconnect never send calibration commands', async () => {
  for (const scenario of [
    { holds: [false] },
    { holds: [true, false] },
    { baseline: null },
    { disconnectAtHold: 0 },
    { disconnectAtHold: 1 },
  ]) {
    const h = quickHarness(scenario);
    const { session, outcome, committed } = await h.run();
    assert.equal(h.events.some(event => ['begin', 'sample', 'end'].includes(event)), false, JSON.stringify(scenario));
    assert.equal(outcome, 'preflight');
    assert.equal(committed, false);
    assert.equal(session.aborted, 'preflight');
    assert.equal(session.after, null);
  }
});

test('a successful Quick sends its first command only after both centered holds and guarded baseline', async () => {
  const h = quickHarness();
  const { outcome, committed } = await h.run();
  assert.deepEqual(h.events.slice(0, 4), [
    { type: 'hold', centered: true },
    { type: 'measure', centered: true },
    { type: 'hold', centered: true },
    'begin',
  ]);
  assert.equal(h.events.filter(event => event === 'sample').length, 12);
  assert.equal(h.events.filter(event => event === 'end').length, 1);
  assert.equal(outcome, 'centered');
  assert.equal(committed, true);
});

// ---------------------------------------------------------------- UI (app reale)

// Stick sinistro tenuto al 40%: il preflight non può mai passare.
const heldAtStart = [{ stick: 0, t0: 0, dur: 60_000, tail: 0, amp: [50, 0] }];

async function connectedApp({ schedule = [] } = {}) {
  const clock = new VClock();
  // Stick sinistro a ~2.5%: deve esserci qualcosa da calibrare.
  const dev = makeDevice(clock, { schedule, drift: [[3.2, -0.3], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000); // auto-connessione + test drift automatico
  return { h, dev };
}

test('a blocked start shows the prompt, keeps the modal open and restores retry/cancel', async () => {
  const { h, dev } = await connectedApp({ schedule: heldAtStart });
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));

  assert.deepEqual([dev.counts.begin, dev.counts.sample, dev.counts.end], [0, 0, 0]);
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.peek().busy, false);
  assert.equal(h.$('btn-quick-go').disabled, false);
  assert.equal(h.$('btn-quick-cancel').disabled, false);
  assert.equal(h.$('quick-bar').style.width, '0%');
  assert.match(h.$('quick-msg').innerHTML, /Calibration has not started.*Release both sticks/);
  assert.equal(h.visible('modal-quick'), true, 'blocked prompt stays visible');
  const quick = h.sessions().filter(s => s.kind === 'quick');
  assert.equal(quick.length, 1);
  assert.equal(quick[0].aborted, 'preflight');
  assert.equal(quick[0].after, null);
});

test('Cancel resumes drift after a blocked start, and cannot close an active calibration', async () => {
  const { h } = await connectedApp({ schedule: heldAtStart });
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.equal(h.peek().quickPreflightBlocked, true);
  await h.click('btn-quick-cancel');
  assert.equal(h.peek().quickPreflightBlocked, false);
  assert.ok(h.peek().driftTest, 'drift test restarted');
  await h.advance(500);
  assert.equal(h.visible('modal-quick'), false);

  // Durante una calibrazione Cancel è ignorato anche se invocato direttamente.
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(50);
  assert.equal(h.peek().busy, true);
  h.ctx.cancelQuickCalibration();
  await h.advance(500);
  assert.equal(h.visible('modal-quick'), true);
  await h.run(running);
});

test('a blocked attempt preserves an existing unsaved result and can be retried successfully', async () => {
  const shortHold = [{ stick: 0, t0: 0, dur: 9000, tail: 0, amp: [50, 0] }];
  const { h, dev } = await connectedApp({ schedule: shortHold });
  h.ctx.setUnsaved(true);
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.peek().quickPreflightBlocked, true);
  await h.advance(5000); // la mano si stacca
  await h.run(h.click('btn-quick-go'));
  assert.equal(h.peek().quickPreflightBlocked, false);
  assert.equal(dev.counts.begin, 1);
  assert.equal(h.sessions().filter(s => s.kind === 'quick').length, 2);
  assert.equal(h.peek().busy, false);
});

// ---------------------------------------------------------------- campionamento

function scriptedSource() {
  const listeners = new Set();
  const source = {
    sticks: { lx: 0, ly: 0, rx: 0, ry: 0 },
    now: () => source.t,
    t: 0,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { for (const fn of listeners) fn(); },
    listeners,
  };
  return source;
}

test('guarded baseline rejects even one held report and leaves other measurement paths unchanged', async () => {
  for (const requireCentered of [true, false]) {
    const source = scriptedSource();
    let finishMeasurement;
    const clock = { sleep: () => new Promise(resolve => { finishMeasurement = resolve; }) };
    const promise = measureOffset(source, clock, 1000, { requireCentered });
    for (let i = 0; i < 60; i++) {
      source.sticks = { lx: i === 20 ? QUICK_CENTER_RADIUS + 0.1 : 0, ly: 0, rx: 0, ry: 0 };
      source.emit();
    }
    finishMeasurement();
    const measured = await promise;
    if (requireCentered) assert.equal(measured, null);
    else assert.ok(measured && measured.left.offset === 0, 'unguarded measurement keeps the median of stable samples');
    assert.equal(source.listeners.size, 0);
  }
});

test('real stability waiter rejects steady deflection and cleans up on timeout or missing reports', async () => {
  for (const noReports of [false, true]) {
    const source = scriptedSource();
    source.sticks = { lx: 0, ly: 0, rx: QUICK_CENTER_RADIUS + 0.1, ry: 0 };
    let timer;
    let cleared = false;
    const clock = {
      setTimeout: callback => { timer = callback; return 1; },
      clearTimeout: () => { cleared = true; },
    };
    const promise = waitForStable(source, clock, { requireCentered: true, timeoutMs: 1000 });
    if (noReports) timer();
    else {
      for (source.t = 0; source.t <= 1000; source.t += 10) source.emit();
    }
    assert.equal(await promise, false);
    assert.equal(source.listeners.size, 0);
    assert.equal(cleared, true);
  }
});

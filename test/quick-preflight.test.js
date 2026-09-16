import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createQuickCenterHold, sticksWithinQuickCenter, QUICK_CENTER_RADIUS } from '../js/quick-center-guard.js';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

// Esegue le funzioni dell'app reale con dipendenze controllate: niente copia
// della logica di avvio, browser, controller fisico o attese di wall clock.
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing app section: ${start}`);
  return source.slice(from, to);
}

const cancelSource = section('function cancelQuickCalibration()', '// Attende che tutti gli assi');
const quickSource = section('async function quickCalibrate()', '/* ============================== wizard guidato');
const waitSource = section('function waitForStable(', '// Misura dell\'offset residuo');
const measureSource = section('async function measureOffset(', '/* --------- telemetria locale');
const result = { left: { offset: 0.5, noise: 0.2 }, right: { offset: 0.6, noise: 0.2 } };

function quickHarness({ holds = [true, true], baseline = result, disconnectAtHold = -1 } = {}) {
  const elements = new Map();
  const events = [];
  const sessions = [];
  let holdIndex = 0;
  const context = vm.createContext({
    busy: false,
    quickPreflightBlocked: false,
    deviceInfo: null,
    unsaved: false,
    $: id => {
      if (!elements.has(id)) elements.set(id, { disabled: false, innerHTML: '', style: {} });
      return elements.get(id);
    },
    ds5: {
      calibBegin: async () => events.push('begin'),
      calibSample: async () => events.push('sample'),
      calibEnd: async () => events.push('end'),
    },
    cancelDriftTest: () => events.push('cancel-drift'),
    startDriftTest: () => events.push('start-drift'),
    closeModal: () => events.push('close-modal'),
    setUnsaved: value => { context.unsaved = value; },
    recordSessionOnce: session => sessions.push(structuredClone(session)),
    summarizeResult: value => value,
    waitForStable: async options => {
      const index = holdIndex++;
      events.push({ type: 'hold', centered: options.requireCentered === true });
      if (index === disconnectAtHold) context.ds5 = null;
      return holds[index] ?? true;
    },
    measureOffset: async (ms, options) => {
      events.push({ type: 'measure', centered: options?.requireCentered === true });
      return options?.requireCentered ? baseline : result;
    },
    sleep: async () => {},
    toast: () => {},
    log: () => {},
    QUICK_MAX_PASSES: 4,
    QUICK_SAMPLES_PER_PASS: 12,
    QUICK_STABLE_SPREAD: 0.035,
    QUICK_STABLE_SPREAD_MAX: 0.08,
    DRIFT_MOVE_SPREAD: 0.08,
    DRIFT_OK_MAX: 1.2,
    QUICK_CONVERGE_EPS: 0.15,
    QUICK_REGRESSION_EPS: 0.8,
    QUICK_NOISE_WORN: 1.5,
  });
  vm.runInContext(`${cancelSource}\n${quickSource}`, context);
  return { context, events, sessions, elements };
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
    await h.context.quickCalibrate();
    assert.equal(h.events.some(event => ['begin', 'sample', 'end'].includes(event)), false);
    assert.equal(h.context.unsaved, false);
    assert.equal(h.context.busy, false);
    assert.equal(h.elements.get('btn-quick-go').disabled, false);
    assert.equal(h.elements.get('btn-quick-cancel').disabled, false);
    assert.equal(h.elements.get('quick-bar').style.width, '0%');
    assert.match(h.elements.get('quick-msg').innerHTML, /Calibration has not started.*Release both sticks/);
    assert.equal(h.events.includes('close-modal'), false, 'blocked prompt stays visible');
    assert.equal(h.sessions.length, 1);
    assert.equal(h.sessions[0].aborted, 'preflight');
    assert.equal(h.sessions[0].after, null);
  }
});

test('a successful Quick sends its first command only after both centered holds and guarded baseline', async () => {
  const h = quickHarness();
  await h.context.quickCalibrate();
  assert.deepEqual(h.events.slice(0, 5), [
    'cancel-drift',
    { type: 'hold', centered: true },
    { type: 'measure', centered: true },
    { type: 'hold', centered: true },
    'begin',
  ]);
  assert.equal(h.events.filter(event => event === 'sample').length, 12);
  assert.equal(h.events.filter(event => event === 'end').length, 1);
  assert.equal(h.context.unsaved, true);
  assert.equal(h.context.busy, false);
});

test('Cancel resumes drift after a blocked start, and cannot close an active calibration', async () => {
  const h = quickHarness({ holds: [false] });
  await h.context.quickCalibrate();
  h.context.cancelQuickCalibration();
  assert.deepEqual(h.events.slice(-2), ['close-modal', 'start-drift']);
  assert.equal(h.context.quickPreflightBlocked, false);
  const before = h.events.length;
  h.context.busy = true;
  h.context.cancelQuickCalibration();
  assert.equal(h.events.length, before);
});

test('a blocked attempt preserves an existing unsaved result and can be retried successfully', async () => {
  const h = quickHarness({ holds: [false] });
  h.context.unsaved = true;
  await h.context.quickCalibrate();
  assert.equal(h.context.unsaved, true);
  assert.equal(h.context.quickPreflightBlocked, true);
  await h.context.quickCalibrate();
  assert.equal(h.context.quickPreflightBlocked, false);
  assert.equal(h.events.filter(event => event === 'begin').length, 1);
  assert.equal(h.sessions.length, 2);
  assert.equal(h.context.busy, false);
});

test('guarded baseline rejects even one held report and leaves other measurement paths unchanged', async () => {
  for (const requireCentered of [true, false]) {
    const listeners = new Set();
    let finishMeasurement;
    const context = vm.createContext({
      stickListeners: listeners,
      sticks: { lx: 0, ly: 0, rx: 0, ry: 0 },
      sleep: () => new Promise(resolve => { finishMeasurement = resolve; }),
      sticksWithinQuickCenter,
      extractStableSamples: samples => ({ stable: samples }),
      analyzeDrift: () => result,
    });
    vm.runInContext(measureSource, context);
    const promise = context.measureOffset(1000, { requireCentered });
    for (let i = 0; i < 60; i++) {
      context.sticks.lx = i === 20 ? QUICK_CENTER_RADIUS + 0.1 : 0;
      for (const listener of listeners) listener();
    }
    finishMeasurement();
    assert.equal(await promise, requireCentered ? null : result);
    assert.equal(listeners.size, 0);
  }
});

test('real stability waiter rejects steady deflection and cleans up on timeout or missing reports', async () => {
  for (const noReports of [false, true]) {
    const listeners = new Set();
    let now = 0;
    let timer;
    let cleared = false;
    const context = vm.createContext({
      QUICK_STABLE_SPREAD: 0.035,
      QUICK_STABLE_MS: 300,
      QUICK_STABLE_TIMEOUT: 5000,
      createQuickCenterHold,
      stickListeners: listeners,
      sticks: { lx: 0, ly: 0, rx: QUICK_CENTER_RADIUS + 0.1, ry: 0 },
      performance: { now: () => now },
      setTimeout: callback => { timer = callback; return 1; },
      clearTimeout: () => { cleared = true; },
    });
    vm.runInContext(waitSource, context);
    const promise = context.waitForStable({ requireCentered: true, timeoutMs: 1000 });
    if (noReports) timer();
    else {
      for (now = 0; now <= 1000; now += 10) {
        for (const listener of listeners) listener();
      }
    }
    assert.equal(await promise, false);
    assert.equal(listeners.size, 0);
    assert.equal(cleared, true);
  }
});

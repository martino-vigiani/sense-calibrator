import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

// Come in quick-preflight.test.js: si esegue il codice reale di app.js in una
// VM con dipendenze finte, senza browser né controller fisico.
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing app section: ${start}`);
  return source.slice(from, to);
}

const quickSource = section('async function quickCalibrate()', '/* ============================== wizard guidato');
const flashSource = section('async function doFlash()', '/* ============================== calibrazione rapida');

function elementStore() {
  const elements = new Map();
  return {
    elements,
    $: id => {
      if (!elements.has(id)) elements.set(id, { disabled: false, innerHTML: '', style: {} });
      return elements.get(id);
    },
  };
}

// Offset alto e costante: la passata 1 non raggiunge la soglia, quindi il ciclo
// arriva davvero alla passata 2 (dove, senza errori, dichiarerebbe convergenza).
const drifting = { left: { offset: 5, noise: 0.2, x: 0.05, y: 0 }, right: { offset: 0.6, noise: 0.2, x: 0.006, y: 0 } };

function quickHarness({ failBeginAt = Infinity, failEndAt = Infinity, committedError = false } = {}) {
  const { $ } = elementStore();
  const calls = { begin: 0, end: 0, sample: 0 };
  const sessions = [];
  const fail = message => {
    const error = new Error(message);
    if (committedError) error.committed = true;
    throw error;
  };
  const context = vm.createContext({
    busy: false,
    quickPreflightBlocked: false,
    deviceInfo: null,
    unsaved: false,
    $,
    ds5: {
      calibBegin: async () => { if (++calls.begin >= failBeginAt) fail('begin failed'); },
      calibSample: async () => { calls.sample += 1; },
      calibEnd: async () => { if (++calls.end >= failEndAt) fail('end failed'); },
    },
    cancelDriftTest: () => {},
    startDriftTest: () => {},
    closeModal: () => {},
    setUnsaved: value => { context.unsaved = value; },
    recordSessionOnce: session => sessions.push(structuredClone(session)),
    summarizeResult: value => value && { off: [value.left.offset, value.right.offset] },
    waitForStable: async () => true,
    measureOffset: async () => drifting,
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
  vm.runInContext(quickSource, context);
  return { context, calls, sessions };
}

test('repro A: a failure in pass 2 keeps unsaved=true, because pass 1 is already applied', async () => {
  const { context, calls, sessions } = quickHarness({ failBeginAt: 2 });
  await context.quickCalibrate();

  assert.equal(calls.end, 1, 'pass 1 committed exactly once before the failure');
  assert.equal(calls.begin, 2);
  assert.equal(context.unsaved, true);
  assert.equal(context.busy, false);
  assert.equal(sessions.at(-1).aborted, 'error');
});

test('a failure in a later calibEnd also keeps unsaved=true', async () => {
  const { context, calls } = quickHarness({ failEndAt: 2 });
  await context.quickCalibrate();

  assert.equal(calls.end, 2);
  assert.equal(context.unsaved, true);
});

test('a failure before the first calibEnd leaves unsaved untouched unless the repair committed', async () => {
  for (const scenario of [{ failBeginAt: 1 }, { failEndAt: 1 }]) {
    const { context } = quickHarness(scenario);
    await context.quickCalibrate();
    assert.equal(context.unsaved, false, JSON.stringify(scenario));
  }
  const { context } = quickHarness({ failBeginAt: 1, committedError: true });
  await context.quickCalibrate();
  assert.equal(context.unsaved, true, 'error.committed still marks the RAM as changed');
});

function flashHarness({ connected = true, busy = false } = {}) {
  const { $ } = elementStore();
  const calls = { flash: 0, nv: 0, closed: [] };
  const logs = [];
  const info = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const context = vm.createContext({
    busy,
    unsaved: true,
    $,
    ds5: connected ? {
      // Il flash resta in volo finché il test non lo rilascia: è la finestra
      // in cui arriva il secondo click.
      flash: async () => { calls.flash += 1; await pending; },
    } : null,
    refreshNv: async () => { calls.nv += 1; return { status: 'locked', raw: 0x03030201 }; },
    closeModal: id => calls.closed.push(id),
    recordEvent: () => {},
    setUnsaved: value => { context.unsaved = value; },
    toast: () => {},
    log: message => logs.push(message),
    console: { info: (...args) => info.push(args) },
  });
  vm.runInContext(flashSource, context);
  // Il browser non consegna click a un bottone disabilitato.
  const click = () => ($('btn-flash-go').disabled ? undefined : context.doFlash());
  return { context, calls, logs, info, click, release, $ };
}

test('double-clicking Write runs exactly one flash()', async () => {
  const h = flashHarness();
  const first = h.click();
  const second = h.click();
  assert.equal(h.$('btn-flash-go').disabled, true, 'disabled synchronously, before any await');
  h.release();
  await Promise.all([first, second]);

  assert.equal(h.calls.flash, 1);
  assert.equal(h.context.unsaved, false);
  assert.equal(h.context.busy, false);
});

test('a second doFlash call while the first is in flight is ignored by the busy guard', async () => {
  const h = flashHarness();
  const first = h.context.doFlash();
  const second = h.context.doFlash();
  h.release();
  await Promise.all([first, second]);

  assert.equal(h.calls.flash, 1);
  assert.deepEqual(h.calls.closed, ['modal-flash']);
});

test('doFlash does nothing while another operation is busy or without a controller', async () => {
  for (const options of [{ busy: true }, { connected: false }]) {
    const h = flashHarness(options);
    h.release();
    await h.context.doFlash();
    assert.equal(h.calls.flash, 0, JSON.stringify(options));
    assert.equal(h.$('btn-flash-go').disabled, false, 'no state change on the ignored call');
  }
});

test('the raw NVS status word is logged after flash without gating the outcome', async () => {
  const h = flashHarness();
  h.release();
  await h.click();

  assert.ok(h.logs.some(line => /NVS status after flash: locked \(raw 0x03030201\)/.test(line)), h.logs.join('\n'));
  assert.deepEqual(h.info[0].slice(1), ['locked', '0x03030201']);
});

test('reopening the Write modal re-enables the confirm button', () => {
  assert.match(source, /\$\('btn-flash'\)\.addEventListener\('click', \(\) => \{\s*\$\('btn-flash-go'\)\.disabled = false;[^\n]*\n\s*openModal\('modal-flash'\);/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_DEFAULTS, runQuick } from '../js/calib/quick.js';
import { measureOffset, waitForStable } from '../js/calib/sampling.js';
import { QUICK_CENTER_RADIUS } from '../js/quick-center-guard.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';
import { FakeDualSense } from '../ops/sim/fake-dualsense.mjs';
import { makeSimInstance } from '../ops/sim/harness.mjs';

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

// Stick sinistro tenuto al 40%: il preflight non può mai passare. La mano
// arriva DOPO il test drift automatico (finito entro 5 s): se il test drift
// stesso vede lo stick al 40%, la preflight fallita instrada a Guided
// (quickPreflightRoute, coperto in quick-safety.test.js).
const heldAtStart = [{ stick: 0, t0: 5000, dur: 60_000, tail: 0, amp: [50, 0] }];

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
  const shortHold = [{ stick: 0, t0: 5000, dur: 9000, tail: 0, amp: [50, 0] }];
  const { h, dev } = await connectedApp({ schedule: shortHold });
  h.ctx.setUnsaved(true);
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.peek().quickPreflightBlocked, true);
  // C: il test drift è di prima del commit, quindi non dice più che lo stick
  // riposa dentro il raggio: la rotta prudente (Guided) è primaria, Quick resta.
  assert.equal(h.$('btn-quick-go').textContent, 'Guided calibration');
  await h.advance(5000); // la mano si stacca
  await h.run(h.click('btn-quick-alt'));
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
      source.t = i * (1000 / 59); // report HID freschi per tutta la durata dichiarata
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

// ------------------------------------------- attesa iniziale e diagnosi (v2)

// Telemetria v2 (27/9–12/10, 250 preflight su 825 Quick): 241 scadevano sulla
// prima attesa di 3 s. Ora l'attesa vale holdTimeoutMs (8 s), con la stessa
// guardia; uno stick fermo fuori raggio smette dopo 3 s (il vecchio tempo).
// Tutto sul DualSense virtuale: model-verified, non hardware.
async function simQuick({ schedule = [], params = {}, drift = [[3.2, -0.3], [-0.1, 0.4]] } = {}) {
  const clock = new VClock();
  const dev = new FakeDualSense({
    clock,
    seed: 11,
    sticks: drift.map(d => ({ drift: d, noise: 0.05, bias: { axis: 0, B: 0 } })),
    fw: { sf: 0, cmdMs: [2, 6] },
    timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    hand: { schedule },
  });
  const events = [];
  const inst = makeSimInstance(clock, dev, { board: 'TEST', fw: 0 }, params, {
    onProgress: e => { if (e.phase) events.push({ t: clock.now(), ...e }); },
  });
  const res = await clock.run(inst.run());
  dev.close();
  const begins = dev.commandLog.filter(c => c.op === 'begin').map(c => c.t);
  return { res, dev, events, begins, end: clock.now() };
}
// Mano che si muove sullo stick sinistro (oscillazione di ±25 LSB, ~20%).
const movingHand = (dur, t0 = 0) => ({ stick: 0, t0, dur, tail: 100, amp: [0, 0], at: t => 25 * Math.sin(2 * Math.PI * t / 300) });
// Pollice fermo al ~31% sullo stick sinistro.
const stillThumb = (dur, t0 = 0) => ({ stick: 0, t0, dur, tail: 100, amp: [40, 0] });

test('preflight: the first wait now has holdTimeoutMs, so a hand that lets go after 3 s no longer blocks Quick', async () => {
  assert.equal(QUICK_DEFAULTS.preflightTimeoutMs, QUICK_DEFAULTS.holdTimeoutMs);
  const old = await simQuick({ schedule: [movingHand(5000)], params: { preflightTimeoutMs: 3000 } });
  assert.equal(old.res.outcome, 'preflight', 'the old 3 s wait gave up');
  assert.equal(old.begins.length, 0);

  const now = await simQuick({ schedule: [movingHand(5000)] });
  assert.notEqual(now.res.outcome, 'preflight');
  assert.ok(now.begins.length >= 1);
  // Primo comando solo dopo il rilascio (5 s; la coda decade in poche decine
  // di ms) e le tenute di sempre: 300 ms, baseline di 1 s, 300 ms.
  assert.ok(now.begins[0] > 5000 + QUICK_DEFAULTS.baselineMs + 2 * QUICK_DEFAULTS.stableMs, `begin at ${now.begins[0]}`);
  // Il messaggio "lascia gli stick" compare durante l'attesa, dopo holdPromptMs.
  const held = now.events.find(e => e.phase === 'held');
  assert.ok(held && held.t >= QUICK_DEFAULTS.holdPromptMs && held.t < 5000, JSON.stringify(held));
  const settled = now.events.find(e => e.phase === 'settled');
  assert.ok(settled && settled.t > 5000 && settled.t < now.begins[0], 'the prompt is withdrawn once the wait passes');
});

test('preflight: a hand that never stops is blocked after the full wait, with reason "moving" and no command', async () => {
  const { res, dev, end } = await simQuick({ schedule: [movingHand(120_000)] });
  assert.equal(res.outcome, 'preflight');
  assert.deepEqual([dev.counts.begin, dev.counts.sample, dev.counts.end], [0, 0, 0]);
  assert.deepEqual(res.session.preflight, { stage: 'settle', reason: 'moving' });
  assert.equal(res.preflight.reason, 'moving');
  assert.ok(end >= QUICK_DEFAULTS.preflightTimeoutMs && end < QUICK_DEFAULTS.preflightTimeoutMs + 500, `ended at ${end}`);
});

test('preflight: a stick held still past the radius stops after 3 s with its side and offset; the page can wait longer', async () => {
  const fast = await simQuick({ schedule: [stillThumb(120_000)] });
  assert.equal(fast.res.outcome, 'preflight');
  assert.equal(fast.dev.counts.begin, 0);
  assert.equal(fast.res.session.preflight.stage, 'settle');
  assert.equal(fast.res.session.preflight.reason, 'off-center');
  assert.equal(fast.res.session.preflight.side, 'left');
  assert.ok(fast.res.session.preflight.offset > 25 && fast.res.session.preflight.offset < 40, `${fast.res.session.preflight.offset}`);
  assert.ok(fast.res.preflight.result?.left, 'a drift-shaped result for routing');
  assert.ok(fast.end < QUICK_DEFAULTS.preflightOffCenterMs + QUICK_DEFAULTS.stableMs + 300, `ended at ${fast.end}`);
  assert.ok(fast.events.some(e => e.phase === 'off-center' && e.side === 'left'), 'live off-center prompt');
  assert.ok(!fast.events.some(e => e.phase === 'held'), 'a still stick is not told it is moving');

  const patient = await simQuick({ schedule: [stillThumb(120_000)], params: { preflightOffCenterMs: Infinity } });
  assert.equal(patient.res.outcome, 'preflight');
  assert.equal(patient.dev.counts.begin, 0);
  assert.ok(patient.end >= QUICK_DEFAULTS.preflightTimeoutMs, `ended at ${patient.end}`);

  const released = await simQuick({ schedule: [stillThumb(5000)], params: { preflightOffCenterMs: Infinity } });
  assert.notEqual(released.res.outcome, 'preflight');
  assert.ok(released.begins[0] > 5100, `begin at ${released.begins[0]}`);
});

test('preflight: no calibBegin while a hand is on a stick, for hands that leave at any time up to 12 s', async () => {
  for (const kind of ['moving', 'still']) {
    for (const params of [{}, { preflightOffCenterMs: Infinity }]) {
      for (let dur = 0; dur <= 12_000; dur += 1500) {
        const touch = kind === 'moving' ? movingHand(dur) : stillThumb(dur);
        const { res, begins, dev } = await simQuick({ schedule: dur ? [touch] : [], params });
        const label = `${kind} ${dur} ms ${JSON.stringify(params)} → ${res.outcome}`;
        if (begins.length) assert.ok(begins[0] > touch.t0 + dur + touch.tail, label);
        if (res.outcome === 'preflight') assert.equal(dev.commandLog.filter(c => ['begin', 'sample', 'end'].includes(c.op)).length, 0, label);
      }
    }
  }
});

test('preflight: the probe detaches from the stick source whatever the outcome', async () => {
  for (const schedule of [[], [movingHand(120_000)], [stillThumb(120_000)]]) {
    const clock = new VClock();
    const dev = new FakeDualSense({
      clock, seed: 3, sticks: [[3.2, -0.3], [-0.1, 0.4]].map(d => ({ drift: d, noise: 0.05, bias: { axis: 0, B: 0 } })),
      fw: { sf: 0, cmdMs: [2, 6] }, timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] }, hand: { schedule },
    });
    const inst = makeSimInstance(clock, dev, { board: 'TEST', fw: 0 }, {});
    await clock.run(inst.run());
    dev.close();
    assert.equal(inst.source.listenerCount, 0, JSON.stringify(schedule));
  }
});

// ------------------------------------------- UI: messaggio per causa (app reale)

test('app: with no drift-test evidence, a stick held still past the radius is routed to Guided with a hedged message', async () => {
  const { h, dev } = await connectedApp();
  dev.touches.push({ stick: 0, t0: 0, dur: 600_000, tail: 0, amp: [40, 0] }); // ~31%, fermo
  await h.click('btn-quick');
  await h.advance(400);
  h.eval('lastDriftResult = null');
  const go = h.click('btn-quick-go');
  await h.advance(1500);
  assert.match(h.$('quick-msg').innerHTML, /^The left stick is still but reads 3\d\.\d% from center\. <b>If you’re touching it, let go\.<\/b>/);
  await h.advance(20_000);
  await h.run(go);
  assert.deepEqual([dev.counts.begin, dev.counts.sample, dev.counts.end], [0, 0, 0]);
  const msg = h.$('quick-msg').innerHTML;
  assert.match(msg, /^Calibration has not started\. <b>The left stick stayed still at 3\d\.\d% from center during the check, and Quick only starts within 15%\. If nobody is touching it, use Guided calibration\.<\/b>/);
  assert.equal(h.$('btn-quick-go').textContent, 'Guided calibration');
  assert.equal(h.eval('quickHoldKnown'), false, 'the meter is not forced to "Stick held"');
  const [session] = h.sessions().filter(s => s.kind === 'quick');
  assert.equal(session.preflight.reason, 'off-center');
  assert.equal(session.preflight.side, 'left');
});

test('app: a stick the drift test saw centered, now held still off-center, waits the full time and says to let go', async () => {
  const { h, dev } = await connectedApp();
  assert.equal(h.eval("driftRestedInside(lastDriftResult, 'left') && driftRestedInside(lastDriftResult, 'right')"), true);
  await h.click('btn-quick');
  dev.touches.push({ stick: 0, t0: 0, dur: 600_000, tail: 0, amp: [40, 0] });
  await h.advance(400);
  const started = h.clock.now();
  await h.run(h.click('btn-quick-go'));
  assert.ok(h.clock.now() - started >= QUICK_DEFAULTS.preflightTimeoutMs, 'no early stop: it is probably a thumb');
  assert.equal(dev.counts.begin, 0);
  assert.match(h.$('quick-msg').innerHTML, /^Calibration has not started: the left stick was held still at 3\d\.\d% from center, but the last drift test found it centered\. <b>Release both sticks<\/b>/);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now');
  assert.equal(h.eval('quickHoldKnown'), true);
});

test('app: a hand that keeps moving gets the movement message; a silent controller gets the cable message', async () => {
  {
    const { h, dev } = await connectedApp();
    await h.click('btn-quick');
    dev.touches.push({ stick: 1, t0: 0, dur: 600_000, tail: 0, amp: [0, 0], at: t => 25 * Math.sin(2 * Math.PI * t / 300) });
    const go = h.click('btn-quick-go');
    await h.advance(20_000);
    await h.run(go);
    assert.equal(dev.counts.begin, 0);
    assert.match(h.$('quick-msg').innerHTML, /^Calibration has not started: the sticks didn’t stay still and centered\. <b>Release both sticks<\/b>/);
    assert.equal(h.eval('quickHoldKnown'), true);
  }
  {
    const { h, dev } = await connectedApp();
    await h.click('btn-quick');
    const go = h.click('btn-quick-go');
    dev.stopped = true; // il controller smette di mandare input report
    await h.advance(20_000);
    await h.run(go);
    assert.equal(dev.counts.begin, 0);
    assert.match(h.$('quick-msg').innerHTML, /^Calibration has not started\. <b>No readings arrived from the controller\.<\/b> Check the USB cable/);
    assert.equal(h.eval('quickHoldKnown'), false);
    assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now');
  }
});

// ------------------------------- revisione 12/10: silenzio dopo qualche report

// Sorgente come quella della pagina (app.js: stickSource): `reportTime` è il
// tempo dell'ULTIMO report, `now()` l'ora corrente sullo stesso orologio.
function pageLikeSource(sticks) {
  const listeners = new Set();
  const source = {
    t: 0,
    reportTime: NaN,
    sticks,
    now: () => source.t,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(n) {
      for (let i = 0; i < n; i++) {
        source.t += 4;
        source.reportTime = source.t;
        for (const fn of [...listeners]) fn();
      }
    },
  };
  return source;
}

test('preflight: reports that stop after 800 ms are "no-input", not the last window seen', async () => {
  // Stick fermo al 30% per 800 ms, poi 7 s di silenzio. Prima: reason
  // 'off-center', offset 30, e la pagina mandava a Guided invece di dire "cavo".
  const source = pageLikeSource({ lx: 0.3, ly: 0, rx: 0, ry: 0 });
  const sampler = {
    waitForStable: async () => { source.emit(200); source.t += 7000; return false; },
    measureOffset: async () => null,
  };
  const r = await runQuick({ controller: {}, source, sampler, clock: { sleep: async () => {} }, isCurrent: () => true, params: {} });
  assert.equal(r.outcome, 'preflight');
  assert.equal(r.preflight.reason, 'no-input');
  assert.equal(r.session.preflight.reason, 'no-input');
  // Con i report ancora vivi la diagnosi è quella di prima.
  const live = pageLikeSource({ lx: 0.3, ly: 0, rx: 0, ry: 0 });
  const liveRun = await runQuick({
    controller: {}, source: live, clock: { sleep: async () => {} }, isCurrent: () => true, params: {},
    sampler: { waitForStable: async () => { live.emit(1000); return false; }, measureOffset: async () => null },
  });
  assert.equal(liveRun.preflight.reason, 'off-center');
});

test('app: a controller that goes silent during the first wait gets the cable message, even after a still off-center stick', async () => {
  const { h, dev } = await connectedApp();
  await h.click('btn-quick');
  dev.touches.push({ stick: 0, t0: 0, dur: 600_000, tail: 0, amp: [40, 0] }); // ~31%, fermo
  await h.advance(400);
  const go = h.click('btn-quick-go');
  await h.advance(800);
  dev.stopped = true;
  await h.advance(20_000);
  await h.run(go);
  assert.equal(dev.counts.begin, 0);
  assert.match(h.$('quick-msg').innerHTML, /^Calibration has not started\. <b>No readings arrived from the controller\.<\/b> Check the USB cable/);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now', 'not routed to Guided');
  const [session] = h.sessions().filter(s => s.kind === 'quick');
  assert.equal(session.preflight.reason, 'no-input');
});

test('app: reports that keep pausing get a neutral connection message, not "Release both sticks"', async () => {
  const { h, dev } = await connectedApp();
  await h.click('btn-quick');
  const go = h.click('btn-quick-go');
  for (let i = 0; i < 40; i++) { // 200 ms di report, 150 ms di buco
    dev.stopped = false;
    dev.schedule(); // la catena dei report si era fermata
    await h.advance(200);
    dev.stopped = true;
    await h.advance(150);
  }
  dev.stopped = false;
  dev.schedule();
  await h.run(go);
  assert.equal(dev.counts.begin, 0);
  const [session] = h.sessions().filter(s => s.kind === 'quick');
  assert.equal(session.preflight.reason, 'gaps');
  assert.match(h.$('quick-msg').innerHTML, /^Calibration has not started\. <b>The controller’s readings kept pausing<\/b>/);
  assert.doesNotMatch(h.$('quick-msg').innerHTML, /Release both sticks/);
  assert.equal(h.eval('quickHoldKnown'), false, 'no hand to show on the meter');
});

// ------------------------------------------------ blocco 2: rotta e ripetizioni

test('C: a drift test from before the last commit no longer stretches the off-center wait or calls it a thumb', async () => {
  const { h, dev } = await connectedApp();
  assert.ok(h.peek().lastDriftResult, 'the automatic drift test ran');
  assert.equal(h.eval('!!freshDriftResult()'), true);
  h.ctx.setUnsaved(true); // un commit dopo il test drift
  assert.equal(h.eval('!!freshDriftResult()'), false);
  // stick tenuto fermo al ~20%
  dev.touches.push({ stick: 0, t0: h.clock.now(), dur: 60_000, tail: 0, amp: [25, 0] });
  await h.advance(300);
  await h.click('btn-quick');
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now', 'no entry route from a stale test');
  const t0 = h.clock.now();
  let ended = null;
  const go = h.click('btn-quick-go').then(() => { ended = h.clock.now(); });
  while (ended === null && h.clock.now() - t0 < 20_000) await h.advance(100);
  await h.run(go);
  assert.equal(dev.counts.begin, 0);
  assert.ok(ended - t0 < 5000, `stopped early (${ended - t0} ms), not after the 8 s budget`);
  const msg = h.$('quick-msg').innerHTML;
  assert.match(msg, /If nobody is touching it, use Guided calibration/);
  assert.doesNotMatch(msg, /last drift test found it centered/);
  assert.equal(h.$('btn-quick-go').textContent, 'Guided calibration');
  assert.equal(h.visible('btn-quick-alt'), true);
});

test('A: a stale far drift test does not change the Quick entry', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[25, 0], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(6000);
  h.ctx.setUnsaved(true);
  await h.click('btn-quick');
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now');
  assert.equal(h.visible('btn-quick-alt'), false);
  assert.equal(dev.counts.begin, 0);
});

test('E: a second failed preflight on the same controller makes Guided the primary action', async () => {
  const { h, dev } = await connectedApp();
  dev.touches.push({ stick: 1, t0: h.clock.now(), dur: 120_000, tail: 0, at: t => 25 * Math.sin(t / 40) });
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.match(h.$('quick-msg').innerHTML, /Release both sticks/);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now', 'first failure: retry Quick');
  assert.equal(h.visible('btn-quick-alt'), false);
  await h.run(h.click('btn-quick-go'));
  assert.match(h.$('quick-msg').innerHTML, /Quick couldn’t start twice; Guided works wherever the stick rests/);
  assert.equal(h.$('btn-quick-go').textContent, 'Guided calibration');
  assert.equal(h.visible('btn-quick-alt'), true);
  assert.equal(dev.counts.begin, 0, 'nothing sent in any branch');
  // Try Quick anyway lancia runQuick come prima
  const before = h.sessions().filter(s => s.kind === 'quick').length;
  await h.run(h.click('btn-quick-alt'));
  assert.equal(h.sessions().filter(s => s.kind === 'quick').length, before + 1);
  // il primario apre Guided
  await h.run(h.click('btn-quick-go'));
  await h.advance(500);
  assert.equal(h.visible('modal-wizard'), true);
  assert.equal(dev.counts.begin, 0);
});

test('E: with a fresh drift test already within one step, two failed starts do not push Guided', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[0.6, -0.3], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  dev.touches.push({ stick: 1, t0: h.clock.now(), dur: 120_000, tail: 0, at: t => 25 * Math.sin(t / 40) });
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  await h.run(h.click('btn-quick-go'));
  // Guided risponderebbe "already centered" e rimanderebbe a Quick: niente giro chiuso.
  assert.doesNotMatch(h.$('quick-msg').innerHTML, /Quick couldn’t start twice/);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now');
  assert.equal(h.visible('btn-quick-alt'), false);
  assert.equal(dev.counts.begin, 0);
});

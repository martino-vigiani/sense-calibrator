import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

// Riproduzioni dell'audit sull'app reale e sul DualSense virtuale: model-verified.
const setup = async (options = {}, session = new Map()) => {
  const clock = new VClock();
  const A = makeDevice(clock, options);
  const h = await loadApp({ clock, authorized: [A], session });
  await h.advance(5000);
  return { h, clock, A, session };
};
const v2 = h => JSON.parse(JSON.stringify(h.window.__senseTelemetryV2()));
const unplug = (h, dev) => { dev.unplug(); h.hid.fire('disconnect', dev); };
const replug = async (h, clock, options = {}) => {
  const dev = makeDevice(clock, options);
  h.hid.fire('connect', dev);
  await h.advance(2500);
  return dev;
};

test('audit 04: failed final NVS query keeps unsaved and never reports flash ok', async () => {
  const { h, A } = await setup();
  h.eval('setUnsaved(true)');
  const receive = A.receiveFeatureReport.bind(A);
  A.receiveFeatureReport = id => id === 0x81
    && A.commandLog.some(c => c.id === 0x80 && c.bytes[0] === 3 && c.bytes[1] === 1)
    && A.commandLog.at(-1)?.bytes[1] === 3
    ? new Promise(() => {}) : receive(id);
  await h.run(h.ctx.doFlash());
  assert.equal(h.peek().ds5.poisoned !== null, true);
  assert.equal(h.peek().unsaved, true);
  assert.doesNotMatch(h.toasts().join(' '), /saved permanently/i);
  const flash = v2(h).find(item => item.event.type === 'flash')?.event;
  assert.ok(flash);
  assert.notEqual(flash.result, 'ok');
  assert.equal(flash.nv, 'error');
});

test('audit 04: the observed locked word confirms a successful flash', async () => {
  const { h, A } = await setup();
  h.eval('setUnsaved(true)');
  await h.run(h.ctx.doFlash());
  assert.deepEqual(A.nvResponse.slice(0, 5), [0x81, 3, 3, 2, 1]);
  assert.equal(h.peek().unsaved, false);
  const flash = v2(h).find(item => item.event.type === 'flash')?.event;
  assert.deepEqual([flash?.result, flash?.nv], ['ok', 'locked']);
});

test('audit 05: late flash completion on A cannot query or save B', async () => {
  const { h, clock, A } = await setup();
  h.eval('setUnsaved(true)');
  const receive = A.receiveFeatureReport.bind(A);
  let release;
  A.receiveFeatureReport = id => id === 0x81 && A.commandLog.at(-1)?.bytes[1] === 1
    ? new Promise(resolve => { release = resolve; }) : receive(id);
  const pending = h.ctx.doFlash();
  await h.advance(100);
  assert.ok(release, 'A is waiting for its NVS lock reply');
  unplug(h, A);
  const B = makeDevice(clock);
  h.hid.fire('connect', B);
  await h.advance(100);
  assert.equal(h.peek().ds5?.device, B);
  h.eval('setUnsaved(true)');
  const bReads = B.commandLog.length;
  const chapter = h.eval('saveChapter');
  const reply = new Uint8Array([0x81, 3, 3, 2, 1]);
  release(new DataView(reply.buffer));
  await h.run(pending);
  assert.equal(B.commandLog.length, bReads, 'A must verify A, never query B');
  assert.equal(h.peek().unsaved, true, 'B remains unsaved');
  assert.equal(h.eval('saveChapter'), chapter, 'A cannot close B’s save period');
  assert.doesNotMatch(h.toasts().at(-1) ?? '', /saved permanently/i);
});

test('audit 14: an orphan calibration event from A does not claim B’s save period', async () => {
  const { h, clock, A } = await setup();
  h.eval('globalThis.__auditAController = ds5');
  unplug(h, A);
  await replug(h, clock);
  h.eval('setUnsaved(true)');
  assert.equal(h.eval('saveChapter.ref'), null);
  h.eval(`emitCalibV2(ctx => buildQuickEvent(ctx, {
    session: { before: null, after: null, passes: [], passXY: [] },
    outcome: 'disconnected', committed: false, needsPowerCycle: false, durMs: 100,
  }), { controller: globalThis.__auditAController, epoch: 0, device: { board: null, fw: null } });`);
  assert.equal(h.eval('saveChapter.ref'), null);
  assert.equal(h.eval('saveChapter.sessions'), 0);
});

test('audit 14: a later calibration on the same controller becomes the save period reference', async () => {
  const { h } = await setup();
  h.eval(`globalThis.__auditOp1 = ops.beginOp(); setUnsaved(true);
    emitCalibV2(ctx => buildQuickEvent(ctx, {
      session: { before: null, after: null, passes: [], passXY: [] },
      outcome: 'error', committed: true, needsPowerCycle: false, durMs: 100,
    }), { controller: ds5, epoch: globalThis.__auditOp1.epoch });`);
  const first = h.eval('saveChapter.ref');
  assert.ok(Number.isInteger(first));
  h.eval(`ops.endOp(globalThis.__auditOp1); globalThis.__auditOp2 = ops.beginOp();
    emitCalibV2(ctx => buildQuickEvent(ctx, {
      session: { before: null, after: null, passes: [], passXY: [] },
      outcome: 'error', committed: true, needsPowerCycle: false, durMs: 100,
    }), { controller: ds5, epoch: globalThis.__auditOp2.epoch });`);
  assert.notEqual(h.eval('saveChapter.ref'), first);
  assert.equal(h.eval('saveChapter.sessions'), 2);
});

test('audit 02: Guided unplug between corners locks the replug and emits one interrupted event', async () => {
  const { h, clock, A, session } = await setup({ drift: [[14, -9], [-2, 3]] });
  await h.click('btn-wizard');
  await h.run(h.click('btn-wizard-next'));
  assert.equal(h.peek().wizard.phase, 'corner');
  assert.ok(A.cal, 'center session is open between clicks');
  unplug(h, A);
  await replug(h, clock);
  assert.equal(h.$('btn-flash').disabled, true);
  assert.equal(session.get('sense-power-cycle-in-tab'), '1');
  const events = v2(h).filter(item => item.event.type === 'guided');
  assert.equal(events.length, 1);
  assert.equal(events[0].event.outcome, 'disconnected');
  assert.equal(events[0].event.needsPowerCycle, true);
});

test('audit 02: a Guided page exit with an open session emits once and stays locked on reload', async () => {
  const session = new Map();
  const { h, clock, A } = await setup({ drift: [[14, -9], [-2, 3]] }, session);
  await h.click('btn-wizard');
  await h.run(h.click('btn-wizard-next'));
  for (const fn of h.windowListeners.get('pagehide') ?? []) fn({ type: 'pagehide', persisted: false });
  assert.equal(v2(h).filter(item => item.event.type === 'guided').length, 1);
  assert.equal(session.get('sense-power-cycle-in-tab'), '1');
  const reloaded = await loadApp({ clock, authorized: [A], session });
  await reloaded.advance(3000);
  assert.equal(reloaded.$('btn-flash').disabled, true);
});

test('audit 02: Guided disconnect after calibEnd but before verification keeps Write guarded', async () => {
  const { h, clock, A } = await setup({ drift: [[14, -9], [-2, 3]] });
  await h.click('btn-wizard');
  await h.run(h.click('btn-wizard-next'));
  const corners = [[-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]];
  const original = A.command.bind(A);
  A.command = (id, buf) => {
    original(id, buf);
    if (id === 0x82 && buf[0] === 2 && buf[2] === 1)
      clock.setTimeout(() => unplug(h, A), 50);
  };
  for (const [x, y] of corners) {
    const t0 = clock.now() + 20;
    for (const stick of [0, 1]) A.touches.push({ stick, t0, dur: 400, tail: 40, amp: [x * 120, y * 120] });
    await h.advance(650);
    await h.run(h.click('btn-wizard-next'));
  }
  assert.equal(A.counts.end, 1);
  await replug(h, clock);
  assert.notEqual(h.ctx.currentWriteLock().mode, 'allowed');
  const events = v2(h).filter(item => item.event.type === 'guided');
  assert.equal(events.length, 1);
  assert.equal(events[0].event.outcome, 'disconnected');
  assert.equal(events[0].event.committed, true);
});

async function rotateRangeOnce(h, dev) {
  const t0 = h.clock.now() + 10;
  for (const stick of [0, 1]) dev.touches.push({ stick, t0, dur: 1000, tail: 1,
    at: (t, axis) => 127.5 * (axis === 0
      ? Math.cos(2 * Math.PI * (t - t0) / 1000)
      : Math.sin(2 * Math.PI * (t - t0) / 1000)) });
  await h.advance(16000);
}

test('audit 03: Range unplug during rotation leaves a write lock and one v2 event', async () => {
  const { h, clock, A } = await setup();
  await h.click('btn-range');
  await h.run(h.click('btn-range-start'));
  assert.ok(h.peek().rangeSession);
  unplug(h, A);
  await replug(h, clock);
  assert.equal(h.$('btn-flash').disabled, true);
  const events = v2(h).filter(item => item.event.type === 'range');
  assert.equal(events.length, 1);
  assert.equal(events[0].event.outcome, 'error');
});

test('audit 03: a Range page exit emits one interrupted event and keeps the reload lock', async () => {
  const session = new Map();
  const { h, clock, A } = await setup({}, session);
  await h.click('btn-range');
  await h.run(h.click('btn-range-start'));
  for (const fn of h.windowListeners.get('pagehide') ?? []) fn({ type: 'pagehide', persisted: false });
  assert.equal(v2(h).filter(item => item.event.type === 'range').length, 1);
  assert.equal(session.get('sense-range-write-lock-in-tab'), '1');
  const reloaded = await loadApp({ clock, authorized: [A], session });
  await reloaded.advance(3000);
  assert.equal(reloaded.$('btn-flash').disabled, true);
});

test('audit 03: a page exit during rangeEnd emits one interrupted event', async () => {
  const { h, A } = await setup();
  await h.click('btn-range');
  await h.run(h.click('btn-range-start'));
  await rotateRangeOnce(h, A);
  const receive = A.receiveFeatureReport.bind(A);
  let release;
  A.receiveFeatureReport = id => id === 0x83 && A.commandLog.at(-1)?.bytes[0] === 2
    && A.commandLog.at(-1)?.bytes[2] === 2
    ? new Promise(resolve => { release = resolve; }) : receive(id);
  const pending = h.click('btn-range-done');
  await h.advance(100);
  assert.ok(release);
  for (const fn of h.windowListeners.get('pagehide') ?? []) fn({ type: 'pagehide', persisted: false });
  const interrupted = v2(h).filter(item => item.event.type === 'range');
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].event.committed, true, 'rangeEnd in flight may have changed RAM');
  release(new DataView(Uint8Array.from([0x83, 1, 2, 2]).buffer));
  await h.run(pending);
  assert.equal(v2(h).filter(item => item.event.type === 'range').length, 1);
});

test('audit 03: Range close rejected before send still locks Write and never says unchanged', async () => {
  const { h, A } = await setup();
  await h.click('btn-range');
  await h.run(h.click('btn-range-start'));
  await rotateRangeOnce(h, A);
  assert.equal(h.$('btn-range-done').disabled, false);
  const send = A.sendFeatureReport.bind(A);
  A.sendFeatureReport = (id, buf) => id === 0x82 && buf[0] === 2 && buf[2] === 2
    ? Promise.reject(new Error('send refused')) : send(id, buf);
  await h.run(h.click('btn-range-done'));
  assert.equal(h.$('btn-flash').disabled, true);
  assert.doesNotMatch(h.$('calib-outcome').innerHTML, /Nothing was changed/i);
  assert.equal(v2(h).filter(item => item.event.type === 'range').length, 1);
});

test('audit 03: a timed-out Range begin is locked and reported once', async () => {
  const { h, A } = await setup();
  const receive = A.receiveFeatureReport.bind(A);
  A.receiveFeatureReport = id => id === 0x83 && A.commandLog.at(-1)?.bytes[0] === 1
    && A.commandLog.at(-1)?.bytes[2] === 2 ? new Promise(() => {}) : receive(id);
  await h.click('btn-range');
  await h.run(h.click('btn-range-start'));
  assert.equal(h.$('btn-flash').disabled, true);
  assert.equal(v2(h).filter(item => item.event.type === 'range').length, 1);
});

test('audit 03: a rejected Range begin reply cannot clear the provisional lock', async () => {
  const { h, A } = await setup();
  const command = A.command.bind(A);
  A.command = (id, buf) => {
    command(id, buf);
    if (id === 0x82 && buf[0] === 1 && buf[2] === 2) A.response = [0x83, 1, 2, 3];
  };
  await h.click('btn-range');
  await h.run(h.click('btn-range-start'));
  assert.equal(h.$('btn-flash').disabled, true);
  assert.equal(v2(h).filter(item => item.event.type === 'range').length, 1);
});

test('audit 01: catastrophic center result remains blocked after reconnect and reload', async () => {
  const session = new Map();
  const { h, clock, A } = await setup({ drift: [[3.2, -0.3], [-0.1, 0.4]] }, session);
  A.sticks[0].bias = { axis: 0, B: 40 };
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.equal(h.$('btn-flash').disabled, true);
  unplug(h, A);
  A.unplugged = false; A.stopped = false; A.open(); A.schedule();
  h.hid.fire('connect', A);
  await h.advance(5000);
  assert.equal(h.$('btn-flash').disabled, true, 'USB reconnect is not a safe calibration');
  assert.equal(session.get('sense-center-write-lock-in-tab'), '1');
  const reloaded = await loadApp({ clock, authorized: [A], session });
  await reloaded.advance(5000);
  assert.equal(reloaded.$('btn-flash').disabled, true, 'salted per-load keys cannot clear a stored risk');
  for (const value of session.values()) assert.doesNotMatch(String(value), /[0-9a-f]{16}/i);
});

test('audit 01: a Range write lock survives page reload conservatively', async () => {
  const session = new Map();
  const { h, clock, A } = await setup({}, session);
  h.ctx.setRangeWriteLock('incomplete');
  assert.equal(session.get('sense-range-write-lock-in-tab'), '1');
  const reloaded = await loadApp({ clock, authorized: [A], session });
  await reloaded.advance(3000);
  assert.equal(reloaded.$('btn-flash').disabled, true);
});

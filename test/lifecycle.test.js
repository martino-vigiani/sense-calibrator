import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpGate } from '../js/calib/ops.js';
import { DRIFT_WINDOW, DRIFT_WINDOW_LEGACY, extractStableSamples } from '../js/calib/measure.js';
import { NV_UNKNOWN_MESSAGE, POISONED_MESSAGE } from '../js/ds5.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

// Ciclo di vita della pagina (connessione, busy, unsaved, teardown) sull'app
// reale nell'harness DOM-stub, con DualSense virtuali. I test senza `todo`
// fissano il comportamento di oggi; quelli con `todo` descrivono il
// comportamento voluto per i difetti noti (piano §1 F9, report robustezza) e
// falliscono finché non vengono corretti: chi corregge il difetto toglie `todo`.

// Stick sinistro a ~2.5%: una partenza già centrata (sotto 1.2%) non invia più
// alcun comando (WS1), quindi i test che devono vedere una passata partono da
// un drift vero.
const DRIFTING = [[3.2, -0.3], [-0.1, 0.4]];

async function setup({ devices = 1, schedule = [], drift } = {}) {
  const clock = new VClock();
  const devs = Array.from({ length: devices }, (_, i) => makeDevice(clock, { seed: 11 + i, name: `DualSense ${'AB'[i]}`, schedule, drift }));
  const h = await loadApp({ clock, authorized: [devs[0]] });
  await h.advance(5000);
  return { h, clock, devs, A: devs[0], B: devs[1] };
}
const hidCommands = dev => dev.counts.begin + dev.counts.sample + dev.counts.end;

// WS7: il wizard campiona solo dopo che entrambi gli stick hanno raggiunto
// l'angolo e sono tornati a riposo; il range si chiude solo dopo una rotazione
// vera (due giri e un cambio di verso). Mani virtuali per il DualSense finto.
const WIZARD_CORNER_AMPS = [[-85, -85], [85, -85], [-85, 85], [85, 85]];
async function wizardCorner(h, dev, amp) {
  const t0 = h.clock.now() + 20;
  for (const stick of [0, 1]) dev.touches.push({ stick, t0, dur: 400, tail: 40, amp });
  await h.advance(650);
}
async function rotateSticks(h, dev) {
  let from = h.clock.now() + 10;
  for (const [turns, dir] of [[2.2, 1], [1.2, -1]]) {
    const start = from;
    const dur = turns * 800;
    for (const stick of [0, 1]) {
      dev.touches.push({ stick, t0: start, dur, tail: 1, at: (t, ax) => {
        const a = dir * 2 * Math.PI * (t - start) / 800;
        return 127.5 * (ax === 0 ? Math.cos(a) : Math.sin(a));
      } });
    }
    from = start + dur;
  }
  await h.advance(from - h.clock.now() + 100);
}
const connectEvents = h => h.sessions().filter(s => s.kind === 'connect').length;

// ---------------------------------------------------------------- ops gate

test('the op gate tags each op with its epoch and ignores stale tokens', () => {
  const ops = createOpGate();
  assert.equal(ops.busy, false);
  const first = ops.beginOp();
  assert.equal(ops.busy, true);
  assert.equal(ops.isCurrent(first), true);
  ops.reset(); // teardown
  assert.equal(ops.busy, false);
  assert.equal(ops.isCurrent(first), false);
  const second = ops.beginOp();
  // Il ciclo orfano esce dal suo finally con il token vecchio: non libera il
  // flag dell'operazione nuova.
  assert.equal(ops.endOp(first), false);
  assert.equal(ops.busy, true);
  assert.equal(ops.endOp(second), true);
  assert.equal(ops.busy, false);
  // Un token già usato non libera l'operazione successiva nella stessa epoca.
  const third = ops.beginOp();
  assert.equal(ops.endOp(second), false);
  assert.equal(ops.busy, true);
  assert.equal(ops.endOp(undefined), false);
  assert.equal(ops.endOp(third), true);
});

// ---------------------------------------------------------------- connessione

test('an authorized DualSense is adopted at boot, then the automatic drift test runs', async () => {
  const { h, A } = await setup();
  assert.equal(h.visible('view-device'), true);
  assert.equal(h.visible('view-hero'), false);
  assert.equal(h.peek().ds5.device, A);
  assert.equal(h.$('chip-nvs').textContent, 'Memory locked (normal)');
  assert.equal(connectEvents(h), 1);
  assert.equal(h.sessions().filter(s => s.kind === 'drift').length, 1);
  assert.match(h.$('drift-status').textContent, /correctly centered/);
  assert.equal(hidCommands(A), 0, 'connecting sends no calibration command');
});

test('a disconnect event tears down to the hero view and clears busy and unsaved', async () => {
  const { h, A } = await setup();
  h.ctx.setUnsaved(true);
  await h.click('btn-quick');
  A.unplug();
  h.hid.fire('disconnect', A);
  const state = h.peek();
  assert.equal(state.ds5, null);
  assert.equal(state.busy, false);
  assert.equal(state.unsaved, false);
  assert.equal(h.visible('view-hero'), true);
  assert.equal(h.visible('modal-quick'), false, 'modals close without animation');
  assert.ok(h.toasts().includes('Controller disconnected.'));
});

// ---------------------------------------------------------------- operazioni

test('Quick holds busy for the whole run, then marks the RAM unsaved and resumes drift', async () => {
  const { h, A } = await setup({ drift: DRIFTING });
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(2500);
  assert.equal(h.peek().busy, true);
  h.keydown('Escape');
  await h.advance(300);
  assert.equal(h.visible('modal-quick'), true, 'Escape never dismisses a running calibration');
  await h.run(running);
  assert.equal(h.peek().busy, false);
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.visible('banner-unsaved'), true);
  assert.ok(h.peek().driftTest, 'drift test restarted after Quick');
  assert.equal(A.counts.end, h.sessions().find(s => s.kind === 'quick').passes.length);
  const unload = { preventDefault() { this.prevented = true; } };
  for (const fn of h.windowListeners.get('beforeunload')) fn(unload);
  assert.equal(unload.prevented, true, 'leaving with an unsaved calibration asks first');
});

test('the guided wizard raises busy before its first await and releases it after calibEnd', async () => {
  const { h, A } = await setup();
  await h.click('btn-wizard');
  const start = h.click('btn-wizard-next');
  assert.equal(h.peek().busy, true, 'busy is raised synchronously on Start');
  assert.equal(h.visible('btn-wizard-cancel'), false);
  await h.run(start);
  for (const amp of WIZARD_CORNER_AMPS) {
    await wizardCorner(h, A, amp);
    await h.run(h.click('btn-wizard-next'));
  }
  assert.equal(h.peek().busy, false);
  assert.equal(h.peek().unsaved, true);
  assert.deepEqual([A.counts.begin, A.counts.sample, A.counts.end], [1, 4, 1]);
  const wizard = h.sessions().filter(s => s.kind === 'wizard');
  assert.equal(wizard.length, 1);
  assert.equal(wizard[0].done, true);
});

test('Range keeps the controller busy until finishRange closes the session', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  assert.equal(h.peek().busy, true);
  assert.equal(h.visible('modal-range'), true);
  h.keydown('Escape');
  assert.equal(h.visible('modal-range'), true, 'the range modal is never dismissed with Escape');
  await rotateSticks(h, A);
  await h.run(h.click('btn-range-done'));
  assert.equal(h.peek().busy, false);
  assert.equal(h.peek().unsaved, true);
  assert.equal(A.counts.range, 2);
});

// ---------------------------------------------------------------- difetti noti (todo)

// Scollega A a metà passata e ricollega B dallo stesso tab.
async function replugMidPass() {
  const { h, A, B } = await setup({ devices: 2, drift: DRIFTING });
  await h.click('btn-quick');
  const orphan = h.click('btn-quick-go');
  await h.advance(3000);
  assert.ok(A.counts.begin === 1 && A.counts.sample > 0, 'pass 1 is running on A');
  A.unplug();
  h.hid.fire('disconnect', A);
  h.hid.chooser.push(B);
  await h.run(h.click('btn-connect'));
  return { h, A, B, orphan };
}

// WS1: il ciclo usa il controller catturato e controlla isCurrent() dopo ogni
// await (repro B del report robustezza: prima erano {A: 14, B: 14}).
test('a replug mid-pass sends no command to the new controller', async () => {
  const { h, A, B, orphan } = await replugMidPass();
  const commandsOnA = hidCommands(A);
  await h.run(orphan);
  assert.equal(hidCommands(B), 0);
  assert.equal(hidCommands(A), commandsOnA, 'nothing more reaches the unplugged controller either');
  assert.equal(h.peek().ds5.device, B);
  const quick = h.sessions().filter(s => s.kind === 'quick').at(-1);
  assert.equal(quick.aborted, 'disconnected');
});

// Repro C: prima "Cannot read properties of null (reading 'calibBegin')".
test('a disconnect mid-pass is recorded as disconnected, not as a generic error', async () => {
  const { h, A } = await setup({ drift: DRIFTING });
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(3000);
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.run(running);
  const quick = h.sessions().filter(s => s.kind === 'quick').at(-1);
  assert.equal(quick.aborted, 'disconnected');
});

test('an orphan loop cannot release the busy flag of a newer operation', async () => {
  const { h, orphan } = await replugMidPass();
  // Il Quick resta disabilitato finché l'orfano non esce (altro effetto
  // stantio), ma il wizard si avvia: `busy` è stato azzerato dal teardown.
  await h.click('btn-wizard');
  const start = h.click('btn-wizard-next');
  assert.equal(h.peek().busy, true, 'the wizard owns the controller');
  await h.run(orphan);
  await h.run(start);
  assert.equal(h.peek().busy, true, 'the orphan loop must not release the wizard\'s busy flag');
});

test('a disconnect during adopt returns to the hero view', async () => {
  const clock = new VClock();
  const A = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [A] }); // adopt è fermo su getInfo
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.advance(2000);
  assert.equal(h.visible('view-hero'), true);
  assert.equal(h.visible('view-device'), false);
});

test('auto-connect and a Connect click adopt the controller once', async () => {
  const clock = new VClock();
  const A = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [A], chooser: [A] });
  await h.run(h.click('btn-connect'));
  await h.advance(3000);
  assert.equal(connectEvents(h), 1);
});

test('a double Retest runs one drift chain', async () => {
  const { h } = await setup();
  await h.click('btn-retest');
  await h.click('btn-retest');
  assert.equal(h.pendingRaf(h.ctx.driftTick), 1);
});

test('a drift test in a hidden tab analyses at most ~3 s of samples', async () => {
  const { h } = await setup();
  h.setHidden(true);
  await h.click('btn-retest');
  await h.advance(60_000);
  // 3 s a ~250 Hz = ~750 campioni: il limite è 3× il previsto.
  const samples = h.peek().driftTest?.samples.length ?? 0;
  h.setHidden(false);
  assert.ok(samples <= 3 * 750, `${samples} samples buffered`);
  // Il test si è chiuso da solo sugli input report, senza aspettare rAF.
  assert.equal(h.peek().driftTest, null);
  assert.equal(h.sessions().filter(s => s.kind === 'drift').length, 2);
});

test('teardown resets the per-device state', async () => {
  const { h, A } = await setup();
  await h.click('btn-wizard');
  A.unplug();
  h.hid.fire('disconnect', A);
  const state = h.peek();
  assert.deepEqual({ ...state.sticks }, { lx: 0, ly: 0, rx: 0, ry: 0 }); // oggetto di un altro realm (vm)
  assert.equal(state.wizard, null);
  assert.equal(state.lastDriftResult, null);
  assert.equal(state.quickPreflightBlocked, false);
});

// ---------------------------------------------------------------- protocollo nella pagina (WS4)

// Una risposta che non arriva mai: il receive resta appeso per sempre.
function hangReplies(dev, predicate) {
  const receive = dev.receiveFeatureReport.bind(dev);
  dev.receiveFeatureReport = id => (predicate(id, dev.commandLog.at(-1)) ? new Promise(() => {}) : receive(id));
}
const nvsSends = (dev, second) => dev.commandLog.filter(c => c.id === 0x80 && c.bytes[0] === 3 && c.bytes[1] === second).length;
// Modifica il modello NVS del fake dopo ogni comando 0x80.
function patchNvs(dev, after) {
  const original = dev.nvsCommand.bind(dev);
  dev.nvsCommand = buf => { original(buf); after(buf, dev); };
}
const NV_WORD = { unlocked: [0x81, 3, 3, 2, 0], pending_reboot: [0x81, 0x15, 1, 1, 0], unknown: [0x81, 0x12, 0x34, 0x56, 0x78] };

async function setupWith(prepare) {
  const clock = new VClock();
  const A = makeDevice(clock, { seed: 11 });
  prepare?.(A, clock);
  const h = await loadApp({ clock, authorized: [A] });
  await h.advance(5000);
  return { h, clock, A };
}

test('a missing calibEnd reply rejects within 1.1 s, poisons the controller, releases busy and marks unsaved', async () => {
  // Stick con drift: da WS1 una partenza già centrata non invia comandi.
  const { h, A } = await setup({ drift: DRIFTING });
  hangReplies(A, (id, last) => id === 0x83 && last?.op === 'end');
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  const endSentAt = A.commandLog.find(c => c.op === 'end').t;
  assert.ok(h.clock.now() - endSentAt <= 1100, `failed ${h.clock.now() - endSentAt} ms after calibEnd`);
  const state = h.peek();
  assert.ok(state.ds5.poisoned, 'the device is poisoned');
  assert.equal(state.busy, false);
  assert.equal(state.unsaved, true, 'a commit that timed out counts as committed');
  assert.equal(h.visible('banner-unsaved'), true);
  assert.equal(h.$('chip-nvs').textContent, 'Not responding');
  assert.ok(h.toasts().includes(POISONED_MESSAGE));
  // Nessun altro comando su questa connessione, nemmeno dal gate della UI.
  const sent = A.commandLog.length;
  await h.advance(300); // il modale Quick finisce di chiudersi
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), false);
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await h.advance(3000);
  assert.equal(A.commandLog.length, sent);
});

test('a missing calibSample reply poisons without marking unsaved (nothing was committed)', async () => {
  // Stick con drift: da WS1 una partenza già centrata non invia comandi.
  const { h, A } = await setup({ drift: DRIFTING });
  hangReplies(A, (id, last) => id === 0x83 && last?.op === 'sample');
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.ok(h.peek().ds5.poisoned);
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.peek().busy, false);
  assert.equal(A.counts.end, 0);
});

test('a timeout during flash says the memory state is unknown and retries nothing', async () => {
  const { h, A } = await setup();
  h.ctx.setUnsaved(true);
  hangReplies(A, (id, last) => id === 0x81 && last?.bytes[0] === 3 && last?.bytes[1] === 1);
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));
  assert.ok(h.toasts().includes(NV_UNKNOWN_MESSAGE));
  assert.equal(h.toasts().includes(POISONED_MESSAGE), false, 'one message, the one about memory');
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.peek().busy, false);
  assert.equal(nvsSends(A, 2), 1, 'unlock once');
  assert.equal(nvsSends(A, 1), 1, 'no lock retry after a timeout');
  assert.equal(h.sessions().filter(e => e.kind === 'flash').at(-1).ok, false);
});

test('an unlocked status after flash leaves unsaved=true and blocks further calibration', async () => {
  const { h, A } = await setup();
  patchNvs(A, (buf, dev) => { if (buf[0] === 3 && buf[1] === 1) { dev.nvState = 'unlocked'; dev.nvResponse = NV_WORD.unlocked; } });
  h.ctx.setUnsaved(true);
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));
  assert.equal(h.peek().unsaved, true);
  assert.ok(h.toasts().some(t => t.startsWith('Save not confirmed')));
  assert.equal(h.$('chip-nvs').textContent, 'Memory unlocked');
  const flash = h.sessions().filter(e => e.kind === 'flash').at(-1);
  assert.deepEqual([flash.ok, flash.nv], [false, 'unlocked']);
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), false);
});

test('a lock that fails once after a successful unlock is retried once and the save succeeds', async () => {
  let lockAttempts = 0;
  const { h, A } = await setupWith(dev => {
    dev.faults.push(({ id, buf }) => (id === 0x80 && buf[0] === 3 && buf[1] === 1 && ++lockAttempts === 1 ? new Error('pipe') : null));
  });
  h.ctx.setUnsaved(true);
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));
  assert.equal(lockAttempts, 2);
  assert.equal(nvsSends(A, 2), 1, 'unlock is never retried');
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.$('chip-nvs').textContent, 'Memory locked (normal)');
});

test('a flash that fails re-reads the NVS status in the catch', async () => {
  const { h, A } = await setupWith(dev => {
    dev.faults.push(({ id, buf }) => (id === 0x80 && buf[0] === 3 && buf[1] === 1 ? new Error('pipe') : null));
  });
  h.ctx.setUnsaved(true);
  const queriesBefore = nvsSends(A, 3);
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));
  assert.equal(nvsSends(A, 3), queriesBefore + 1);
  assert.equal(h.$('chip-nvs').textContent, 'Memory unlocked', 'the lock never landed: the chip says so');
  assert.equal(h.peek().unsaved, true);
  assert.ok(h.toasts().some(t => t.startsWith('Error while saving')));
});

test('Range code 3 (already closed) does not set unsaved', async () => {
  const { h, A } = await setup();
  const command = A.command.bind(A);
  A.command = (id, buf) => { command(id, buf); if (id === 0x82 && buf[2] === 2 && buf[0] === 2) A.response = [0x83, 1, 2, 3]; };
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await rotateSticks(h, A);
  await h.run(h.click('btn-range-done'));
  assert.equal(h.peek().busy, false);
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.sessions().filter(e => e.kind === 'range').at(-1).alreadyClosed, true);
});

test('connecting sends only reads: NVS status and serial, never a write', async () => {
  const { A } = await setup();
  assert.equal(A.commandLog.filter(c => c.id === 0x82).length, 0);
  const nvs = A.commandLog.filter(c => c.id === 0x80).map(c => c.bytes.slice(0, 2).join(','));
  assert.ok(nvs.length >= 2);
  assert.ok(nvs.every(b => b === '3,3' || b === '1,19'), `unexpected 0x80 command: ${nvs}`);
});

test('a confirmed unlocked NVS at connect blocks every calibration, but not the drift test', async () => {
  const { h, A } = await setupWith(dev => { dev.nvState = 'unlocked'; });
  assert.equal(h.$('chip-nvs').textContent, 'Memory unlocked');
  assert.match(h.$('chip-nvs').title, /changes may be permanent\. Restart the controller\./);
  assert.ok(h.toasts().some(t => t.startsWith('Memory unlocked: changes may be permanent')));
  await h.click('btn-quick');
  await h.click('btn-wizard');
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  assert.equal(h.visible('modal-quick'), false);
  assert.equal(h.visible('modal-wizard'), false);
  assert.equal(h.visible('modal-range'), false);
  assert.equal(A.commandLog.filter(c => c.id === 0x82).length, 0);
  assert.equal(h.sessions().filter(e => e.kind === 'drift').length, 1);
});

test('an unknown NVS status shows a warning chip and still allows calibration', async () => {
  const { h } = await setupWith(dev => patchNvs(dev, (buf, d) => { d.nvResponse = NV_WORD.unknown; }));
  assert.equal(h.$('chip-nvs').textContent, 'Memory state unknown');
  assert.ok(h.$('chip-nvs').classList.contains('chip-warn'));
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), true);
});

test('a pending reboot shows a restart hint', async () => {
  const { h } = await setupWith(dev => patchNvs(dev, (buf, d) => { d.nvResponse = NV_WORD.pending_reboot; }));
  assert.equal(h.$('chip-nvs').textContent, 'Restart required');
  assert.ok(h.toasts().some(t => /restart it/.test(t)));
});

test('firmware built in 2020–2021 asks for confirmation once per connection, never blocks', async () => {
  const report20 = new Uint8Array(64);
  report20[0] = 0x20;
  report20.set(Buffer.from('Jun 24 2021', 'latin1'), 1);
  const { h } = await setupWith(dev => {
    const receive = dev.receiveFeatureReport.bind(dev);
    dev.receiveFeatureReport = id => (id === 0x20 ? Promise.resolve(new DataView(report20.slice().buffer)) : receive(id));
  });
  let asked = 0;
  let answer = false;
  h.window.confirm = () => { asked += 1; return answer; };
  await h.click('btn-quick');
  assert.equal(asked, 1);
  assert.equal(h.visible('modal-quick'), false, 'declined: nothing opens');
  answer = true;
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), true);
  await h.click('btn-quick-cancel');
  await h.advance(300);
  await h.click('btn-quick');
  assert.equal(asked, 2, 'not asked again on the same connection');
  assert.equal(h.sessions().find(e => e.kind === 'connect').build, 'Jun 24 2021', 'kept in the local event only');
});

test('a controller that never answers at connect is shown as not responding', async () => {
  const { h, A } = await setupWith(dev => hangReplies(dev, id => id === 0x20));
  assert.equal(h.visible('view-device'), true);
  assert.ok(h.peek().ds5.poisoned);
  assert.equal(h.$('chip-nvs').textContent, 'Not responding');
  assert.equal(A.commandLog.length, 0, 'after the timeout not even the serial or NVS read is sent');
});

// ---------------------------------------------------------------- boot e riconnessione (WS4)

test('boot picks the authorized USB DualSense over a Bluetooth one', async () => {
  const clock = new VClock();
  const bt = makeDevice(clock, { seed: 3, name: 'BT' });
  bt.collections = [{ inputReports: [{ reportId: 0x31 }], featureReports: [] }];
  const usb = makeDevice(clock, { seed: 4, name: 'USB' });
  const h = await loadApp({ clock, authorized: [bt, usb] });
  await h.advance(2000);
  assert.equal(h.peek().ds5.device, usb);
  assert.equal(h.visible('view-device'), true);
});

test('the Connect button shows "Connecting…" while a controller is being adopted', async () => {
  const clock = new VClock();
  const A = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [A] });
  assert.equal(h.$('btn-connect').textContent, 'Connecting…');
  assert.equal(h.$('btn-connect').disabled, true);
  await h.advance(2000);
  assert.equal(h.$('btn-connect').textContent, 'Connect DualSense');
  assert.equal(h.$('btn-connect').disabled, false);
});

test('a DualSense that comes back after a restart is adopted automatically', async () => {
  const { h, clock, A } = await setup();
  A.unplug();
  h.hid.fire('disconnect', A);
  assert.equal(h.visible('view-hero'), true);
  const other = makeDevice(clock, { seed: 21 });
  other.productId = 0x0df2; // DualSense Edge: non supportato, ignorato
  h.hid.fire('connect', other);
  await h.advance(2000);
  assert.equal(h.peek().ds5, null);
  const back = makeDevice(clock, { seed: 22 });
  h.hid.fire('connect', back);
  await h.advance(2000);
  assert.equal(h.peek().ds5.device, back);
  assert.equal(h.visible('view-device'), true);
  assert.equal(connectEvents(h), 2);
});

test('an auto-connect that cannot open the device explains why in the hero', async () => {
  const clock = new VClock();
  const A = makeDevice(clock);
  A.opened = false;
  A.open = () => Promise.reject(new Error('Failed to open the device.'));
  const h = await loadApp({ clock, authorized: [A] });
  await h.advance(1000);
  assert.equal(h.visible('hero-error'), true);
  assert.match(h.$('hero-error').innerHTML, /couldn’t be opened/);
  assert.equal(h.visible('connect-help'), true, 'the checklist explains what to try next');
  assert.equal(h.$('btn-connect').disabled, false);
});

// ---------------------------------------------------------------- test drift (WS4)

test('the drift stability window is exactly DRIFT_WINDOW samples; Quick keeps the legacy one', () => {
  assert.equal(DRIFT_WINDOW_LEGACY, DRIFT_WINDOW + 1);
  // Un gradino DRIFT_WINDOW campioni prima dell'ultimo: la finestra da 30 non
  // lo vede più, quella storica da 31 sì.
  const still = { lx: 0, ly: 0, rx: 0, ry: 0 };
  const samples = [...Array.from({ length: 10 }, () => ({ ...still, lx: 0.5 })), ...Array.from({ length: DRIFT_WINDOW }, () => still)];
  const last = samples.length - 1;
  const inWindow = (w) => extractStableSamples(samples, w).stable.includes(samples[last]);
  assert.equal(inWindow(DRIFT_WINDOW), true);
  assert.equal(inWindow(DRIFT_WINDOW_LEGACY), false);
  assert.equal(inWindow(undefined), false, 'default stays legacy (measureOffset, Quick verify)');
});

test('a controller that stops reporting still ends the drift test with "no data"', async () => {
  const { h, A } = await setup();
  A.stopped = true;
  await h.click('btn-retest');
  await h.advance(6000);
  assert.equal(h.peek().driftTest, null);
  assert.match(h.$('drift-status').textContent, /No data from the controller/);
});

// ---------------------------------------------------------------- storage locale (WS4)

test('a full localStorage trims the local history to 50 entries and keeps storage enabled', async () => {
  const seeded = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ kind: 'drift', i })));
  const clock = new VClock();
  const A = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [A], storage: { 'sense-calib-sessions': seeded } });
  const setItem = h.window.localStorage.setItem;
  h.window.localStorage.setItem = (key, value) => {
    if (key === 'sense-calib-sessions' && JSON.parse(value).length > 60) {
      throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    }
    setItem(key, value);
  };
  await h.advance(5000);
  // La scrittura dell'evento connect sfora la quota: storico ridotto alle
  // ultime 50 voci (connect compreso), poi il drift si aggiunge normalmente.
  const stored = h.sessions();
  assert.equal(stored.length, 51);
  assert.equal(stored.at(-1).kind, 'drift');
  assert.equal(stored.at(-2).kind, 'connect');
  assert.equal(h.eval('storageAvailable'), true);
});

test('only a SecurityError disables storage', async () => {
  const { h } = await setup();
  const setItem = h.window.localStorage.setItem;
  h.window.localStorage.setItem = () => { throw new Error('transient'); };
  await h.run(h.click('btn-retest'));
  await h.advance(4000);
  assert.equal(h.eval('storageAvailable'), true);
  h.window.localStorage.setItem = () => { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); };
  await h.run(h.click('btn-retest'));
  await h.advance(4000);
  assert.equal(h.eval('storageAvailable'), false);
  h.window.localStorage.setItem = setItem;
});

test('a stored history that is not an array is replaced instead of breaking every event', async () => {
  const clock = new VClock();
  const A = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [A], storage: { 'sense-calib-sessions': '{"x":1}' } });
  await h.advance(5000);
  assert.deepEqual(h.sessions().map(e => e.kind), ['connect', 'drift']);
});

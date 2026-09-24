import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpGate } from '../js/calib/ops.js';
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
const connectEvents = h => h.sessions().filter(s => s.kind === 'connect').length;

// ---------------------------------------------------------------- ops gate

test('the op gate keeps today\'s busy semantics and tags each op with its epoch', () => {
  const ops = createOpGate();
  assert.equal(ops.busy, false);
  const first = ops.beginOp();
  assert.equal(ops.busy, true);
  assert.equal(ops.isCurrent(first), true);
  ops.reset(); // teardown
  assert.equal(ops.busy, false);
  assert.equal(ops.isCurrent(first), false);
  const second = ops.beginOp();
  // Oggi un token scaduto libera comunque il flag: lo segnala solo col valore
  // di ritorno. È il difetto del ciclo orfano, coperto dal todo più sotto.
  assert.equal(ops.endOp(first), false);
  assert.equal(ops.busy, false);
  assert.equal(ops.endOp(second), true);
});

// ---------------------------------------------------------------- connessione

test('an authorized DualSense is adopted at boot, then the automatic drift test runs', async () => {
  const { h, A } = await setup();
  assert.equal(h.visible('view-device'), true);
  assert.equal(h.visible('view-hero'), false);
  assert.equal(h.peek().ds5.device, A);
  assert.equal(h.$('chip-nvs').textContent, 'NVS protected');
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
  for (let step = 1; step <= 4; step++) await h.run(h.click('btn-wizard-next'));
  assert.equal(h.peek().busy, false);
  assert.equal(h.peek().unsaved, true);
  assert.deepEqual([A.counts.begin, A.counts.sample, A.counts.end], [1, 4, 1]);
  const wizard = h.sessions().filter(s => s.kind === 'wizard');
  assert.equal(wizard.length, 1);
  assert.equal(wizard[0].done, true);
});

test('Range keeps the controller busy until finishRange closes the session', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range'));
  assert.equal(h.peek().busy, true);
  assert.equal(h.visible('modal-range'), true);
  h.keydown('Escape');
  assert.equal(h.visible('modal-range'), true, 'the range modal is never dismissed with Escape');
  await h.advance(16000); // sblocco a tempo di "Done"
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

test('a disconnect during adopt returns to the hero view', { todo: 'adopt: ds5 !== candidate after each await' }, async () => {
  const clock = new VClock();
  const A = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [A] }); // adopt è fermo su getInfo
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.advance(2000);
  assert.equal(h.visible('view-hero'), true);
  assert.equal(h.visible('view-device'), false);
});

test('auto-connect and a Connect click adopt the controller once', { todo: 'adopt in-flight guard' }, async () => {
  const clock = new VClock();
  const A = makeDevice(clock);
  const h = await loadApp({ clock, authorized: [A], chooser: [A] });
  await h.run(h.click('btn-connect'));
  await h.advance(3000);
  assert.equal(connectEvents(h), 1);
});

test('a double Retest runs one drift chain', { todo: 'startDriftTest cancels a running test' }, async () => {
  const { h } = await setup();
  await h.click('btn-retest');
  await h.click('btn-retest');
  assert.equal(h.pendingRaf(h.ctx.driftTick), 1);
});

test('a drift test in a hidden tab analyses at most ~3 s of samples', { todo: 'HID-driven drift completion with a sample cap' }, async () => {
  const { h } = await setup();
  h.setHidden(true);
  await h.click('btn-retest');
  await h.advance(60_000);
  // 3 s a ~250 Hz = ~750 campioni: il limite è 3× il previsto.
  const samples = h.peek().driftTest?.samples.length ?? 0;
  h.setHidden(false);
  assert.ok(samples <= 3 * 750, `${samples} samples buffered`);
});

test('teardown resets the per-device state', { todo: 'complete teardown' }, async () => {
  const { h, A } = await setup();
  await h.click('btn-wizard');
  A.unplug();
  h.hid.fire('disconnect', A);
  const state = h.peek();
  assert.deepEqual(state.sticks, { lx: 0, ly: 0, rx: 0, ry: 0 });
  assert.equal(state.wizard, null);
  assert.equal(state.lastDriftResult, null);
  assert.equal(state.quickPreflightBlocked, false);
});

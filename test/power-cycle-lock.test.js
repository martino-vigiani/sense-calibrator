// Blocco "sessione di calibrazione aperta" (review, finding 1): il blocco segue
// il controller, non l'oggetto DS5. Disconnect + Connect, un reload o un replug
// non sono uno spegnimento: la sessione resta aperta nel firmware e il
// prossimo calibBegin, rifiutato, non deve mai essere "riparato" con un
// calibEnd che committa il parziale. Tutto model-verified (DualSense virtuale),
// nessuna verifica hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';
import { onCommand } from '../ops/sim/scenarios/_hooks.mjs';

const DRIFTING = [[3.2, -0.3], [-0.1, 0.4]];

// Firmware realistico: calibBegin rifiutato finché una sessione è aperta
// (il DualSense virtuale di base la riapre da capo). Registra, per ogni
// calibEnd, quanti campioni c'erano nella sessione committata.
function realisticFirmware(dev) {
  const command = dev.command.bind(dev);
  dev.committedSamples = [];
  dev.command = (id, buf) => {
    if (id === 0x82 && buf[2] === 1 && buf[0] === 1 && dev.cal) { dev.response = [0x83, 1, 1, 3]; return; }
    if (id === 0x82 && buf[2] === 1 && buf[0] === 2 && dev.cal) dev.committedSamples.push(dev.cal[0][0].length);
    return command(id, buf);
  };
  return dev;
}

function withSerial(dev, serial) {
  const nvs = dev.nvsCommand.bind(dev);
  dev.nvsCommand = buf => {
    if (buf[0] === 1 && buf[1] === 19) {
      dev.nvResponse = [0x81, 1, 19, 2, ...new TextEncoder().encode(serial)];
      return;
    }
    nvs(buf);
  };
  return dev;
}

// Stallo alla passata 1 (2 campioni, poi un pollice fermo), Cancel: la
// sessione resta aperta nel firmware.
async function stallFirstPass({ serial = null, session } = {}) {
  const clock = new VClock();
  const dev = realisticFirmware(makeDevice(clock, { drift: DRIFTING }));
  if (serial) withSerial(dev, serial);
  onCommand(dev, 'sample', 2, () => {
    dev.touches.push({ stick: 0, t0: clock.now() + 10, dur: 60_000, tail: 100, amp: [8, 0] });
  });
  const h = await loadApp({ clock, authorized: [dev], chooser: [dev], session });
  await h.advance(5000);
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(22_000);
  await h.click('btn-quick-cancel');
  await h.run(running);
  assert.deepEqual({ begin: dev.counts.begin, end: dev.counts.end }, { begin: 1, end: 0 });
  assert.ok(dev.cal, 'the firmware session is still open');
  await h.advance(70_000); // il pollice se ne va
  return { h, clock, dev };
}

async function tryQuick(h) {
  await h.click('btn-quick');
  const go = h.click('btn-quick-go');
  await h.advance(60_000);
  await h.run(go);
}

const calibCounts = dev => ({ begin: dev.counts.begin, sample: dev.counts.sample, end: dev.counts.end });

test('stall, Disconnect button, Connect the same controller: Quick sends nothing and Write stays off', async () => {
  const { h, dev } = await stallFirstPass();
  h.confirmAnswer = true;
  await h.run(h.click('btn-disconnect'));
  await h.advance(1000);
  dev.open(); dev.stopped = false; dev.schedule();
  await h.run(h.click('btn-connect'));
  await h.advance(5000);
  assert.ok(h.peek().ds5, 'reconnected');
  assert.match(h.$('calib-outcome').innerHTML, /Restart the controller before calibrating/);
  assert.equal(h.$('btn-flash').disabled, true);
  assert.match(h.$('banner-lock').textContent, /left open/);

  const before = calibCounts(dev);
  await tryQuick(h);
  await h.run(h.click('btn-wizard'));
  assert.deepEqual(calibCounts(dev), before, 'no calibration command after the reconnect');
  assert.deepEqual(dev.committedSamples, [], 'the partial session was never committed');
  assert.ok(h.toasts().some(t => /Disconnecting it doesn’t count/.test(t)));
});

test('the Disconnect confirmation says that disconnecting is not the power-off it needs', async () => {
  const { h } = await stallFirstPass();
  let asked = null;
  h.window.confirm = text => { asked = text; return false; };
  await h.run(h.click('btn-disconnect'));
  assert.ok(h.peek().ds5, 'Cancel keeps the controller connected');
  assert.match(asked, /Disconnecting doesn’t turn it off/);
});

test('a reload keeps the block: sessionStorage carries it with no device identifier', async () => {
  const session = new Map();
  const { clock, dev } = await stallFirstPass({ session });
  assert.equal(session.get('sense-power-cycle-in-tab'), '1');
  for (const value of session.values()) assert.doesNotMatch(String(value), /[0-9a-f]{16}/, 'no key or serial stored');
  // stessa scheda, pagina nuova, stesso controller mai spento
  const h2 = await loadApp({ clock, authorized: [dev], session });
  await h2.advance(5000);
  assert.ok(h2.peek().ds5);
  assert.match(h2.$('calib-outcome').innerHTML, /reloaded/);
  const before = calibCounts(dev);
  await tryQuick(h2);
  assert.deepEqual(calibCounts(dev), before);
  assert.deepEqual(dev.committedSamples, []);
});

test('an unplug in the middle of a pass still blocks the replugged controller', async () => {
  const clock = new VClock();
  const dev = realisticFirmware(makeDevice(clock, { drift: DRIFTING }));
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  onCommand(dev, 'sample', 3, () => { clock.setTimeout(() => { dev.unplug(); h.hid.fire('disconnect', dev); }, 5); });
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(20_000);
  await h.run(running);
  assert.equal(h.peek().ds5, null);
  assert.ok(dev.cal, 'session left open by the unplug');
  dev.unplugged = false; dev.open(); dev.stopped = false; dev.schedule();
  h.hid.fire('connect', dev);
  await h.advance(5000);
  assert.ok(h.peek().ds5);
  const before = calibCounts(dev);
  await tryQuick(h);
  assert.deepEqual(calibCounts(dev), before);
  assert.equal(h.$('btn-flash').disabled, true);
  assert.deepEqual(dev.committedSamples, []);
});

test('a different controller (both serials known) is not blocked; the first one still is when it comes back', async () => {
  const { h, clock, dev } = await stallFirstPass({ serial: 'E8475C3A1B2F' });
  h.confirmAnswer = true;
  await h.run(h.click('btn-disconnect'));
  const other = withSerial(makeDevice(clock, { seed: 41, drift: DRIFTING }), 'F1111111AAAA');
  h.hid.chooser.splice(0, Infinity, other);
  await h.run(h.click('btn-connect'));
  await h.advance(5000);
  assert.equal(h.peek().ds5.device, other);
  assert.equal(h.$('btn-flash').disabled, false, 'the other controller can be written');
  await h.run(h.click('btn-disconnect'));
  dev.open(); dev.stopped = false; dev.schedule();
  h.hid.chooser.splice(0, Infinity, dev);
  await h.run(h.click('btn-connect'));
  await h.advance(5000);
  assert.equal(h.peek().ds5.device, dev);
  assert.equal(h.$('btn-flash').disabled, true, 'the controller with the open session is blocked again');
});

test('Restart clears the block; after the real power cycle Quick runs normally', async () => {
  const { h, dev } = await stallFirstPass();
  h.confirmAnswer = true;
  await h.run(h.click('btn-disconnect'));
  dev.open(); dev.stopped = false; dev.schedule();
  await h.run(h.click('btn-connect'));
  await h.advance(5000);
  await h.run(h.eval("runOutcomeAction('restart')"));
  dev.powerCycle();
  dev.unplug(); h.hid.fire('disconnect', dev);
  await h.advance(1000);
  dev.unplugged = false; dev.open(); dev.stopped = false; dev.schedule();
  h.hid.fire('connect', dev);
  await h.advance(5000);
  assert.doesNotMatch(h.$('calib-outcome').innerHTML, /Restart the controller before calibrating/);
  await tryQuick(h);
  assert.ok(dev.counts.end >= 1, 'Quick committed full passes');
  assert.ok(dev.committedSamples.every(n => n === 12), `only full sessions committed: ${dev.committedSamples}`);
});

test('a wrong "I already turned it off" never commits the partial: begin is refused and the block returns', async () => {
  const { h, dev } = await stallFirstPass();
  h.confirmAnswer = true;
  await h.run(h.click('btn-disconnect'));
  dev.open(); dev.stopped = false; dev.schedule();
  await h.run(h.click('btn-connect'));
  await h.advance(5000);
  h.eval("runOutcomeAction('powered-off')"); // confirm → true, ma non è stato spento
  assert.equal(h.$('btn-flash').disabled, false);
  const endsBefore = dev.counts.end;
  await tryQuick(h);
  assert.equal(dev.counts.end, endsBefore, 'no repair calibEnd');
  assert.deepEqual(dev.committedSamples, []);
  assert.match(h.$('calib-outcome').innerHTML, /still has a calibration session open/);
  assert.equal(h.$('btn-flash').disabled, true, 'blocked again');
  const before = calibCounts(dev);
  await tryQuick(h);
  assert.deepEqual(calibCounts(dev), before);
});

// Finding 2: uno stallo alla passata 2 non dice "Nothing was committed": la
// passata 1 ha già cambiato la RAM e la pagina alza `unsaved`.
test('a stall on pass 2 says the previous pass is active and unsaved, not "nothing was committed"', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[6, -0.3], [-0.1, 0.4]], sf: 3 });
  onCommand(dev, 'sample', 14, () => {
    dev.touches.push({ stick: 0, t0: clock.now() + 10, dur: 600_000, tail: 100, amp: [8, 0] });
  });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(80_000);
  await h.run(running);
  assert.deepEqual(calibCounts(dev), { begin: 2, sample: 14, end: 1 });
  assert.equal(h.peek().unsaved, true);
  const panel = h.$('calib-outcome').innerHTML;
  assert.match(panel, /never settled/);
  assert.doesNotMatch(panel, /Nothing was committed/);
  assert.match(panel, /Pass 2 was abandoned/);
  assert.equal(h.$('btn-flash').disabled, true);
});

// Finding 3: dopo un 'already-centered' il blocco di Write segue la misura
// appena fatta, non il verdetto catastrofico di prima.
test('catastrophic, then an already-centered Quick: Write is enabled again and the lock banner is empty', async () => {
  const clock = new VClock();
  const A = makeDevice(clock, { seed: 11, drift: [[0.2, -0.3], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [A] });
  await h.advance(5000);
  h.eval(`showOutcome(quickOutcomeView({ outcome: 'catastrophic', worst: 22, beforeWorst: 3, bestWorst: 3, committed: true, session: {} }, { nvStatus: 'locked' }))`);
  assert.equal(h.$('btn-flash').disabled, true);
  assert.match(h.$('banner-lock').textContent, /15% or more/);
  await h.click('btn-quick');
  await h.advance(100);
  const go = h.click('btn-quick-go');
  await h.advance(8000);
  await h.run(go);
  assert.match(h.$('calib-outcome').innerHTML, /Already centered: nothing was sent/);
  assert.deepEqual(calibCounts(A), { begin: 0, sample: 0, end: 0 });
  assert.equal(h.$('btn-flash').disabled, false, 'Write enabled again');
  assert.equal(h.$('banner-lock').textContent, '');
  assert.ok(h.$('banner-lock').classList.contains('hidden'));
});

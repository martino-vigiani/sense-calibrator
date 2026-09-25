import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { buildCalibrationUpload } from '../js/telemetry.js';
import { VClock } from '../ops/sim/vclock.mjs';

// WS7 sull'app reale (harness DOM-stub, DualSense virtuale, orologio virtuale):
// il wizard guidato campiona solo con l'angolo raggiunto e gli stick fermi al
// loro punto di riposo; il range si chiude solo con una copertura vera, e
// "Finish anyway" disattiva la scrittura in memoria. Risultati del modello
// (model-verified), non verifiche hardware.

const CORNERS = [
  { tx: -0.7, ty: -0.7 },
  { tx: 0.7, ty: -0.7 },
  { tx: -0.7, ty: 0.7 },
  { tx: 0.7, ty: 0.7 },
];

async function setup({ drift, seed = 21, devices = 1 } = {}) {
  const clock = new VClock();
  const devs = Array.from({ length: devices }, (_, i) => makeDevice(clock, { seed: seed + i, drift, name: `DualSense ${'AB'[i]}` }));
  const h = await loadApp({ clock, authorized: [devs[0]] });
  await h.advance(5000);
  return { h, clock, A: devs[0], B: devs[1] };
}

// La mano: spostamenti in LSB sommati alla posizione a riposo (ops/sim/fake-dualsense.mjs).
function touch(dev, entry) {
  if (entry.tail === undefined) entry.tail = 40;
  dev.touches.push(entry);
  return entry;
}
async function moveToCorner(h, dev, corner, ms = 400) {
  const t0 = h.clock.now() + 20;
  for (const stick of [0, 1]) touch(dev, { stick, t0, dur: ms, amp: [corner.tx * 120, corner.ty * 120] });
  await h.advance(ms + 250);
}
const release = (h, entry) => { entry.dur = Math.max(0, h.clock.now() - entry.t0); };

async function startWizard(h) {
  await h.click('btn-wizard');
  await h.run(h.click('btn-wizard-next'));
}

// ------------------------------------------------------------------ wizard

test('a clean guided run takes exactly 4 gated samples and shows before → after', async () => {
  const { h, A } = await setup({ drift: [[14, -9], [-2, 3]] });
  await startWizard(h);
  assert.equal(h.peek().wizard.phase, 'corner');
  for (const c of CORNERS) {
    await moveToCorner(h, A, c);
    await h.run(h.click('btn-wizard-next'));
  }
  assert.deepEqual([A.counts.begin, A.counts.sample, A.counts.end], [1, 4, 1]);
  assert.equal(h.peek().busy, false);
  assert.equal(h.peek().unsaved, true);
  const cmp = h.peek().lastWizardComparison;
  assert.ok(cmp.measured);
  assert.ok(cmp.beforeWorst > 10 && cmp.afterWorst < 2, `${cmp.beforeWorst} → ${cmp.afterWorst}`);
  assert.match(h.$('wizard-msg').innerHTML, /Left: 1\d\.\d%[^<]* → <b>0\.6% · at floor<\/b>/);
  const ev = h.sessions().filter(s => s.kind === 'wizard').at(-1);
  assert.deepEqual([ev.done, ev.samples, ev.timeouts, ev.escaped], [true, 4, 0, false]);
  assert.equal(buildCalibrationUpload(ev), null, 'wizard events never leave the browser');
});

test('Start with a thumb on a stick sends nothing and can still be cancelled', async () => {
  const { h, A } = await setup();
  const thumb = touch(A, { stick: 1, t0: h.clock.now(), dur: 60_000, at: t => 25 * Math.sin(t / 40) });
  await startWizard(h);
  assert.equal(A.counts.begin, 0);
  assert.equal(h.peek().busy, false);
  assert.equal(h.visible('btn-wizard-cancel'), true);
  assert.equal(h.$('btn-wizard-next').textContent, 'Start');
  assert.match(h.$('wizard-msg').innerHTML, /Nothing was sent/);
  release(h, thumb);
  await h.advance(200);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.begin, 1);
});

test('Continue without reaching the corner takes no sample and does not wait', async () => {
  const { h, A } = await setup();
  await startWizard(h);
  const t = h.clock.now();
  await h.run(h.click('btn-wizard-next'));
  assert.ok(h.clock.now() - t < 50);
  assert.equal(A.counts.sample, 0);
  assert.match(h.$('wizard-msg').innerHTML, /Neither stick reached the corner/);
  assert.equal(h.peek().wizard.timeouts, 0);
  // solo lo stick sinistro all'angolo
  touch(A, { stick: 0, t0: h.clock.now() + 10, dur: 300, amp: [-90, -90] });
  await h.advance(500);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 0);
  assert.match(h.$('wizard-msg').innerHTML, /The right stick didn’t reach the corner/);
});

test('a thumb held at Continue produces 0 samples; after 2 timeouts the escape is offered', async () => {
  const { h, A } = await setup();
  await startWizard(h);
  await moveToCorner(h, A, CORNERS[0]);
  // il pollice resta sullo stick destro, fermo al 23%
  const thumb = touch(A, { stick: 1, t0: h.clock.now(), dur: 60_000, amp: [30, 0] });
  await h.advance(100);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 0);
  assert.equal(h.visible('btn-wizard-escape'), false);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 0);
  assert.equal(h.peek().wizard.timeouts, 2);
  assert.equal(h.visible('btn-wizard-escape'), true);
  assert.match(h.$('wizard-msg').innerHTML, /No sample was taken/);
  // lasciato lo stick, lo stesso angolo si campiona (senza uscita)
  release(h, thumb);
  await h.advance(200);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 1);
  assert.equal(h.visible('btn-wizard-escape'), false);
  assert.equal(h.peek().wizard.escaped, false);
});

test('a creeping stick finishes only through the confirmed escape', async () => {
  const { h, A } = await setup();
  await startWizard(h);
  const t0 = h.clock.now();
  // dopo il riferimento lo stick sinistro striscia di ~20 LSB: fermo per il
  // gate di stabilità, mai di nuovo al suo punto di riposo
  touch(A, { stick: 0, t0, dur: 600_000, at: (t, ax) => (ax === 0 ? 20 * (1 - Math.exp(-(t - t0) / 3000)) : 0) });
  await moveToCorner(h, A, CORNERS[0]);
  for (let i = 0; i < 4; i++) await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 0, 'no automatic relaxation');
  assert.equal(h.visible('btn-wizard-escape'), true);
  h.confirmAnswer = false;
  await h.click('btn-wizard-escape');
  assert.equal(h.peek().wizard.escaped, false, 'the escape needs a confirmation');
  h.confirmAnswer = true;
  await h.click('btn-wizard-escape');
  assert.equal(h.peek().wizard.escaped, true);
  assert.equal(h.visible('btn-wizard-escape'), false);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 1);
  for (const c of CORNERS.slice(1)) {
    await moveToCorner(h, A, c);
    await h.run(h.click('btn-wizard-next'));
  }
  assert.deepEqual([A.counts.sample, A.counts.end], [4, 1]);
  const ev = h.sessions().filter(s => s.kind === 'wizard').at(-1);
  assert.equal(ev.escaped, true);
  assert.ok(ev.timeouts >= 2);
  assert.match(h.$('wizard-msg').innerHTML, /rest check was looser/);
});

test('a calibBegin repair that committed keeps unsaved raised when a later step fails', async () => {
  const { h, A } = await setup();
  let refuseFirstBegin = true;
  const command = A.command.bind(A);
  A.command = (id, buf) => {
    command(id, buf);
    if (id === 0x82 && buf[2] === 1 && buf[0] === 1 && refuseFirstBegin) {
      refuseFirstBegin = false;
      A.response = [0x83, 1, 1, 9];
    }
  };
  A.faults.push(({ op }) => (op === 'sample' ? new Error('sample refused') : null));
  await startWizard(h);
  assert.equal(A.counts.end, 1, 'the stale-session repair committed');
  await moveToCorner(h, A, CORNERS[0]);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.peek().busy, false);
  // Esito nel pannello persistente (WS5), non in un toast.
  assert.match(h.$('calib-outcome').innerHTML, /Guided calibration failed/);
});

test('an HID error inside the open wizard session requires a power cycle before any other command', async () => {
  const { h, A } = await setup();
  let n = 0;
  A.faults.push(({ op }) => (op === 'sample' && ++n === 2 ? new Error('sample refused') : null));
  await startWizard(h);
  for (const c of CORNERS.slice(0, 2)) {
    await moveToCorner(h, A, c);
    await h.run(h.click('btn-wizard-next'));
  }
  assert.deepEqual([A.counts.begin, A.counts.end], [1, 0], 'session left open, nothing committed');
  assert.equal(h.peek().unsaved, false, 'an open session is not a commit');
  assert.equal(h.peek().busy, false);
  assert.equal(h.$('btn-flash').disabled, true);
  const panel = h.$('calib-outcome').innerHTML;
  assert.doesNotMatch(panel, /Nothing was changed/);
  assert.match(panel, /left mid-calibration/);
  await h.advance(1000);
  const sent = A.commandLog.length;
  await h.click('btn-quick');
  assert.equal(h.visible('modal-quick'), false);
  await h.click('btn-wizard');
  assert.equal(h.visible('modal-wizard'), false);
  assert.equal(A.commandLog.length, sent, 'the partial session is never committed by a repair');
});

test('an unplug during the wizard wait sends nothing to the next controller and shows no failure toast', async () => {
  const { h, A, B } = await setup({ devices: 2 });
  await startWizard(h);
  await moveToCorner(h, A, CORNERS[0]);
  touch(A, { stick: 0, t0: h.clock.now(), dur: 60_000, amp: [30, 0] }); // attesa lunga
  const orphan = h.click('btn-wizard-next');
  await h.advance(1000);
  A.unplug();
  h.hid.fire('disconnect', A);
  h.hid.chooser.push(B);
  await h.run(h.click('btn-connect'));
  await h.run(orphan);
  await h.advance(6000);
  assert.equal(B.counts.begin + B.counts.sample + B.counts.end, 0);
  assert.equal(h.toasts().some(t => t.startsWith('Calibration failed')), false);
  assert.equal(h.sessions().filter(s => s.kind === 'wizard').at(-1).aborted, 'disconnected');
});

// ------------------------------------------------------------------ range

function rotate(h, dev, { turns, secPerTurn = 0.8, dir = 1, amp = 127.5, sticks = [0, 1], from = h.clock.now() + 10 }) {
  const dur = turns * secPerTurn * 1000;
  for (const stick of sticks) {
    touch(dev, {
      stick, t0: from, dur, tail: 1,
      at: (t, ax) => {
        const a = dir * 2 * Math.PI * (t - from) / (secPerTurn * 1000);
        return amp * (ax === 0 ? Math.cos(a) : Math.sin(a));
      },
    });
  }
  return from + dur;
}
async function rotateBothWays(h, dev, opts = {}) {
  const end = rotate(h, dev, { turns: 2.2, ...opts });
  const end2 = rotate(h, dev, { turns: 1.2, dir: -1, from: end, ...opts });
  await h.advance(end2 - h.clock.now() + 100);
}

test('Range opens on an intro that sends nothing and says the only way out once started', async () => {
  const { h, A } = await setup();
  const sent = A.commandLog.length;
  await h.run(h.click('btn-range'));
  assert.equal(h.visible('modal-range'), true);
  assert.equal(A.counts.range, 0, 'no rangeBegin before Start');
  assert.equal(h.peek().busy, false);
  assert.equal(h.visible('range-intro'), true);
  assert.equal(h.visible('btn-range-done'), false);
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const intro = html.slice(html.indexOf('id="range-intro"'), html.indexOf('id="range-msg"')).replace(/\s+/g, ' ');
  assert.match(intro, /no Cancel/);
  assert.match(intro, /only way out without finishing is to turn the controller off/);
  assert.doesNotMatch(html, /If you close without rotating/, 'no copy promises a close that does not exist');
  assert.equal(h.visible('range-intro-pinned'), false);
  // Cancel ed Esc chiudono senza comandi.
  await h.click('btn-range-cancel');
  await h.advance(400);
  assert.equal(h.visible('modal-range'), false);
  await h.run(h.click('btn-range'));
  h.keydown('Escape');
  await h.advance(400);
  assert.equal(h.visible('modal-range'), false, 'Escape dismisses the intro');
  assert.equal(A.commandLog.length, sent);
  // Start apre la sessione: da lì niente Cancel né Esc.
  await h.run(h.click('btn-range'));
  await h.run(h.click('btn-range-start'));
  assert.equal(A.counts.range, 1);
  assert.equal(h.peek().busy, true);
  assert.equal(h.visible('btn-range-cancel'), false);
  assert.equal(h.visible('btn-range-done'), true);
  h.keydown('Escape');
  assert.equal(h.visible('modal-range'), true);
});

test('a pinned stick is warned on the Range intro that the range may never complete', async () => {
  const { h, A } = await setup();
  h.eval('centerState = { outcome: "centered", worst: 1, pinned: true, committed: true }');
  await h.run(h.click('btn-range'));
  assert.equal(h.visible('range-intro-pinned'), true);
  assert.match(h.$('range-intro-pinned').textContent, /may never reach the opposite side/);
  assert.match(h.$('range-intro-pinned').textContent, /Guided/);
  assert.equal(A.counts.range, 0);
});

test('zero motion never enables Done, not even as Finish anyway', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  for (let s = 0; s < 6; s++) {
    await h.advance(10_000);
    assert.equal(h.$('btn-range-done').disabled, true, `at ${(s + 1) * 10} s`);
  }
  assert.equal(h.$('range-pct').textContent, 'Coverage 0%');
  assert.match(h.$('range-hint').textContent, /turn the controller off/);
  await h.run(h.ctx.finishRange());
  assert.equal(A.counts.range, 1, 'no rangeEnd');
  assert.equal(h.peek().busy, true);
});

test('a fast rotation both ways, fed from HID with rAF at 60 Hz, gives coverage 100% and a plain Done', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await rotateBothWays(h, A, { secPerTurn: 0.3 });
  await h.advance(200);
  assert.equal(h.$('range-pct').textContent, 'Coverage 100%');
  assert.equal(h.$('btn-range-done').disabled, false);
  assert.equal(h.$('btn-range-done').textContent, 'Done');
  h.confirmAnswer = false; // un range completo non chiede conferme
  await h.run(h.click('btn-range-done'));
  assert.equal(A.counts.range, 2);
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.peek().rangeWriteLock, null);
  assert.equal(h.$('btn-flash').disabled, false);
  const ev = h.sessions().filter(s => s.kind === 'range').at(-1);
  assert.deepEqual([ev.allEdges, ev.reversed, ev.finishAnyway, ev.incomplete], [true, true, false, false]);
  assert.equal(buildCalibrationUpload(ev), null, 'range fields stay local');
});

test('a stored range 1.3× too narrow still reaches 100% coverage', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await rotateBothWays(h, A, { amp: 1.3 * 127.5 });
  await h.advance(200);
  assert.equal(h.$('range-pct').textContent, 'Coverage 100%');
  assert.equal(h.$('btn-range-done').textContent, 'Done');
});

test('the check step measures circularity on the new range, then runs the drift test', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await rotateBothWays(h, A);
  await h.run(h.click('btn-range-done'));
  assert.ok(h.peek().rangeCheck, 'the modal stays open on the check step');
  assert.equal(h.visible('modal-range'), true);
  assert.equal(h.peek().busy, false, 'the check sends nothing and holds no operation');
  assert.equal(h.$('btn-range-done').textContent, 'Skip check');
  const sent = A.commandLog.length;
  const end = rotate(h, A, { turns: 1.2 });
  await h.advance(end - h.clock.now() + 200);
  assert.match(h.$('range-hint').textContent, /^Circularity error: L \d+\.\d% · R \d+\.\d% \(about 7–10% is normal\)$/);
  assert.equal(h.$('btn-range-done').textContent, 'Run drift test');
  await h.click('btn-range-done');
  assert.equal(A.commandLog.length, sent);
  assert.ok(h.peek().driftTest, 'drift test started');
  const check = h.sessions().filter(s => s.kind === 'range-check').at(-1);
  assert.equal(check.skipped, false);
  assert.equal(check.circ.length, 2);
});

test('Finish anyway names the missing directions, needs a confirmation and disables Write', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  // un giro solo, in un verso, e con lo stick destro corto a sinistra
  const end = rotate(h, A, { turns: 1, sticks: [0] });
  touch(A, { stick: 1, t0: h.clock.now() + 10, dur: 3000, tail: 1, at: (t, ax) => {
    const a = 2 * Math.PI * t / 1000;
    const x = 127.5 * Math.cos(a);
    return ax === 0 ? (x < 0 ? 0.7 * x : x) : 127.5 * Math.sin(a);
  } });
  await h.advance(Math.max(end, h.clock.now() + 3100) - h.clock.now());
  assert.equal(h.$('btn-range-done').disabled, true, 'nothing before 15 s');
  await h.advance(15_000);
  assert.equal(h.$('btn-range-done').disabled, false);
  assert.equal(h.$('btn-range-done').textContent, 'Finish anyway');
  let asked = '';
  h.window.confirm = msg => { asked = msg; return false; };
  await h.run(h.click('btn-range-done'));
  assert.match(asked, /Not reached: R left\./);
  assert.equal(A.counts.range, 1, 'declined: the session stays open');
  h.window.confirm = () => true;
  await h.run(h.click('btn-range-done'));
  assert.equal(A.counts.range, 2);
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.peek().rangeWriteLock, 'incomplete');
  assert.equal(h.$('btn-flash').disabled, true);
  await h.advance(300); // animazione di chiusura del modale
  assert.equal(h.visible('modal-range'), false);
  const nvs = A.counts.nvs;
  await h.run(h.ctx.doFlash());
  assert.equal(A.counts.nvs, nvs, 'no NVS write while the range is incomplete');
  assert.ok(h.toasts().some(t => /Writing to memory is disabled/.test(t)));
  const ev = h.sessions().filter(s => s.kind === 'range').at(-1);
  assert.deepEqual([ev.finishAnyway, ev.incomplete], [true, true]);

  // un range completo sostituisce quello incompleto e riabilita la scrittura
  await h.advance(4000);
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await rotateBothWays(h, A);
  await h.run(h.click('btn-range-done'));
  assert.equal(h.peek().rangeWriteLock, null);
  assert.equal(h.$('btn-flash').disabled, false);
});

test('a range already closed (code 3) disables Write without setting unsaved', async () => {
  const { h, A } = await setup();
  const command = A.command.bind(A);
  A.command = (id, buf) => { command(id, buf); if (id === 0x82 && buf[2] === 2 && buf[0] === 2) A.response = [0x83, 1, 2, 3]; };
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  await rotateBothWays(h, A);
  await h.run(h.click('btn-range-done'));
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.peek().rangeWriteLock, 'closed');
  assert.equal(h.$('btn-flash').disabled, true);
});

// Il seriale che ds5.getSerial legge (0x80 [1,19] → 0x81 [1,19,2,…]); il
// DualSense virtuale di base non ne ha uno.
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

async function lockThenReplug({ serialA = null, serialB = null, reason = 'incomplete' } = {}) {
  const { h, clock, A } = await setup();
  if (serialA) {
    // ricollega A col seriale per leggere la chiave locale
    A.unplug();
    h.hid.fire('disconnect', A);
  }
  const first = serialA ? withSerial(makeDevice(clock, { seed: 31 }), serialA) : A;
  if (serialA) {
    h.hid.fire('connect', first);
    await h.advance(2000);
    assert.equal(h.peek().ds5.device, first);
  }
  h.ctx.setRangeWriteLock(reason);
  first.unplug();
  h.hid.fire('disconnect', first);
  const back = makeDevice(clock, { seed: 32 });
  if (serialB) withSerial(back, serialB);
  h.hid.fire('connect', back);
  await h.advance(2000);
  assert.equal(h.peek().ds5.device, back);
  return { h, back };
}

test('the range write lock survives a replug of the same controller (H11 unverified)', async () => {
  const { h, back } = await lockThenReplug({ serialA: 'E8475C3A1B2F', serialB: 'E8475C3A1B2F' });
  assert.equal(h.peek().rangeWriteLock, 'incomplete');
  assert.equal(h.$('btn-flash').disabled, true);
  assert.ok(h.toasts().some(t => /may still have the incomplete range calibration/.test(t)));
  const nvs = back.counts.nvs;
  await h.run(h.ctx.doFlash());
  assert.equal(back.counts.nvs, nvs, 'no NVS write after a replug');
});

test('without a readable serial the reconnected controller keeps the lock (conservative)', async () => {
  for (const reason of ['incomplete', 'closed', 'error']) {
    const { h } = await lockThenReplug({ reason });
    assert.equal(h.peek().rangeWriteLock, reason);
    assert.equal(h.$('btn-flash').disabled, true);
  }
});

test('a different controller (both serials known) does not inherit the range write lock', async () => {
  const { h } = await lockThenReplug({ serialA: 'E8475C3A1B2F', serialB: 'A1B2C3D4E5F6' });
  assert.equal(h.peek().rangeWriteLock, null);
  assert.equal(h.$('btn-flash').disabled, false);
});

test('the device key is a salted hash, never the raw serial', async () => {
  const { h } = await lockThenReplug({ serialA: 'E8475C3A1B2F', serialB: 'E8475C3A1B2F' });
  const key = h.eval('rangeWriteLockKey');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(h.eval('deviceKey'), key, 'same controller, same key');
  assert.ok(!key.toLowerCase().includes('e8475c3a1b2f'));
  assert.equal(h.sessions().some(s => JSON.stringify(s).includes(key)), false, 'the key never reaches an event');
});

test('no copy presents a reconnect as a way to re-enable Write', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8'));
  const lockCopy = src.slice(src.indexOf('function rangeLockMessage'), src.indexOf('function blockedByRangeWriteLock'));
  const confirmCopy = src.slice(src.indexOf('The range calibration is incomplete.'), src.indexOf('Finish anyway?'));
  for (const text of [lockCopy, confirmCopy]) {
    assert.doesNotMatch(text, /reconnect|unplug|replug/i);
  }
});

// Stacco mentre il rangeEnd di "Finish anyway" è in volo: il blocco va
// registrato per quel controller anche se teardown è già passato (deviceKey
// azzerato), e il ricollegamento dello stesso controller non riabilita Write.
//   late    → il rangeEnd risponde dopo il teardown (riuscito, range incompleto)
//   stall   → nessuna risposta: timeout HID (1 s), error.committed
//   unplug  → cavo staccato dopo l'invio: il receive fallisce, error.committed
async function finishAnywayThenUnplug({ serial = null, backSerial = serial, mode }) {
  const { h, clock, A } = await setup();
  let dev = A;
  if (serial) {
    A.unplug();
    h.hid.fire('disconnect', A);
    dev = withSerial(makeDevice(clock, { seed: 31 }), serial);
    h.hid.fire('connect', dev);
    await h.advance(2000);
    assert.equal(h.peek().ds5.device, dev);
  }
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  const end = rotate(h, dev, { turns: 1 });
  await h.advance(end - h.clock.now() + 15_500);
  assert.equal(h.$('btn-range-done').textContent, 'Finish anyway');
  assert.equal(h.peek().rangeWriteLock, null);

  const isRangeEnd = (id, buf) => id === 0x82 && buf[2] === 2 && buf[0] === 2;
  const unplugNow = () => { dev.unplug(); h.hid.fire('disconnect', dev); };
  const send = dev.sendFeatureReport.bind(dev);
  const recv = dev.receiveFeatureReport.bind(dev);
  let rangeEndSent = false;
  dev.sendFeatureReport = (id, buf) => {
    if (!isRangeEnd(id, buf)) return send(id, buf);
    rangeEndSent = true;
    if (mode === 'stall') { dev.counts.range += 1; return new Promise(() => {}); }
    const p = send(id, buf);
    return mode === 'unplug' ? p.then(() => unplugNow()) : p;
  };
  if (mode === 'late') {
    dev.receiveFeatureReport = id => {
      const p = recv(id);
      return rangeEndSent ? new Promise(r => clock.setTimeout(() => r(p), 500)) : p;
    };
  }
  h.confirmAnswer = true;
  const done = h.click('btn-range-done');
  await h.advance(100);
  assert.ok(rangeEndSent, 'rangeEnd went out');
  if (mode !== 'unplug') {
    assert.ok(h.peek().ds5, 'rangeEnd still in flight');
    // late: il cavo resta (il receive risponde comunque); stall: staccato
    if (mode === 'stall') dev.unplug();
    h.hid.fire('disconnect', dev);
  }
  assert.equal(h.peek().ds5, null, 'teardown ran while rangeEnd was pending');
  await h.run(done);
  await h.advance(1500);

  const back = makeDevice(clock, { seed: 32 });
  if (backSerial) withSerial(back, backSerial);
  h.hid.fire('connect', back);
  await h.advance(2000);
  assert.equal(h.peek().ds5.device, back);
  return { h, back };
}

for (const { mode, reason } of [
  { mode: 'late', reason: 'incomplete' },
  { mode: 'stall', reason: 'error' },
  { mode: 'unplug', reason: 'error' },
]) {
  for (const serial of ['E8475C3A1B2F', null]) {
    test(`Finish anyway, unplug while rangeEnd is in flight (${mode}, ${serial ? 'same serial' : 'no serial'}): the replugged controller cannot write`, async () => {
      const { h, back } = await finishAnywayThenUnplug({ serial, mode });
      assert.equal(h.peek().rangeWriteLock, reason);
      assert.equal(h.$('btn-flash').disabled, true);
      assert.ok(h.toasts().some(t => /may still have the incomplete range calibration/.test(t)));
      const nvs = back.counts.nvs;
      await h.run(h.ctx.doFlash());
      assert.equal(back.counts.nvs, nvs, 'no NVS command after the replug');
    });
  }
}

test('the lock set after an unplug is keyed to the unplugged controller: a different known one does not inherit it', async () => {
  // la chiave è quella letta prima del rangeEnd, non il deviceKey (già
  // azzerato da teardown) né quella del controller che si collega dopo
  const { h } = await finishAnywayThenUnplug({ serial: 'E8475C3A1B2F', backSerial: 'A1B2C3D4E5F6', mode: 'late' });
  assert.equal(h.peek().rangeWriteLock, null);
  assert.equal(h.$('btn-flash').disabled, false);
});

// Riproduzione della revisione: uscita confermata, pollice fermo sull'angolo
// al Continue → nessun campione; lasciato lo stick → campione. Lo stick
// pulito resta pulito.
test('with the escape confirmed, a thumb held still at the corner is never sampled', async () => {
  const { h, A } = await setup();
  await startWizard(h);
  await moveToCorner(h, A, CORNERS[0]);
  // pollice sinistro fermo sull'angolo (lx≈-0.66, ly≈-0.67)
  const thumb = touch(A, { stick: 0, t0: h.clock.now(), dur: 600_000, amp: [-84, -85] });
  await h.advance(100);
  await h.run(h.click('btn-wizard-next'));
  await h.run(h.click('btn-wizard-next'));
  assert.equal(h.peek().wizard.timeouts, 2);
  assert.equal(h.visible('btn-wizard-escape'), true);
  let asked = '';
  h.window.confirm = msg => { asked = msg; return true; };
  await h.click('btn-wizard-escape');
  assert.equal(h.peek().wizard.escaped, true);
  assert.match(asked, /still waits for the sticks to be still and close to where they rested/);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 0, 'no sample with a thumb held at the corner, escape or not');
  release(h, thumb);
  await h.advance(300);
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.sample, 1);
  for (const c of CORNERS.slice(1)) {
    await moveToCorner(h, A, c);
    await h.run(h.click('btn-wizard-next'));
  }
  assert.deepEqual([A.counts.sample, A.counts.end], [4, 1]);
  const cmp = h.peek().lastWizardComparison;
  assert.ok(cmp.measured && cmp.afterWorst < 2, `after ${cmp.afterWorst}%`);
});

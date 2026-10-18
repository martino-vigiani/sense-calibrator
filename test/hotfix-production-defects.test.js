import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runQuick } from '../js/calib/quick.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

const source = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

// L'algoritmo gira nel vero runQuick con dipendenze finte; il comportamento
// della pagina (banner unsaved, flash) nell'app reale dentro l'harness DOM-stub.

// Offset alto e costante: la passata 1 non raggiunge la soglia, quindi il ciclo
// arriva davvero alla passata 2 (dove, senza errori, dichiarerebbe convergenza).
const drifting = { left: { offset: 5, noise: 0.2, x: 0.05, y: 0 }, right: { offset: 0.6, noise: 0.2, x: 0.006, y: 0 } };

function quickHarness({ failBeginAt = Infinity, failEndAt = Infinity, committedError = false } = {}) {
  const calls = { begin: 0, end: 0, sample: 0 };
  const fail = message => {
    const error = new Error(message);
    if (committedError) error.committed = true;
    throw error;
  };
  const controller = {
    calibBegin: async () => { if (++calls.begin >= failBeginAt) fail('begin failed'); },
    calibSample: async () => { calls.sample += 1; },
    calibEnd: async () => { if (++calls.end >= failEndAt) fail('end failed'); },
  };
  const run = () => runQuick({
    controller,
    clock: { sleep: async () => {} },
    sampler: { waitForStable: async () => true, measureOffset: async () => drifting },
  });
  return { run, calls };
}

test('repro A: a failure in pass 2 reports committed, because pass 1 is already applied', async () => {
  const { run, calls } = quickHarness({ failBeginAt: 2 });
  const { session, outcome, committed } = await run();

  assert.equal(calls.end, 1, 'pass 1 committed exactly once before the failure');
  assert.equal(calls.begin, 2);
  assert.equal(committed, true);
  assert.equal(outcome, 'error');
  assert.equal(session.aborted, 'error');
});

test('a failure in a later calibEnd also reports committed', async () => {
  const { run, calls } = quickHarness({ failEndAt: 2 });
  const { committed } = await run();

  assert.equal(calls.end, 2);
  assert.equal(committed, true);
});

test('a failure before the first calibEnd is not committed unless the repair committed', async () => {
  for (const scenario of [{ failBeginAt: 1 }, { failEndAt: 1 }]) {
    const { committed } = await quickHarness(scenario).run();
    assert.equal(committed, false, JSON.stringify(scenario));
  }
  const { committed } = await quickHarness({ failBeginAt: 1, committedError: true }).run();
  assert.equal(committed, true, 'error.committed still marks the RAM as changed');
});

async function connectedApp(deviceOptions = {}) {
  const clock = new VClock();
  const dev = makeDevice(clock, deviceOptions);
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  return { h, dev };
}

test('in the page, a failure in pass 2 leaves the unsaved banner up', async () => {
  // Il primo campione della passata 2 fallisce: la passata 1 è già in RAM.
  // Stick sinistro a ~5% e firmware che non centra mai: la passata 1 non basta.
  const failSecondPass = ({ op, counts }) => (op === 'sample' && counts.end === 1 ? new Error('device closed') : null);
  const { h, dev } = await connectedApp({ faults: [failSecondPass], drift: [[6.2, 0.3], [0.2, 0.1]], sf: 0 });
  // Bias persistente: il centro catturato resta a 5 LSB dal riposo.
  dev.sticks[0].bias = { axis: 0, B: 5 };
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));

  assert.equal(dev.counts.end, 1);
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.visible('banner-unsaved'), true);
  assert.equal(h.peek().busy, false);
  const quick = h.sessions().filter(s => s.kind === 'quick').at(-1);
  assert.equal(quick.aborted, 'error');
  assert.match(h.$('calib-outcome').innerHTML, /Calibration failed/);
  assert.equal(h.visible('calib-outcome'), true, 'the failure stays on screen instead of a toast');
});

test('double-clicking Write runs exactly one flash()', async () => {
  const { h, dev } = await connectedApp();
  h.ctx.setUnsaved(true);
  await h.click('btn-flash');
  const first = h.click('btn-flash-go');
  const second = h.click('btn-flash-go');
  assert.equal(h.$('btn-flash-go').disabled, true, 'disabled synchronously, before any await');
  await h.run(Promise.all([first, second]));

  const unlocks = dev.commandLog.filter(c => c.id === 0x80 && c.bytes[0] === 3 && c.bytes[1] === 2);
  assert.equal(unlocks.length, 1);
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.peek().busy, false);
});

test('a second doFlash call while the first is in flight is ignored by the busy guard', async () => {
  const { h, dev } = await connectedApp();
  await h.run(Promise.all([h.ctx.doFlash(), h.ctx.doFlash()]));
  assert.equal(dev.commandLog.filter(c => c.id === 0x80 && c.bytes[1] === 2).length, 1);
  assert.equal(h.peek().busy, false);
});

test('doFlash does nothing while another operation is busy or without a controller', async () => {
  const { h, dev } = await connectedApp();
  h.eval('ops.beginOp()');
  await h.run(h.ctx.doFlash());
  assert.equal(h.$('btn-flash-go').disabled, false, 'no state change on the ignored call');
  h.eval('ops.reset()');
  await h.run(h.ctx.disconnect());
  await h.run(h.ctx.doFlash());
  assert.equal(dev.commandLog.filter(c => c.id === 0x80 && c.bytes[1] === 2).length, 0);
  assert.equal(h.$('btn-flash-go').disabled, false);
});

test('the raw NVS status word is logged after flash without gating the outcome', async () => {
  const { h } = await connectedApp();
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));

  assert.match(h.$('log').textContent, /NVS status after flash: locked \(raw 0x03030201\)/);
  const info = h.consoleCalls.find(call => call[1] === '[flash] NVS status after flash:');
  assert.deepEqual(info.slice(2), ['locked', '0x03030201']);
});

test('reopening the Write modal re-enables the confirm button', async () => {
  // Il blocco apre il modale dicendo da dove (telemetria v2: blocco o promemoria).
  assert.match(source, /\$\('btn-flash'\)\.addEventListener\('click', \(\) => openFlashModal\('block'\)\);/);
  const body = source.match(/function openFlashModal\(source = 'block'\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'openFlashModal should exist');
  assert.match(body, /^\s*\$\('btn-flash-go'\)\.disabled = false;/, 're-enabled first, at every opening');
  const { h } = await connectedApp();
  h.ctx.setUnsaved(true);
  h.$('btn-flash-go').disabled = true;
  await h.click('btn-flash');
  assert.equal(h.$('btn-flash-go').disabled, false);
});

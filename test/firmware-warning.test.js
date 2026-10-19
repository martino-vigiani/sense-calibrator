// Avviso per BDM-050 + firmware 17760256 (firmwareRefusesCalibration in
// js/ui/outcome.js): nella telemetria v2 nessuna calibrazione è mai partita su
// quella combinazione. La pagina avvisa alla connessione e nei pannelli di un
// avvio fallito, senza bloccare nulla. Tutto sul DualSense virtuale
// (model-verified), nessuna verifica hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIRMWARE_UPDATE_LINE, FIRMWARE_WARNING, firmwareRefusesCalibration } from '../js/ui/outcome.js';
import { VClock } from '../ops/sim/vclock.mjs';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';

const BAD_FW = 17760256; // 0x010F0000
const GOOD_FW = 17825834; // 0x0110002A
const BOARD_BYTE = { 'BDM-040': 0x06, 'BDM-050': 0x07 };

test('firmwareRefusesCalibration: only BDM-050 with firmware 0x010F0000', () => {
  assert.equal(BAD_FW, 0x010F0000);
  assert.equal(GOOD_FW, 0x0110002A);
  assert.equal(firmwareRefusesCalibration({ board: 'BDM-050', fw: BAD_FW }), true);
  assert.equal(firmwareRefusesCalibration({ board: 'BDM-050', fw: GOOD_FW }), false);
  assert.equal(firmwareRefusesCalibration({ board: 'BDM-040', fw: BAD_FW }), false);
  assert.equal(firmwareRefusesCalibration({ board: null, fw: null }), false);
  assert.equal(firmwareRefusesCalibration(), false);
  for (const text of [FIRMWARE_WARNING, FIRMWARE_UPDATE_LINE]) {
    assert.match(text, /^In our data so far/, 'a hint, not a fact');
    assert.match(text, /Wireless Controller Device Software/);
    assert.match(text, /Firmware updater for DualSense wireless controller/);
  }
});

// Report 0x20 con scheda e firmware (il fake di base non lo fornisce).
function withInfo(dev, { board, fw }) {
  const report = [0x20, ...Buffer.from('Sep 13 2023', 'latin1'), ...Buffer.from('10:20:30', 'latin1')];
  while (report.length < 64) report.push(0);
  report[25] = BOARD_BYTE[board];
  const bytes = Uint8Array.from(report);
  new DataView(bytes.buffer).setUint32(28, fw, true);
  const original = dev.receiveFeatureReport.bind(dev);
  dev.receiveFeatureReport = id => (id === 0x20 ? Promise.resolve(new DataView(bytes.slice().buffer)) : original(id));
  return dev;
}
// Firmware che rifiuta ogni avvio (centro e range) con il codice 3.
function refusesEveryBegin(dev) {
  const command = dev.command.bind(dev);
  dev.command = (id, buf) => {
    command(id, buf);
    if (id === 0x82 && buf[0] === 1) dev.response = [0x83, 1, buf[2], 3];
  };
  return dev;
}
async function connect({ board = 'BDM-050', fw = BAD_FW, refuse = false } = {}) {
  const clock = new VClock();
  const dev = withInfo(makeDevice(clock, { drift: [[6, -4], [-3, 3]] }), { board, fw });
  if (refuse) refusesEveryBegin(dev);
  const h = await loadApp({ clock, authorized: [dev], chooser: [dev] });
  await h.advance(5000);
  return { h, dev, clock };
}

test('the warning shows on connect for BDM-050 fw 0x010F0000, and nothing is blocked', async () => {
  const { h } = await connect();
  assert.match(h.$('device-info').innerHTML, /BDM-050/);
  assert.equal(h.visible('fw-warning'), true);
  assert.equal(h.$('fw-warning').textContent, FIRMWARE_WARNING);
  assert.equal(h.$('fw-warning').getAttribute('role'), 'status');
  for (const id of ['btn-quick', 'btn-wizard', 'btn-range']) assert.equal(h.$(id).disabled, false, id);
  assert.ok(h.sessions().some(s => s.kind === 'firmware-warning' && s.board === 'BDM-050' && s.fw === BAD_FW));
});

test('no warning with the newer firmware or another board', async () => {
  for (const device of [{ board: 'BDM-050', fw: GOOD_FW }, { board: 'BDM-040', fw: BAD_FW }]) {
    const { h } = await connect(device);
    assert.equal(h.visible('fw-warning'), false, JSON.stringify(device));
    assert.equal(h.$('fw-warning').textContent, '');
  }
});

test('the warning is written once per connection and cleared on disconnect', async () => {
  const { h, dev } = await connect();
  const writes = [];
  const el = h.$('fw-warning');
  let value = el.textContent;
  Object.defineProperty(el, 'textContent', { get: () => value, set: v => { writes.push(v); value = v; }, configurable: true });
  await h.advance(10_000);
  assert.deepEqual(writes, [], 'no rewrite while connected');
  h.confirmAnswer = true;
  await h.run(h.click('btn-disconnect'));
  assert.deepEqual(writes, ['']);
  assert.equal(h.visible('fw-warning'), false);
  h.hid.chooser.splice(0, Infinity, dev);
  dev.open(); dev.stopped = false; dev.schedule();
  await h.run(h.click('btn-connect'));
  await h.advance(5000);
  assert.deepEqual(writes, ['', FIRMWARE_WARNING]);
});

test('a refused Quick start on that firmware adds the update line; the power-off advice stays', async () => {
  const { h, dev } = await connect({ refuse: true });
  await h.click('btn-quick');
  const go = h.click('btn-quick-go');
  await h.advance(30_000);
  await h.run(go);
  assert.ok(dev.counts.begin >= 1);
  assert.equal(dev.counts.sample, 0);
  const panel = h.$('calib-outcome').innerHTML;
  assert.ok(panel.includes(FIRMWARE_UPDATE_LINE), panel);
  assert.match(panel, /Turn it off \(hold PS for 10 s\)/);
  assert.ok(panel.indexOf('Turn it off') < panel.indexOf(FIRMWARE_UPDATE_LINE), 'after the power-off advice');
});

test('a refused Guided start (step 0) and a refused Range start add the update line', async () => {
  {
    const { h, dev } = await connect({ refuse: true });
    await h.click('btn-wizard');
    await h.run(h.click('btn-wizard-next'));
    await h.advance(2000);
    assert.equal(dev.counts.begin >= 1, true);
    assert.ok(h.$('calib-outcome').innerHTML.includes(FIRMWARE_UPDATE_LINE));
  }
  {
    const { h, dev } = await connect({ refuse: true });
    await h.run(h.click('btn-range'));
    await h.run(h.click('btn-range-start'));
    await h.advance(300);
    assert.equal(dev.counts.range, 1);
    const panel = h.$('calib-outcome').innerHTML;
    assert.match(panel, /Range calibration didn’t start/);
    assert.ok(panel.includes(FIRMWARE_UPDATE_LINE));
  }
  // Stesso rifiuto con il firmware nuovo: nessuna riga.
  const { h } = await connect({ fw: GOOD_FW, refuse: true });
  await h.run(h.click('btn-range'));
  await h.run(h.click('btn-range-start'));
  await h.advance(300);
  assert.equal(h.$('calib-outcome').innerHTML.includes(FIRMWARE_UPDATE_LINE), false);
});

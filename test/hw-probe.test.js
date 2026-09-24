import test from 'node:test';
import assert from 'node:assert/strict';
import { DS5 } from '../js/ds5.js';
import { parseSticks } from '../js/calib/measure.js';
import { createStickSource } from '../js/calib/sampling.js';
import { VClock } from '../ops/sim/vclock.mjs';
import { FakeDualSense, MODULE_DEFAULTS } from '../ops/sim/fake-dualsense.mjs';
import {
  decodeModuleRead, encodeModuleWrite, isModuleValues, readModuleCal, writeModuleCal,
} from '../ops/hw-probe/module-cal.mjs';
import {
  MAX_CENTER_DELTA, SPARE_PHRASE, arm, checkWriteValues, createArming, isArmed, isLocalProbeHost, writeRefusal,
} from '../ops/hw-probe/safety.mjs';
import { createProbe, evaluate, fitSlope } from '../ops/hw-probe/protocol.mjs';

// Probe R1 contro il firmware finto: tutto qui è "model-verified". Dimostra che
// il probe rispetta le proprie regole di sicurezza e che registra e valuta le
// ipotesi del modello; non dice nulla su come si comporti un DualSense vero.

function makeDev(clock, { drift = [[2.3, -1.6], [-0.7, 3.2]], module = {}, seed = 11, noise = 0.3 } = {}) {
  return new FakeDualSense({
    clock,
    seed,
    sticks: drift.map(d => ({ drift: d, noise, bias: { axis: 0, B: 0 } })),
    fw: { sf: 0, cmdMs: [2, 6] },
    timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    module,
  });
}

function connect(clock, dev) {
  const source = createStickSource(clock.now);
  dev.oninputreport = e => { const s = parseSticks(e.reportId, e.data); if (s) source.push(s); };
  const ds5 = new DS5(dev, null, { timers: clock });
  return { ds5, source };
}

function setup({ hostname = 'localhost', confirm = async () => true, ...devOpts } = {}) {
  const clock = new VClock();
  const dev = makeDev(clock, devOpts);
  const sclock = { sleep: ms => new Promise(r => clock.setTimeout(r, ms)), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const confirmations = [];
  const probe = createProbe({
    hostname,
    clock: sclock,
    confirm: async (step, text) => { confirmations.push({ step, text }); return confirm(step, text); },
    now: () => 1_700_000_000_000 + clock.now(),
  });
  const { ds5, source } = connect(clock, dev);
  probe.attach({ ds5, source, info: { board: 'BDM-030' }, identity: 'serial-A' });
  const run = (id, opts) => clock.run(probe.run(id, opts));
  const armNow = () => probe.armWith({ spareChecked: true, phrase: SPARE_PHRASE });
  const reconnect = (target = dev, identity = 'serial-A') => {
    const c = connect(clock, target);
    probe.attach({ ds5: c.ds5, source: c.source, info: {}, identity });
  };
  return { clock, dev, probe, run, armNow, reconnect, confirmations };
}

const writes = dev => dev.moduleCounts.write;
const calibCommands = dev => dev.counts.begin + dev.counts.sample + dev.counts.end;
const unlocks = dev => dev.commandLog.filter(c => c.id === 0x80 && c.bytes[0] === 3 && c.bytes[1] === 2).length;

/* ---------------------------- codifica [12,x] ----------------------------- */

test('the [12,1] payload is exactly 12 little-endian uint16 after the opcode, and bad values are rejected', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 0x1234, 0xffff, 0, 256];
  const payload = encodeModuleWrite(values);
  assert.equal(payload.length, 26);
  assert.deepEqual(payload.slice(0, 2), [12, 1]);
  assert.deepEqual(payload.slice(18, 22), [0x34, 0x12, 0xff, 0xff]);
  for (const bad of [values.slice(0, 11), [...values, 1], values.map((v, i) => (i === 3 ? -1 : v)), values.map((v, i) => (i === 3 ? 65536 : v)), values.map((v, i) => (i === 3 ? 1.5 : v)), null])
    assert.throws(() => encodeModuleWrite(bad), RangeError);
  assert.equal(isModuleValues(values), true);
});

test('the [12,2] reply is validated like upstream: 0x81, 12, p2 in {2,4}, 2', () => {
  const reply = (head, len = 63) => {
    const b = new Uint8Array(len);
    b.set(head);
    for (let i = 0; i < 12; i++) { b[4 + 2 * i] = i; b[5 + 2 * i] = 0x80; }
    return new DataView(b.buffer);
  };
  assert.deepEqual(decodeModuleRead(reply([0x81, 12, 2, 2])).values, Array.from({ length: 12 }, (_, i) => 0x8000 + i));
  assert.equal(decodeModuleRead(reply([0x81, 12, 4, 2])).p2, 4);
  for (const head of [[0x80, 12, 2, 2], [0x81, 11, 2, 2], [0x81, 12, 3, 2], [0x81, 12, 2, 1], [0x81, 3, 3, 2]])
    assert.equal(decodeModuleRead(reply(head)), null, head.join(','));
  assert.equal(decodeModuleRead(reply([0x81, 12, 2, 2], 20)), null, 'short reply');
});

test('the fake firmware reads back what [12,1] wrote and maps centers to the report output (model-verified)', async () => {
  const clock = new VClock();
  const dev = makeDev(clock, { noise: 0 });
  const { ds5 } = connect(clock, dev);
  const first = await clock.run(readModuleCal(ds5));
  assert.deepEqual(first.values.slice(0, 8), MODULE_DEFAULTS.range);
  assert.deepEqual(first.values.slice(8), MODULE_DEFAULTS.centerBase);
  const target = [...first.values];
  target[8] += 3 * MODULE_DEFAULTS.unitsPerLsb;
  await clock.run(writeModuleCal(ds5, target));
  assert.deepEqual((await clock.run(readModuleCal(ds5))).values, target);
  assert.equal(dev.sticks[0].center[0], 3, 'LX moved by 3 output LSB');
  assert.deepEqual(dev.moduleCounts, { read: 2, write: 1 });
  assert.deepEqual([dev.counts.nvs, dev.counts.other], [0, 0], 'module commands do not touch the equivalence counters');
  // NVS bloccata: lo spegnimento riporta la RAM alla copia permanente.
  dev.powerCycle();
  assert.deepEqual((await clock.run(readModuleCal(ds5))).values, first.values);
});

/* ------------------------------ sicurezza --------------------------------- */

test('the probe host guard accepts only loopback names', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) assert.equal(isLocalProbeHost(h), true, h);
  for (const h of ['martino-vigiani.github.io', 'sense-calibrator.app', '192.168.1.5', 'localhost.evil.com', '', undefined])
    assert.equal(isLocalProbeHost(h), false, String(h));
});

test('arming needs the spare checkbox and the typed phrase, and is bound to one connection', () => {
  const a = createArming(1);
  assert.equal(arm(a, { spareChecked: true, phrase: 'spare' }), false);
  assert.equal(arm(a, { spareChecked: false, phrase: SPARE_PHRASE }), false);
  assert.equal(arm(a, { spareChecked: true, phrase: ` ${SPARE_PHRASE} ` }), true);
  assert.equal(isArmed(a, 1), true);
  assert.equal(isArmed(a, 2), false, 'a new connection is disarmed');
});

test('a write step is refused unless every condition holds', () => {
  const arming = createArming(3);
  arm(arming, { spareChecked: true, phrase: SPARE_PHRASE });
  const ok = { step: 'H-b', hostname: 'localhost', arming, connectionId: 3, nv: { status: 'locked' }, baseline: { values: [] }, poisoned: false, needsPowerCycle: false };
  assert.deepEqual(writeRefusal(ok), []);
  for (const [patch, pattern] of [
    [{ hostname: 'martino-vigiani.github.io' }, /localhost/],
    [{ connectionId: 4 }, /not armed/],
    [{ nv: { status: 'unlocked' } }, /NVS is not locked/],
    [{ nv: { status: 'unknown' } }, /NVS is not locked/],
    [{ nv: { status: 'pending_reboot' } }, /NVS is not locked/],
    [{ nv: null }, /NVS is not locked/],
    [{ baseline: null }, /baseline/],
    [{ poisoned: true }, /stopped responding/],
    [{ needsPowerCycle: true }, /power-cycle/],
    [{ step: 'flash' }, /unknown write step/],
  ]) assert.match(writeRefusal({ ...ok, ...patch }).join('; '), pattern, JSON.stringify(patch));
});

test('only values read from the controller, with bounded center deltas, may be written', () => {
  const snap = [10, 20, 30, 40, 50, 60, 70, 80, 32768, 32768, 32768, 32768];
  assert.equal(checkWriteValues(snap, [snap]).ok, true);
  const nudged = [...snap]; nudged[9] += MAX_CENTER_DELTA;
  assert.equal(checkWriteValues(nudged, [snap]).ok, true);
  const far = [...snap]; far[9] += MAX_CENTER_DELTA + 1;
  assert.match(checkWriteValues(far, [snap]).reason, /center moves/);
  const range = [...snap]; range[0] += 1;
  assert.match(checkWriteValues(range, [snap]).reason, /range fields/);
  assert.match(checkWriteValues(snap, []).reason, /no snapshot/);
  assert.equal(checkWriteValues(snap.slice(1), [snap]).ok, false);
});

test('without arming no step writes anything, and nothing is written off localhost (model-verified)', async () => {
  const { dev, run } = setup();
  assert.equal((await run('preflight')).ok, true);
  for (const id of ['H-b', 'H-c', 'H-d', 'H-e', 'AB', 'restore']) {
    const r = await run(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.refused, true, id);
    assert.match(r.error, /not armed/, id);
  }
  assert.equal(writes(dev), 0);
  assert.equal(calibCommands(dev), 0);

  const remote = setup({ hostname: 'martino-vigiani.github.io' });
  await remote.run('preflight');
  remote.armNow();
  const r = await remote.run('H-c');
  assert.match(r.error, /localhost/);
  assert.equal(writes(remote.dev) + calibCommands(remote.dev), 0);
});

test('a declined confirmation writes nothing', async () => {
  const { dev, run, armNow, confirmations } = setup({ confirm: async () => false });
  await run('preflight');
  armNow();
  for (const id of ['H-b', 'H-c', 'H-d']) assert.equal((await run(id)).error, 'not confirmed');
  assert.equal(writes(dev) + calibCommands(dev), 0);
  assert.match(confirmations.find(c => c.step === 'H-c').text, /PERMANENTLY/);
  assert.match(confirmations.find(c => c.step === 'H-d').text, /PERMANENTLY/);
  assert.doesNotMatch(confirmations.find(c => c.step === 'H-b').text, /PERMANENTLY/);
});

test('NVS not locked at preflight aborts: no baseline, and every write step is refused (model-verified)', async () => {
  const { dev, run, armNow, probe } = setup();
  dev.nvState = 'unlocked';
  const pre = await run('preflight');
  assert.equal(pre.ok, false);
  assert.match(pre.error, /NVS is unlocked, not locked: abort/);
  assert.equal(pre.nv, 'unlocked');
  armNow();
  for (const id of ['H-b', 'H-c', 'H-d', 'H-e', 'AB']) assert.equal((await run(id)).ok, false, id);
  assert.equal(writes(dev) + calibCommands(dev), 0);
  assert.equal(probe.evaluate().readbackRestore, 'no-go');
});

test('NVS unlocked later is caught by the re-read before the write (model-verified)', async () => {
  const { dev, run, armNow } = setup();
  await run('preflight');
  armNow();
  dev.nvState = 'unlocked';
  const r = await run('H-c');
  assert.match(r.error, /NVS is not locked \(unlocked\)/);
  assert.equal(writes(dev), 0);
});

test('a controller that does not answer [12,2] stops the probe before any write (model-verified)', async () => {
  const { dev, run, armNow, probe } = setup({ module: { readP2: 7 } });
  const pre = await run('preflight');
  assert.equal(pre.ok, false);
  assert.match(pre.error, /failed validation/);
  armNow();
  assert.equal((await run('H-b')).ok, false);
  assert.equal(writes(dev) + calibCommands(dev), 0);
  assert.equal(probe.evaluate().readbackRestore, 'no-go');
});

test('the probe never opens NVS or flashes, whatever it runs (model-verified)', async () => {
  const { dev, run, armNow } = setup();
  await run('preflight');
  armNow();
  for (const id of ['H-a', 'H-b', 'H-c', 'H-d', 'H-e', 'restore']) await run(id);
  assert.equal(unlocks(dev), 0);
  assert.equal(dev.nvState, 'locked');
});

/* ------------------------- protocollo completo ---------------------------- */

async function fullProtocol(opts = {}) {
  const s = setup(opts);
  const { run, armNow, reconnect, dev } = s;
  const out = {};
  out.preflight = await run('preflight');
  out.Ha = await run('H-a');
  armNow();
  out.Hb = await run('H-b');
  out.Hc = await run('H-c');
  out.Hd = await run('H-d');
  out.restoreAfterHd = await run('restore');
  out.He = await run('H-e');
  // Una passata senza restauro, così H-f ha qualcosa da far sparire.
  out.Hb2 = await run('H-b');
  out.HfPrepare = await run('H-f-prepare');
  dev.powerCycle();
  reconnect();
  out.preflight2 = await run('preflight');
  out.HfCheck = await run('H-f-check');
  return { ...s, out };
}

test('the full protocol on the default fake reads a GO for read-back and restore (model-verified)', async () => {
  const { out, probe, dev } = await fullProtocol();
  for (const [k, r] of Object.entries(out)) assert.equal(r.ok, true, `${k}: ${r.error}`);
  assert.equal(out.Ha.identical, true);
  assert.equal(out.Hb.centersChanged, true);
  assert.equal(out.Hb.rangeChanged, false);
  assert.equal(out.Hb.samples, 12);
  assert.equal(out.Hc.exact, true);
  assert.equal(out.Hd.behaviour, 'unchanged');
  assert.equal(out.He.restored, true);
  for (const axis of ['lx', 'ly', 'rx', 'ry']) {
    // +64 unità spostano il centro di +1 LSB, cioè l'uscita di −1 LSB.
    // Il rumore dello stick rende la media dell'uscita appena imprecisa.
    const units = out.He.perAxis[axis].unitsPerLsb;
    assert.ok(Math.abs(units + MODULE_DEFAULTS.unitsPerLsb) <= 0.05 * MODULE_DEFAULTS.unitsPerLsb, `${axis}: ${units}`);
    assert.ok(out.He.perAxis[axis].r2 >= 0.99, axis);
  }
  assert.equal(out.HfCheck.revertedToBaseline, true);
  assert.equal(out.HfCheck.preCycleDiffered, true);
  const ev = probe.evaluate();
  assert.equal(ev.readbackRestore, 'go', ev.reasons.join('; '));
  assert.equal(ev.subLsbNudge, 'go (research)');
  assert.equal(ev.sampleCut, 'keep 12');
  assert.match(ev.label, /model-verified/);
  assert.equal(unlocks(dev), 0);
  // Il diario esportato non porta il seriale.
  assert.doesNotMatch(probe.exportJson(), /serial-A/);
});

test('if [12,1] has no effect the restore criterion fails and the verdict is NO-GO (model-verified)', async () => {
  const { out, probe } = await fullProtocol({ module: { writeApplies: false } });
  assert.equal(out.Hc.exact, false);
  const ev = probe.evaluate();
  assert.equal(ev.verdict.restoreExact, 'fail');
  assert.equal(ev.readbackRestore, 'no-go');
});

test('a calibration that survives a locked power-cycle fails H-f (model-verified)', async () => {
  const s = setup();
  await s.run('preflight');
  s.armNow();
  await s.run('H-b');
  await s.run('H-f-prepare');
  // Ipotesi da escludere: la RAM sopravvive allo spegnimento.
  s.dev.stored = s.dev.snapshotCal();
  s.dev.powerCycle();
  s.reconnect();
  await s.run('preflight');
  const check = await s.run('H-f-check');
  assert.equal(check.revertedToBaseline, false);
  assert.equal(s.probe.evaluate().verdict.revertsOnPowerCycle, 'fail');
  assert.equal(s.probe.evaluate().readbackRestore, 'no-go');
});

test('H-d tells a zero-sample calibEnd that resets the center from one that keeps it (model-verified)', async () => {
  const s = setup({ module: { zeroSampleEnd: 'raw' } });
  await s.run('preflight');
  s.armNow();
  await s.run('H-b');
  const hd = await s.run('H-d');
  assert.equal(hd.ok, true);
  assert.equal(hd.behaviour, 'changed');
  assert.ok(['LX', 'LY', 'RX', 'RY'].some(k => k in hd.diff));
  assert.deepEqual(Object.keys(hd.diff).filter(k => !['LX', 'LY', 'RX', 'RY'].includes(k)), []);
  assert.equal(s.dev.counts.sample, 12, 'H-d sends no calibSample');
});

test('a reconnect disarms, and H-f-check refuses the same connection or another controller', async () => {
  const s = setup();
  await s.run('preflight');
  s.armNow();
  await s.run('H-f-prepare');
  assert.match((await s.run('H-f-check')).error, /reconnect first/);
  s.reconnect();
  assert.equal(s.probe.armed(), false);
  await s.run('preflight');
  const w = s.dev.moduleCounts.write;
  assert.match((await s.run('restore')).error, /not armed/);
  assert.equal(s.dev.moduleCounts.write, w);
  const other = makeDev(s.clock, { seed: 99 });
  s.reconnect(other, 'serial-B');
  assert.match((await s.run('H-f-check')).error, /different controller/);
});

test('a pass that never gets a stable window is abandoned without calibEnd and blocks further writes (model-verified)', async () => {
  const s = setup();
  await s.run('preflight');
  s.armNow();
  // Pollice che si muove dopo calibBegin: nessuna finestra vicina al riferimento.
  s.dev.touches.push({ stick: 0, t0: s.clock.now() + 2500, dur: 60000, tail: 10, at: t => 30 * Math.sin(t / 40) });
  const r = await s.run('H-b');
  assert.equal(r.ok, false);
  assert.equal(r.needsPowerCycle, true);
  assert.equal(s.dev.counts.end, 0, 'never calibEnd on an incomplete pass');
  assert.equal(s.dev.counts.begin, 1);
  assert.ok(s.dev.counts.sample < 12);
  const writesBefore = s.dev.moduleCounts.write;
  assert.match((await s.run('restore')).error, /power-cycle/);
  assert.equal(s.dev.moduleCounts.write, writesBefore);
});

test('the A/B runs both arms, restores the start and needs 5 reps to decide (model-verified)', async () => {
  const s = setup();
  await s.run('preflight');
  s.armNow();
  const before = s.dev.moduleValues();
  const ab = await s.run('AB', { reps: 2 });
  assert.equal(ab.ok, true, ab.error);
  assert.equal(ab.runs.length, 4);
  assert.deepEqual(ab.runs.map(r => r.samples), [12, 4, 12, 4]);
  assert.equal(s.dev.counts.sample, 2 * (12 + 4));
  assert.equal(ab.restored, true);
  assert.deepEqual(s.dev.moduleValues(), before);
  assert.equal(s.probe.evaluate().verdict.fourSamples, 'inconclusive');
});

test('fitSlope is a least-squares line through the origin', () => {
  const f = fitSlope([{ delta: 64, out: -1 }, { delta: -64, out: 1 }, { delta: 128, out: -2 }, { delta: -128, out: 2 }]);
  assert.equal(f.unitsPerLsb, -64);
  assert.equal(f.r2, 1);
  assert.equal(fitSlope([{ delta: 64, out: 0 }]).unitsPerLsb, null);
});

test('evaluate on an empty record is NO-GO and lists what is missing', () => {
  const ev = evaluate({ connections: [], steps: [] });
  assert.equal(ev.readbackRestore, 'no-go');
  assert.equal(ev.verdict.readStable, 'missing');
});

/* ------------------- identità del controller sconosciuta ------------------- */

// Due controller con bordi del range diversi: se il probe scrivesse la
// baseline di A su B, B finirebbe con i bordi di A.
const RANGE_A = [2000, 2000, 2000, 2000, 60000, 60000, 60000, 60000];
const RANGE_B = [3000, 3000, 3000, 3000, 62000, 62000, 62000, 62000];

async function twoControllers(idA, idB) {
  const clock = new VClock();
  const devA = makeDev(clock, { module: { range: RANGE_A } });
  const devB = makeDev(clock, { module: { range: RANGE_B }, seed: 99 });
  const sclock = { sleep: ms => new Promise(r => clock.setTimeout(r, ms)), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const probe = createProbe({ hostname: 'localhost', clock: sclock, confirm: async () => true, now: () => 1_700_000_000_000 + clock.now() });
  const run = (id, opts) => clock.run(probe.run(id, opts));
  const armNow = () => probe.armWith({ spareChecked: true, phrase: SPARE_PHRASE });
  const a = connect(clock, devA);
  probe.attach({ ds5: a.ds5, source: a.source, info: {}, identity: idA });
  assert.equal((await run('preflight')).ok, true);
  armNow();
  assert.equal((await run('H-f-prepare')).ok, true);
  const b = connect(clock, devB);
  probe.attach({ ds5: b.ds5, source: b.source, info: {}, identity: idB });
  assert.equal((await run('preflight')).ok, true);
  armNow();
  return { clock, devA, devB, probe, run };
}

for (const [label, idA, idB] of [
  ['the first connection has no serial', null, 'serial-B'],
  ['the second connection has no serial', 'serial-A', null],
  ['neither connection has a serial', null, null],
  ['the serials are empty strings', '', ''],
]) {
  test(`${label}: no cross-connection write of the baseline and H-f-check refuses (model-verified)`, async () => {
    const s = await twoControllers(idA, idB);
    const rangeB = [...s.devB.moduleRange];
    assert.deepEqual(rangeB, RANGE_B);
    assert.equal(s.probe.record.connections[1].sameController, null, 'unknown, not true');

    // restore punta alla baseline di questa connessione, non a quella di A.
    const restore = await s.run('restore');
    assert.equal(restore.ok, true, restore.error);
    assert.deepEqual(restore.target.slice(0, 8), RANGE_B);
    assert.deepEqual(s.devB.moduleRange, rangeB, 'B keeps its own range edges');

    // H-c con la baseline di A come bersaglio esplicito: rifiutato.
    const w = s.devB.moduleCounts.write;
    const hc = await s.run('H-c', { target: s.probe.record.baseline.values });
    assert.equal(hc.ok, false);
    assert.match(hc.error, /refused write/);
    assert.equal(s.devB.moduleCounts.write, w);
    assert.deepEqual(s.devB.moduleRange, rangeB);
    assert.equal(s.devA.moduleCounts.write, 0);

    const hf = await s.run('H-f-check');
    assert.equal(hf.ok, false);
    assert.match(hf.error, /serial unavailable, cannot confirm same controller/);
    assert.equal(hf.sameController, null);
    assert.equal(s.probe.evaluate().verdict.revertsOnPowerCycle, 'missing');
  });
}

test('a third connection cannot inherit the first identity when the first serial was missing', async () => {
  const s = await twoControllers(null, 'serial-B');
  const clock = s.clock;
  const devC = makeDev(clock, { module: { range: RANGE_B }, seed: 7 });
  const c = connect(clock, devC);
  s.probe.attach({ ds5: c.ds5, source: c.source, info: {}, identity: 'serial-B' });
  // Il seriale di B non è diventato "quello della prima connessione".
  assert.equal(s.probe.record.connections[2].sameController, null);
});

test('known and different serials still refuse H-f-check as another controller', async () => {
  const s = await twoControllers('serial-A', 'serial-B');
  assert.equal(s.probe.record.connections[1].sameController, false);
  assert.match((await s.run('H-f-check')).error, /different controller/);
  const r = await s.run('restore');
  assert.deepEqual(r.target.slice(0, 8), RANGE_B);
  assert.deepEqual(s.devB.moduleRange, RANGE_B);
});

/* --------------- errore HID qualunque in mezzo a una sessione --------------- */

// Rifiuta con un Error qualunque (non un timeout) il calibSample numero `nth`
// (1-based) contato dall'installazione del guasto, una volta sola.
function failSampleOnce(dev, nth) {
  const start = dev.counts.sample;
  let fired = false;
  dev.faults.push(({ op, counts }) => {
    if (fired || op !== 'sample' || counts.sample !== start + nth - 1) return null;
    fired = true;
    return new Error('NotAllowedError: Failed to write the feature report.');
  });
}

async function assertSessionPoisoned(s, entry) {
  assert.equal(entry.ok, false);
  assert.equal(entry.needsPowerCycle, true, 'needsPowerCycle recorded in the entry');
  assert.equal(s.probe.needsPowerCycle, true);
  const begins = s.dev.counts.begin, ends = s.dev.counts.end, w = s.dev.moduleCounts.write;
  for (const step of ['restore', 'H-b', 'H-c', 'H-d', 'H-e', 'AB']) {
    const r = await s.run(step);
    assert.equal(r.ok, false, step);
    assert.match(r.error, /power-cycle/, step);
  }
  assert.equal(s.dev.counts.begin, begins, 'no calibBegin after the failure');
  assert.equal(s.dev.counts.end, ends, 'no calibEnd after the failure');
  assert.equal(s.dev.moduleCounts.write, w, 'no [12,1] after the failure');
}

test('a plain HID error on a middle calibSample during H-b poisons the session (model-verified)', async () => {
  const s = setup();
  await s.run('preflight');
  s.armNow();
  failSampleOnce(s.dev, 3);
  const r = await s.run('H-b');
  assert.equal(r.hidError, true);
  assert.equal(s.dev.counts.sample, 2);
  assert.equal(s.dev.counts.end, 0, 'no calibEnd on the incomplete pass');
  await assertSessionPoisoned(s, r);
});

test('a plain HID error on a middle calibSample during A/B skips the write-back (model-verified)', async () => {
  const s = setup();
  await s.run('preflight');
  s.armNow();
  const writesBefore = s.dev.moduleCounts.write;
  failSampleOnce(s.dev, 3);
  const r = await s.run('AB', { reps: 2 });
  assert.equal(r.hidError, true);
  assert.equal(s.dev.moduleCounts.write, writesBefore, 'the A/B finally does not write into the open session');
  assert.equal(s.dev.counts.end, 0);
  await assertSessionPoisoned(s, r);
});

test('a failing calibBegin or calibEnd also marks the connection for a power-cycle (model-verified)', async () => {
  for (const op of ['begin', 'end']) {
    for (const step of ['H-b', 'H-d']) {
      const s = setup();
      await s.run('preflight');
      s.armNow();
      let fired = false;
      s.dev.faults.push(f => (!fired && f.op === op ? (fired = true, new Error(`${op} failed`)) : null));
      const r = await s.run(step);
      assert.equal(r.hidError, true, `${step}/${op}`);
      await assertSessionPoisoned(s, r);
    }
  }
});

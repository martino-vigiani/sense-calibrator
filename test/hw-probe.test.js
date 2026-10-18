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
  FIX_MAX_LSB, MAX_CENTER_DELTA, SPARE_PHRASE, arm, checkFixWrite, checkWriteValues, createArming, isArmed, isLocalProbeHost, writeRefusal,
} from '../ops/hw-probe/safety.mjs';
import { CEILING_LSB, PROBE_DEFAULTS, PROBE_SCHEMA, RELEASE_DIRECTIONS, createProbe, evaluate, fitSlope } from '../ops/hw-probe/protocol.mjs';

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

// Un rilascio dello stick sinistro del finto nella direzione chiesta: spinta
// di `amp` LSB per 120 ms, poi ritorno a riposo (dove lo stick si ferma è
// s.rest, che i test di X3 spostano).
function flick(dev, clock, p, amp = 100) {
  // 'any' (il rilascio di X-fix prima della correzione): verso destra.
  const [vx, vy] = (RELEASE_DIRECTIONS.find(d => d.name === p.direction) ?? RELEASE_DIRECTIONS[0]).v;
  dev.touches.push({ stick: 0, t0: clock.now() + 100, dur: 120, tail: 40, amp: [vx * amp, vy * amp] });
}

function setup({ hostname = 'localhost', confirm = async () => true, params = {}, onPrompt = flick, ...devOpts } = {}) {
  const clock = new VClock();
  const dev = makeDev(clock, devOpts);
  const sclock = { sleep: ms => new Promise(r => clock.setTimeout(r, ms)), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const confirmations = [];
  const prompts = [];
  const probe = createProbe({
    hostname,
    clock: sclock,
    confirm: async (step, text) => { confirmations.push({ step, text }); return confirm(step, text); },
    prompt: async p => { prompts.push(p); if (p) onPrompt?.(dev, clock, p); },
    now: () => 1_700_000_000_000 + clock.now(),
    params,
  });
  const { ds5, source } = connect(clock, dev);
  probe.attach({ ds5, source, info: { board: 'BDM-030' }, identity: 'serial-A' });
  const run = (id, opts) => clock.run(probe.run(id, opts));
  const armNow = () => probe.armWith({ spareChecked: true, phrase: SPARE_PHRASE });
  const reconnect = (target = dev, identity = 'serial-A') => {
    const c = connect(clock, target);
    probe.attach({ ds5: c.ds5, source: c.source, info: {}, identity });
  };
  return { clock, dev, probe, run, armNow, reconnect, confirmations, prompts };
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

/* ------------------------- R1-X (BDM-040, X1…X4) --------------------------- */

// Parametri corti per l'orologio virtuale: la logica è la stessa dei default.
const XP = { idleMs: 20000, fixWaitMs: 2000, flickTimeoutMs: 4000, releaseFlicks: 2 };

async function r1xReady(opts = {}) {
  const s = setup({ params: XP, ...opts });
  assert.equal((await s.run('preflight')).ok, true);
  s.armNow();
  const he = await s.run('H-e');
  assert.equal(he.ok, true, he.error);
  return s;
}

async function r1xSequence(opts = {}) {
  const s = await r1xReady(opts);
  const out = {};
  out.idle = await s.run('X-idle');
  out.release = await s.run('X-release');
  out.pass = await s.run('X-pass');
  out.fix = await s.run('X-fix');
  return { ...s, out };
}

test('the record schema is sense-hw-probe/2', () => {
  assert.equal(PROBE_SCHEMA, 'sense-hw-probe/2');
  const { probe } = setup();
  assert.equal(probe.record.schema, 'sense-hw-probe/2');
  assert.match(probe.exportJson(), /"schema": "sense-hw-probe\/2"/);
});

test('leftXCapture: 0 is the default and the capture lands on left X only (model-verified)', async () => {
  assert.equal(MODULE_DEFAULTS.leftXCapture, 0);
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  const hb = await s.run('H-b');
  assert.ok(Math.abs(hb.outAfter.mean.lx + 10) <= 1, `lx after ${hb.outAfter.mean.lx}`);
  for (const a of ['ly', 'rx', 'ry']) assert.ok(Math.abs(hb.outAfter.mean[a]) <= 1, `${a} after ${hb.outAfter.mean[a]}`);
});

test('X1: a fixed +X capture on left X is confirmed and X-fix brings the output within 1 LSB (model-verified)', async () => {
  const { out, probe, dev, prompts } = await r1xSequence({ module: { leftXCapture: 10 } });
  for (const [k, r] of Object.entries(out)) assert.equal(r.ok, true, `${k}: ${r.error}`);

  assert.equal(out.idle.perSecond.length, XP.idleMs / 1000);
  assert.ok(Math.abs(out.idle.driftLx) <= 1);
  assert.equal(out.release.flicks.length, 8 * XP.releaseFlicks);
  assert.equal(out.release.missed, 0);
  assert.equal(prompts.filter(p => p?.step === 'X-release').length, 8 * XP.releaseFlicks);
  assert.equal(prompts.at(-1), null, 'the prompt is cleared at the end');

  const passes = out.pass.passes;
  assert.equal(passes.length, 5);
  assert.equal(out.pass.stoppedAtCeiling, null);
  assert.ok(Math.abs(out.pass.u.lx - MODULE_DEFAULTS.unitsPerLsb) <= 0.05 * MODULE_DEFAULTS.unitsPerLsb, `u ${out.pass.u.lx}`);
  for (const p of passes) {
    assert.ok(Math.abs(p.E.lx - 10) <= 1, `pass ${p.pass}: E.lx ${p.E.lx}`);
    assert.ok(Math.abs(p.outAfter.lx + p.E.lx) <= 1, `pass ${p.pass}: out ${p.outAfter.lx}`);
    for (const a of ['ly', 'rx', 'ry']) assert.ok(Math.abs(p.E[a]) <= 1, `pass ${p.pass}: E.${a} ${p.E[a]}`);
    assert.equal(p.sampleMeans.length, 12);
    assert.ok(p.reference && Number.isFinite(p.reference.lx));
    assert.equal(p.restoredExact, true, 'restored after every pass');
    assert.deepEqual(p.before, out.pass.target, 'every pass starts from the baseline');
  }

  assert.equal(out.fix.exact, true);
  assert.ok(Math.abs(out.fix.outNow.lx) <= 1 && Math.abs(out.fix.outLater.lx) <= 1, JSON.stringify([out.fix.outNow, out.fix.outLater]));
  assert.equal(out.fix.landed, PROBE_DEFAULTS.fixFlicks);
  assert.ok(Math.abs(out.fix.landingMedian[0]) <= 1);
  assert.deepEqual(out.fix.after.slice(0, 8), out.fix.from.slice(0, 8), 'range edges untouched');
  assert.deepEqual(out.fix.after.slice(10), out.fix.from.slice(10), 'right centers untouched');

  const r = probe.evaluate().r1x;
  assert.equal(r.x1, 'confirmed', r.reasons.join('; '));
  assert.equal(r.fixWorks, 'yes', r.reasons.join('; '));
  assert.equal(r.x2, 'no', r.reasons.join('; '));
  assert.equal(r.x3, 'no', r.reasons.join('; '));
  assert.equal(r.x4, 'no', r.reasons.join('; '));
  assert.match(r.label, /model-verified/);
  // Le valutazioni R1 restano quelle di prima.
  assert.equal(probe.evaluate().verdict.slope, 'pass');
  assert.equal(unlocks(dev), 0);
  assert.equal(dev.nvState, 'locked');
});

test('without a capture error X1 is not confirmed (model-verified)', async () => {
  const { out, probe } = await r1xSequence();
  assert.equal(out.pass.ok, true, out.pass.error);
  for (const p of out.pass.passes) assert.ok(Math.abs(p.E.lx) <= 1, `E.lx ${p.E.lx}`);
  const r = probe.evaluate().r1x;
  assert.equal(r.x1, 'not-confirmed');
  assert.equal(r.x3, 'no');
});

test('X3: a rest point that creeps while untouched is X3, not X1 (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  // Lo stick scivola su X di 15 LSB al minuto: ~4 LSB fra il primo e l'ultimo quinto dei 20 s.
  const t0 = s.clock.now();
  s.dev.touches.push({ stick: 0, t0, dur: 3_600_000, tail: 0, at: (t, ax) => (ax === 0 ? 15 * (t - t0) / 60000 : 0) });
  const idle = await s.run('X-idle');
  assert.ok(idle.driftLx > 2, `drift ${idle.driftLx}`);
  const r = s.probe.evaluate().r1x;
  assert.equal(r.x3, 'yes');
  assert.match(r.reasons.join('; '), /X3: left X drifted/);
});

test('X3: landing medians that depend on the release direction (model-verified)', async () => {
  const s = await r1xReady({
    // Dove si ferma dipende da dove arriva: +3 LSB dopo un rilascio verso destra, −3 verso sinistra.
    onPrompt: (dev, clock, p) => {
      flick(dev, clock, p);
      const vx = (RELEASE_DIRECTIONS.find(d => d.name === p.direction) ?? RELEASE_DIRECTIONS[0]).v[0];
      dev.sticks[0].rest[0] = 2.3 + 3 * Math.sign(Math.round(vx * 10));
    },
  });
  await s.run('X-idle');
  const rel = await s.run('X-release');
  assert.equal(rel.ok, true, rel.error);
  assert.ok(rel.maxOppositeLxDiff > 2, `diff ${rel.maxOppositeLxDiff}`);
  assert.equal(s.probe.evaluate().r1x.x3, 'yes');
});

test('X-release records null for a flick that never lands, without hanging (model-verified)', async () => {
  const s = await r1xReady({ onPrompt: null });
  const rel = await s.run('X-release', { flicksPer: 1 });
  assert.equal(rel.ok, true, rel.error);
  assert.equal(rel.flicks.length, 8);
  assert.ok(rel.flicks.every(f => f.landing === null && f.missed === 'no-landing'));
  assert.equal(rel.maxOppositeLxDiff, null);
  assert.equal(s.probe.evaluate().r1x.x3, 'incomplete');
});

test('X-pass and X-fix refuse without H-e on this connection, before any command (model-verified)', async () => {
  const s = setup({ params: XP });
  await s.run('preflight');
  s.armNow();
  for (const id of ['X-pass', 'X-fix']) {
    const r = await s.run(id);
    assert.equal(r.ok, false, id);
    assert.equal(r.refused, true, id);
    assert.match(r.error, /run H-e on this connection first/, id);
  }
  assert.equal(writes(s.dev) + calibCommands(s.dev), 0);
  assert.equal(s.confirmations.length, 0, 'refused before asking');

  // Una H-e su una connessione precedente non vale.
  await s.run('H-e');
  s.reconnect();
  await s.run('preflight');
  s.armNow();
  const w = writes(s.dev), c = calibCommands(s.dev);
  assert.match((await s.run('X-pass')).error, /run H-e on this connection first/);
  assert.match((await s.run('X-fix')).error, /run H-e on this connection first/);
  assert.equal(writes(s.dev), w);
  assert.equal(calibCommands(s.dev), c);
});

test('X-pass stops at the 15% ceiling after restoring the baseline (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 25 } });
  const base = s.dev.moduleValues();
  const xp = await s.run('X-pass');
  assert.equal(xp.ok, true, xp.error);
  assert.equal(xp.passes.length, 1);
  assert.equal(xp.stoppedAtCeiling, 1);
  assert.equal(xp.passes[0].ceiling, true);
  assert.ok(Math.hypot(xp.passes[0].outAfter.lx, xp.passes[0].outAfter.ly) >= CEILING_LSB);
  assert.equal(xp.passes[0].restoredExact, true);
  assert.deepEqual(s.dev.moduleValues(), base);
  assert.equal(s.dev.counts.begin, 1, 'no further pass');
  const r = s.probe.evaluate().r1x;
  assert.equal(r.x1, 'incomplete', 'X-idle not run');
  await s.run('X-idle');
  assert.equal(s.probe.evaluate().r1x.x1, 'inconclusive');
});

test('X-pass stops when the restore does not read back exactly (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  s.dev.module.writeApplies = false;
  const xp = await s.run('X-pass');
  assert.equal(xp.ok, false);
  assert.match(xp.error, /restore after X-pass 1 did not read back exactly/);
  assert.equal(xp.passes.length, 1);
  assert.equal(xp.passes[0].restoredExact, false);
  assert.equal(s.dev.counts.begin, 1);
});

test('X-fix applies a correction beyond ±512 units only under its own rule (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  // H-b lascia LX a circa −10 LSB: la correzione è ~640 unità, oltre MAX_CENTER_DELTA.
  await s.run('H-b');
  const fix = await s.run('X-fix');
  assert.equal(fix.ok, true, fix.error);
  assert.ok(Math.abs(fix.correction.lx) > MAX_CENTER_DELTA, `correction ${fix.correction.lx}`);
  assert.equal(fix.exact, true);
  assert.ok(Math.abs(fix.outNow.lx) <= 1, `now ${fix.outNow.lx}`);
  // H-c resta sotto ±512 da ogni lettura: uno spostamento come quello di X-fix
  // (lontano da tutto ciò che è stato letto) è rifiutato.
  const w = writes(s.dev);
  const big = [...fix.after]; big[8] -= 1000;
  const hc = await s.run('H-c', { target: big });
  assert.equal(hc.ok, false);
  assert.match(hc.error, /refused write: a center moves more than 512/);
  assert.equal(writes(s.dev), w);
});

test('X-fix refuses a correction larger than 24 LSB × |u| and writes nothing (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 30 } });
  await s.run('H-b');
  const w = writes(s.dev);
  const fix = await s.run('X-fix');
  assert.equal(fix.ok, false);
  assert.equal(fix.refused, true);
  assert.match(fix.error, /LX moves \d+ units, more than 24 LSB/);
  assert.equal(writes(s.dev), w);
});

test('the X-fix write rule refuses every condition it does not meet', () => {
  const snap = [10, 20, 30, 40, 50, 60, 70, 80, 32768, 32768, 32768, 32768];
  const fit = { unitsPerLsb: -64, r2: 0.99 };
  const he = { connection: 2, perAxis: { lx: fit, ly: fit, rx: fit, ry: fit } };
  const ok = { step: 'X-fix', values: [...snap], snapshot: snap, snapshots: [snap], he, connectionId: 2 };
  const withV = patch => { const v = [...snap]; for (const [i, d] of Object.entries(patch)) v[i] += d; return v; };
  const max = FIX_MAX_LSB * 64;
  assert.equal(checkFixWrite({ ...ok, values: withV({ 8: max, 9: -max }) }).ok, true);
  assert.equal(checkFixWrite({ ...ok, values: withV({ 8: 600 }) }).ok, true, 'beyond ±512 is allowed here');
  for (const [label, patch, pattern] of [
    ['another step', { step: 'H-c', values: withV({ 8: 600 }) }, /only X-fix/],
    ['restore with the large delta', { step: 'restore', values: withV({ 8: 600 }) }, /only X-fix/],
    ['no H-e', { he: null, values: withV({ 8: 64 }) }, /no H-e on this connection/],
    ['H-e on another connection', { connectionId: 3, values: withV({ 8: 64 }) }, /no H-e on this connection/],
    ['R² too low on LX', { he: { ...he, perAxis: { ...he.perAxis, lx: { unitsPerLsb: -64, r2: 0.8 } } }, values: withV({ 8: 64 }) }, /did not fit LX with R²/],
    ['R² too low on LY', { he: { ...he, perAxis: { ...he.perAxis, ly: { unitsPerLsb: -64, r2: 0.5 } } }, values: withV({ 9: 64 }) }, /did not fit LY with R²/],
    ['no fit on LX', { he: { ...he, perAxis: { ...he.perAxis, lx: { unitsPerLsb: null, r2: null } } }, values: withV({ 8: 64 }) }, /did not fit LX/],
    ['under 2 units per LSB', { he: { ...he, perAxis: { ...he.perAxis, lx: { unitsPerLsb: 1.5, r2: 0.99 } } }, values: withV({ 8: 3 }) }, /under 2 units per LSB on LX/],
    ['too large on LX', { values: withV({ 8: max + 1 }) }, /LX moves \d+ units, more than 24 LSB/],
    ['too large on LY', { values: withV({ 9: -(max + 1) }) }, /LY moves \d+ units, more than 24 LSB/],
    ['a range edge changes', { values: withV({ 8: 64, 0: 1 }) }, /range fields/],
    ['RX changes', { values: withV({ 10: 1 }) }, /right-stick centers/],
    ['RY changes', { values: withV({ 11: -1 }) }, /right-stick centers/],
    ['snapshot not read on this connection', { snapshots: [withV({ 8: 1 })] }, /read on this connection/],
    ['malformed values', { values: snap.slice(1) }, /12 integers/],
  ]) {
    const r = checkFixWrite({ ...ok, ...patch });
    assert.equal(r.ok, false, label);
    assert.match(r.reason, pattern, label);
  }
  // La regola generale non cambia: ±512 per ogni altro passo.
  assert.equal(checkWriteValues(withV({ 8: 600 }), [snap]).ok, false);
});

test('X-replug compares RAM across a replug of the same controller and refuses an unproven identity (model-verified)', async () => {
  const { out, probe, dev, reconnect, run, clock } = await r1xSequence({ module: { leftXCapture: 10 } });
  assert.equal(out.fix.ok, true, out.fix.error);
  // Stesso controller, cavo staccato e riattaccato senza spegnere.
  reconnect(dev, 'serial-A');
  assert.equal((await run('preflight')).ok, true);
  const rp = await run('X-replug');
  assert.equal(rp.ok, true, rp.error);
  assert.equal(rp.identicalToPrevious, true);
  assert.equal(rp.previousDiffersFromBaseline, true);
  assert.equal(probe.evaluate().r1x.replugKeepsRam, 'kept');

  // Un altro controller.
  const other = makeDev(clock, { seed: 99 });
  reconnect(other, 'serial-B');
  await run('preflight');
  assert.match((await run('X-replug')).error, /different controller/);

  // Seriale mancante: nessun verdetto.
  reconnect(other, null);
  await run('preflight');
  const unknown = await run('X-replug');
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /serial unavailable, cannot confirm same controller/);
  assert.equal(unknown.sameController, null);
  // Il verdetto resta quello della prova valida.
  assert.equal(probe.evaluate().r1x.replugKeepsRam, 'kept');
});

test('X-replug needs a previous connection and an explicit "no power-off" confirmation', async () => {
  const s = setup({ params: XP, confirm: async step => step !== 'X-replug' });
  await s.run('preflight');
  assert.match((await s.run('X-replug')).error, /Connect and run the preflight first/);
  s.reconnect();
  await s.run('preflight');
  const r = await s.run('X-replug');
  assert.equal(r.ok, false);
  assert.match(r.error, /not confirmed/);
});

test('evaluate on a record without R1-X steps marks every R1-X item incomplete', () => {
  const r = evaluate({ connections: [], steps: [] }).r1x;
  assert.deepEqual([r.x1, r.fixWorks, r.x2, r.x3, r.x4, r.replugKeepsRam], ['incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete', 'incomplete']);
});

/* ---------------------- R1-X: correzioni della review ----------------------- */

const commandsSent = dev => dev.moduleCounts.read + dev.moduleCounts.write + calibCommands(dev);

async function assertFixRefusedAfterStop(s) {
  assert.equal(s.probe.needsPowerCycle, true, 'the connection is marked for a power-cycle');
  const before = commandsSent(s.dev);
  const prompts = s.prompts.length;
  for (const step of ['X-fix', 'H-e', 'X-pass']) {
    const r = await s.run(step);
    assert.equal(r.ok, false, step);
    assert.match(r.error, /power-cycle/, step);
  }
  assert.equal(commandsSent(s.dev), before, 'no [12,x] or 0x82 command after the stop');
  assert.equal(s.prompts.length, prompts);
}

test('an X-pass stopped at the 15% ceiling blocks every later write until a reconnect (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 25 } });
  const xp = await s.run('X-pass');
  assert.equal(xp.stoppedAtCeiling, 1);
  assert.equal(xp.needsPowerCycle, true);
  await assertFixRefusedAfterStop(s);
});

test('an X-pass stopped by an inexact restore blocks every later write (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  s.dev.module.writeApplies = false;
  const xp = await s.run('X-pass');
  assert.match(xp.error, /restore after X-pass 1/);
  await assertFixRefusedAfterStop(s);
});

test('an X-pass with no output after the pass (no restore) blocks every later write (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  // I report smettono appena parte calibEnd: la passata è committata, la misura dopo no.
  s.dev.faults.push(({ op }) => { if (op === 'end') s.dev.stopped = true; return null; });
  const w = writes(s.dev);
  const xp = await s.run('X-pass');
  assert.equal(xp.ok, false);
  assert.match(xp.error, /no input reports after X-pass 1/);
  assert.equal(writes(s.dev), w + 1, 'only the initial restore, no restore after the pass');
  await assertFixRefusedAfterStop(s);
});

test('X-pass restores the baseline before pass 1, so a previous H-b does not shift the start (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  await s.run('H-b');
  assert.notDeepEqual(s.dev.moduleValues(), s.probe.record.baseline.values);
  const xp = await s.run('X-pass', { passes: 2 });
  assert.equal(xp.ok, true, xp.error);
  assert.equal(xp.initialRestore, true);
  for (const p of xp.passes) assert.deepEqual(p.before, s.probe.record.baseline.values, `pass ${p.pass}`);
  assert.ok(Math.abs(xp.passes[0].E.lx - 10) <= 1, `E.lx ${xp.passes[0].E.lx}`);
});

test('X-release drops a flick in the wrong direction: it neither enters the median nor triggers X3 (model-verified)', async () => {
  const s = await r1xReady({
    onPrompt: (dev, clock, p) => {
      if (p.direction === 'right' && p.index === 0) {
        // Rilascio verso SINISTRA quando è chiesto destra, e un arrivo spostato di 6 LSB.
        flick(dev, clock, { direction: 'left' });
        dev.sticks[0].rest[0] = 2.3 + 6;
      } else {
        dev.sticks[0].rest[0] = 2.3;
        flick(dev, clock, p);
      }
    },
  });
  await s.run('X-idle');
  const rel = await s.run('X-release');
  assert.equal(rel.ok, true, rel.error);
  assert.equal(rel.wrongDirection, 1);
  const row = rel.flicks.find(f => f.direction === 'right' && f.index === 0);
  assert.equal(row.landing, null);
  assert.equal(row.missed, 'wrong-direction');
  assert.ok(row.peakAt[0] < 0, 'the recorded peak is on the left');
  assert.equal(rel.byDirection.find(d => d.direction === 'right').landed, XP.releaseFlicks - 1);
  assert.ok(rel.maxOppositeLxDiff <= 2, `diff ${rel.maxOppositeLxDiff}`);
  assert.equal(s.probe.evaluate().r1x.x3, 'no');
});

test('X-fix writes nothing when the output does not repeat after a release (a still thumb) (model-verified)', async () => {
  const thumb = { stick: 0, t0: 0, dur: 1e9, tail: 0, amp: [6, 0] };
  const s = await r1xReady({
    onPrompt: (dev, clock, p) => {
      // Il pollice fermo se ne va con il rilascio.
      dev.touches = dev.touches.filter(t => t !== thumb);
      flick(dev, clock, p);
    },
  });
  thumb.t0 = s.clock.now();
  s.dev.touches.push(thumb);
  const w = writes(s.dev);
  const fix = await s.run('X-fix');
  assert.equal(fix.ok, false);
  assert.match(fix.error, /output not reproducible after a release: a thumb may be on the stick/);
  assert.ok(Math.abs(fix.repeat.lx + 6) <= 1, `repeat ${fix.repeat.lx}`);
  assert.equal(writes(s.dev), w);
});

test('X-idle with a 2-minute report pause is incomplete and counts as missing for X1 and X3 (model-verified)', async () => {
  const s = await r1xReady({ module: { leftXCapture: 10 } });
  const t0 = s.clock.now();
  s.clock.setTimeout(() => { s.dev.stopped = true; }, 60000);
  s.clock.setTimeout(() => { s.dev.stopped = false; s.dev.schedule(); }, 180000);
  const idle = await s.run('X-idle', { ms: 300000 });
  assert.equal(idle.ok, true, idle.error);
  assert.equal(idle.incomplete, true);
  assert.ok(idle.gaps >= 1);
  assert.ok(idle.coverage < 0.95, `coverage ${idle.coverage}`);
  assert.match(idle.incompleteReason, /continuous reports cover/);
  assert.ok(s.clock.now() - t0 >= 300000);
  await s.run('X-pass', { passes: 3 });
  const r = s.probe.evaluate().r1x;
  assert.equal(r.x1, 'incomplete');
  assert.match(r.reasons.join('; '), /X-idle incomplete/);
});

test('X-idle with continuous reports is complete and counts only reports inside its duration', async () => {
  const s = await r1xReady();
  const idle = await s.run('X-idle');
  assert.equal(idle.incomplete, false);
  assert.equal(idle.gaps, 0);
  assert.ok(idle.coverage >= 0.95);
  assert.ok(idle.perSecond.every(r => r.s < XP.idleMs / 1000 + 1));
});

test('X-replug skips an intermediate connection with no read and compares with the X-fix connection (model-verified)', async () => {
  const { out, probe, dev, reconnect, run } = await r1xSequence({ module: { leftXCapture: 10 } });
  assert.equal(out.fix.ok, true, out.fix.error);
  reconnect(dev, 'serial-A'); // connessione 2: nessuna lettura
  reconnect(dev, 'serial-A'); // connessione 3
  assert.equal((await run('preflight')).ok, true);
  const rp = await run('X-replug');
  assert.equal(rp.ok, true, rp.error);
  assert.equal(rp.previousConnection, 1);
  assert.equal(rp.identicalToPrevious, true);
  assert.equal(probe.evaluate().r1x.replugKeepsRam, 'kept');
});

test('X1 judges the sign on strong passes only: a large but not strong opposite pass does not cancel it', () => {
  const zero = { lx: 0, ly: 0, rx: 0, ry: 0 };
  const passRow = (pass, e, outLx) => ({ pass, E: { lx: e, ly: 0, rx: 0, ry: 0 }, outAfter: { ...zero, lx: outLx }, sampleVsRef: zero, inSessionVsPre: zero });
  const recordOf = passes => ({
    connections: [], steps: [
      { id: 'X-idle', ok: true, connection: 1, driftLx: 0.2, incomplete: false },
      { id: 'X-pass', ok: true, connection: 1, passes, stoppedAtCeiling: null },
    ],
  });
  const strong4 = [1, 2, 3, 4].map(i => passRow(i, 10, -10));
  const r = evaluate(recordOf([...strong4, passRow(5, -5, 0)])).r1x;
  assert.equal(r.x1, 'confirmed', r.reasons.join('; '));
  assert.match(r.reasons.join('; '), /pass 5 has \|E\| ≥ 4 LSB on LX with the opposite sign but is not strong/);
  // Una passata strong di segno opposto invece sì.
  const mixed = evaluate(recordOf([...strong4.slice(0, 3), passRow(4, -6, 6)])).r1x;
  assert.equal(mixed.x1, 'not-confirmed');
});

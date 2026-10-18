// Firma "cattura X sinistra" (hasLeftXSignature in js/calib/quick-policy.js):
// il limite a una passata sulle corse successive dello stesso controller
// (app.js, chiave salata, solo in memoria). L'arresto dentro la corsa
// (`leftXSignatureStop`) è spento di default e resta solo per il simulatore. Tutto model-verified (DualSense virtuale con `leftXCapture`),
// nessuna verifica hardware.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEFT_X_SIGNATURE_X_LSB, LEFT_X_SIGNATURE_Y_LSB, POLICY_DEFAULTS, classifyOutcome, decideAfterPass, hasLeftXSignature,
} from '../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../js/calib/quick.js';
import { LSB_PCT, WITHIN_ONE_STEP_MAX } from '../js/calib/lattice.js';
import { LEFT_X_CAPPED_NOTE, LEFT_X_FOUND_NOTE } from '../js/ui/outcome.js';
import { VClock } from '../ops/sim/vclock.mjs';
import { FakeDualSense } from '../ops/sim/fake-dualsense.mjs';
import { makeSimInstance } from '../ops/sim/harness.mjs';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';

// Assi come li dà summarizeResult: punti percentuali con segno, 3 decimali.
const pct = lsb => +(lsb * LSB_PCT).toFixed(3);
const xy = (lx, ly, rx = 0.5, ry = 0.5) => [[pct(lx), pct(ly)], [pct(rx), pct(ry)]];

// ---------------------------------------------------------------- firma

test('the signature: left X at −4 LSB or beyond, left Y exact, right stick within one step', () => {
  assert.equal(LEFT_X_SIGNATURE_X_LSB, -4);
  assert.equal(LEFT_X_SIGNATURE_Y_LSB, 1);
  assert.equal(hasLeftXSignature(xy(-4.5, 0.5)), true, 'byte 123: the first value past −4 LSB');
  assert.equal(hasLeftXSignature(xy(-4, -0.5)), true, 'a half-byte median at −4.0 LSB, rounded to 3 decimals');
  assert.equal(hasLeftXSignature(xy(-20.5, -0.5)), true, 'far left, still the signature');
  assert.equal(hasLeftXSignature(xy(-3.5, 0.5)), false, 'byte 124 is not enough');
  assert.equal(hasLeftXSignature(xy(4.5, 0.5)), false, 'toward +X is not the signature');
  assert.equal(hasLeftXSignature(xy(-6.5, 1)), true, 'Y within 1 LSB');
  assert.equal(hasLeftXSignature(xy(-6.5, 1.5)), false, 'Y one step off');
  assert.equal(hasLeftXSignature(xy(-6.5, 0.5, 1.5, 0.5)), true, 'right stick one step off (1.24%)');
  assert.ok(Math.hypot(pct(1.5), pct(0.5)) <= WITHIN_ONE_STEP_MAX);
  assert.equal(hasLeftXSignature(xy(-6.5, 0.5, 2.5, 0.5)), false, 'right stick two steps off');
  for (const bad of [null, undefined, [], [[1, 2]], [[NaN, 0], [0, 0]], [[-5, 0], [0]], 'x'])
    assert.equal(hasLeftXSignature(bad), false, JSON.stringify(bad));
});

// ---------------------------------------------------------------- regola

const state = (worst, axes, more = {}) => ({ pass: 1, worst, beforeWorst: 2.5, prevWorst: null, bestWorst: null, bestPass: null,
  otherWorst: 0.555, extraUsed: 0, xy: axes, ...more });

const STOP = { ...QUICK_DEFAULTS, leftXSignatureStop: true };

test('the in-run stop is off by default; switched on (simulator only) it stops with its own reason', () => {
  assert.equal(POLICY_DEFAULTS.leftXSignatureStop, false);
  assert.equal(QUICK_DEFAULTS.leftXSignatureStop, false);
  const off = decideAfterPass(state(5.1, xy(-6.5, 0.5)), QUICK_DEFAULTS);
  assert.deepEqual([off.stop, off.reason], [false, 'continue']);
  const d = decideAfterPass(state(5.1, xy(-6.5, 0.5)), STOP);
  assert.deepEqual([d.stop, d.reason], [true, 'left-x-signature']);
  assert.equal(d.bestWorst, 2.5, 'bestWorst still seeded with the start');
  // Senza assi (replay v1, chiamanti vecchi) o senza la firma: nulla cambia.
  assert.equal(decideAfterPass(state(5.1, undefined), STOP).reason, 'continue');
  assert.equal(decideAfterPass(state(5.1, xy(6.5, 0.5)), STOP).reason, 'continue');
});

test('the ceiling still comes first, and the outcome is still classifyOutcome’s', () => {
  const cat = decideAfterPass(state(16, xy(-20.5, 0.5)), STOP);
  assert.equal(cat.reason, 'catastrophic');
  // La firma non è un esito: una passata peggiore dell'inizio resta tale.
  assert.equal(classifyOutcome({ worst: 5.1, beforeWorst: 2.5, bestWorst: 2.5, maxNoise: 0.3, unstableEvents: 0, passes: [5.1] }, QUICK_DEFAULTS), 'worse-than-start');
});

// ---------------------------------------------------------------- runQuick

async function simQuick({ capture, params = {} }) {
  const clock = new VClock();
  const dev = new FakeDualSense({
    clock, seed: 5,
    sticks: [[3.2, -0.3], [-0.1, 0.4]].map(d => ({ drift: d, noise: 0.05, bias: { axis: 0, B: 0 } })),
    fw: { sf: 0, cmdMs: [2, 6] },
    timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    hand: { schedule: [] },
    module: { leftXCapture: capture },
  });
  const inst = makeSimInstance(clock, dev, { board: 'BDM-040', fw: 0 }, params, {});
  const res = await clock.run(inst.run());
  return { res, dev };
}

test('runQuick keeps its usual rules by default; the simulator switch stops on the signature (model-verified)', async () => {
  const def = await simQuick({ capture: 6 });
  assert.ok(def.dev.counts.end >= 2, `${def.dev.counts.end} passes by default`);
  assert.equal(def.res.session.stop, undefined);
  assert.equal(def.dev.counts.sample, 12 * def.dev.counts.end);
  const on = await simQuick({ capture: 6, params: { leftXSignatureStop: true } });
  assert.equal(on.dev.counts.end, 1);
  assert.equal(on.dev.counts.sample, 12);
  assert.equal(on.res.session.stop, 'left-x-signature');
  assert.equal(on.res.session.leftXSignature, true);
  assert.equal(on.res.session.passes.length, 1);
  assert.equal(on.res.session.board, 'BDM-040', 'the board stays in the local session');
  assert.equal(on.res.outcome, 'worse-than-start', 'the outcome is the usual classification');
  // Errore verso +X: nessuna firma, il ciclo di sempre.
  const plus = await simQuick({ capture: -6, params: { leftXSignatureStop: true } });
  assert.ok(plus.dev.counts.end >= 2);
  assert.equal(plus.res.session.stop, undefined);
});

// ---------------------------------------------------------------- pagina

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
const DRIFTING = [[3.2, -0.3], [-0.1, 0.4]];
// Scritture di #quick-msg (role="status"): ogni assegnazione di innerHTML.
function spyWrites(el) {
  const writes = [];
  let value = el.innerHTML;
  Object.defineProperty(el, 'innerHTML', {
    get: () => value,
    set: v => { writes.push(v); value = v; },
    configurable: true,
  });
  return writes;
}
// I comandi di calibrazione mandati da una corsa: solo begin/sample/end.
const calibOps = (dev, from) => dev.commandLog.slice(from).map(c => c.op).filter(op => !['nvs', 'other'].includes(op));
async function quick(h, dev) {
  const from = dev.commandLog.length;
  const ends = dev.counts.end;
  await h.click('btn-quick');
  const go = h.click('btn-quick-go');
  await h.advance(60_000);
  await h.run(go);
  return { ends: dev.counts.end - ends, ops: calibOps(dev, from) };
}
const occurrences = (list, text) => list.filter(v => String(v).includes(text)).length;

test('the page: the signature run ends by its usual rules, then one pass on the same controller, said once; another controller is not capped', async () => {
  const clock = new VClock();
  const A = withSerial(makeDevice(clock, { drift: DRIFTING, module: { leftXCapture: 6 } }), 'E8475C3A1B2F');
  const tabSession = new Map();
  const h = await loadApp({ clock, authorized: [A], chooser: [A], session: tabSession });
  await h.advance(5000);
  const msgWrites = spyWrites(h.$('quick-msg'));

  // 1) Prima Quick: la passata 1 mostra la firma, la corsa continua con le
  // sue regole (nessun arresto sulla firma).
  const first = await quick(h, A);
  assert.ok(first.ends >= 2, `${first.ends} passes on the first run`);
  assert.ok(first.ops.every(op => ['begin', 'sample', 'end'].includes(op)), `only calibration commands: ${[...new Set(first.ops)]}`);
  assert.equal(first.ops.filter(op => op === 'sample').length, 12 * first.ends);
  let session = h.sessions().filter(s => s.kind === 'quick').at(-1);
  assert.equal(session.stop, undefined);
  assert.equal(session.leftXSignature, true);
  assert.equal(session.leftXCap, undefined, 'the first run was not capped');
  assert.equal(occurrences([h.$('calib-outcome').innerHTML], LEFT_X_FOUND_NOTE), 1, 'the panel says it once');
  assert.equal(occurrences(msgWrites, LEFT_X_CAPPED_NOTE), 0);

  // 2) Seconda Quick sullo stesso controller. L'errore ora va verso +X: senza
  // il limite la passata 1 non basterebbe e ne seguirebbe un'altra.
  A.module.leftXCapture = -6;
  await h.advance(5000);
  const before = msgWrites.length;
  const second = await quick(h, A);
  assert.equal(second.ends, 1, 'capped at one pass');
  assert.equal(second.ops.filter(op => op === 'sample').length, 12);
  session = h.sessions().filter(s => s.kind === 'quick').at(-1);
  assert.equal(session.leftXCap, true);
  assert.equal(session.passes.length, 1);
  const runWrites = msgWrites.slice(before);
  assert.equal(occurrences(runWrites, 'one pass only'), 1, 'the modal says it once');
  for (let i = 1; i < runWrites.length; i++) assert.notEqual(runWrites[i], runWrites[i - 1], 'no live-region rewrite with the same text');
  assert.equal(occurrences([h.$('calib-outcome').innerHTML], LEFT_X_FOUND_NOTE), 0, 'the panel does not repeat it');

  // 3) Un altro controller (seriale diverso, leggibile): nessun limite.
  h.confirmAnswer = true;
  await h.run(h.click('btn-disconnect'));
  const B = withSerial(makeDevice(clock, { seed: 41, drift: DRIFTING, module: { leftXCapture: -6 } }), 'F1111111AAAA');
  h.hid.chooser.splice(0, Infinity, B);
  await h.run(h.click('btn-connect'));
  await h.advance(5000);
  assert.equal(h.peek().ds5.device, B);
  const fromB = msgWrites.length;
  const other = await quick(h, B);
  assert.ok(other.ends >= 2, `${other.ends} passes on the other controller`);
  assert.equal(occurrences(msgWrites.slice(fromB), 'one pass only'), 0);
  assert.equal(h.sessions().filter(s => s.kind === 'quick').at(-1).leftXCap, undefined);
  // Mai salvato: né il seriale né una chiave nello storico locale o nella scheda.
  assert.doesNotMatch(JSON.stringify(h.sessions()), /E8475C3A1B2F|F1111111AAAA|[0-9a-f]{32}/);
  for (const v of tabSession.values()) assert.doesNotMatch(String(v), /E8475C3A1B2F|F1111111AAAA|[0-9a-f]{16}/);
});

const CORNERS = [
  { tx: -0.7, ty: -0.7 },
  { tx: 0.7, ty: -0.7 },
  { tx: -0.7, ty: 0.7 },
  { tx: 0.7, ty: 0.7 },
];

test('a verified Guided result with the signature caps the next Quick on that controller', async () => {
  const clock = new VClock();
  const A = makeDevice(clock, { seed: 21, drift: [[14, -9], [-2, 3]], module: { leftXCapture: 6 } });
  const h = await loadApp({ clock, authorized: [A] });
  await h.advance(5000);
  await h.click('btn-wizard');
  await h.run(h.click('btn-wizard-next'));
  for (const c of CORNERS) {
    const t0 = clock.now() + 20;
    for (const stick of [0, 1]) A.touches.push({ stick, t0, dur: 400, tail: 40, amp: [c.tx * 120, c.ty * 120] });
    await h.advance(650);
    await h.run(h.click('btn-wizard-next'));
  }
  assert.deepEqual([A.counts.begin, A.counts.end], [1, 1]);
  const ev = h.sessions().filter(s => s.kind === 'wizard').at(-1);
  assert.equal(ev.done, true);
  assert.equal(ev.leftXSignature, true);
  assert.equal(occurrences([h.$('calib-outcome').innerHTML], LEFT_X_FOUND_NOTE), 1);
  await h.click('btn-wizard-next'); // Done
  await h.advance(5000);
  A.module.leftXCapture = -6;
  const next = await quick(h, A);
  assert.equal(next.ends, 1);
  assert.equal(h.sessions().filter(s => s.kind === 'quick').at(-1).leftXCap, true);
});

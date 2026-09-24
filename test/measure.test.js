import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DRIFT_MILD_MAX,
  DRIFT_MOVE_SPREAD,
  DRIFT_OK_MAX,
  DRIFT_WINDOW,
  analyzeDrift,
  extractStableSamples,
  median,
  parseSticks,
  summarizeResult,
  verdictFor,
} from '../js/calib/measure.js';

const report = bytes => {
  const buf = new Uint8Array(63);
  buf.set(bytes);
  return new DataView(buf.buffer);
};
const still = (n, s = { lx: 0.01, ly: -0.02, rx: 0, ry: 0.003 }) => Array.from({ length: n }, () => ({ ...s }));

test('parseSticks decodes USB report 0x01 around the 127.5 center and ignores other reports', () => {
  assert.deepEqual(parseSticks(0x01, report([0, 255, 127, 128])), { lx: -1, ly: 1, rx: -0.5 / 127.5, ry: 0.5 / 127.5 });
  assert.equal(parseSticks(0x31, report([128, 128, 128, 128])), null, 'Bluetooth report is not parsed');
  assert.equal(parseSticks(0x01, new DataView(new ArrayBuffer(3))), null, 'too short');
});

// Il reticolo a 8 bit: 0.555% è il pavimento, un asse a 1 LSB vale 1.240%.
test('the 8-bit lattice floor reads 0.555% and one LSB off reads 1.240%', () => {
  const floor = analyzeDrift(still(50, parseSticks(0x01, report([128, 127, 127, 128])))).left.offset;
  const oneStep = analyzeDrift(still(50, parseSticks(0x01, report([129, 127, 127, 128])))).left.offset;
  assert.equal(+floor.toFixed(3), 0.555);
  assert.equal(+oneStep.toFixed(3), 1.240);
  assert.ok(floor < DRIFT_OK_MAX && oneStep > DRIFT_OK_MAX, 'DRIFT_OK_MAX means 0 LSB of error');
});

test('median handles odd and even lengths without mutating the input', () => {
  const values = [3, 1, 2];
  assert.equal(median(values), 2);
  assert.deepEqual(values, [3, 1, 2]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('extractStableSamples keeps still samples and drops any window with movement', () => {
  const samples = still(100);
  assert.deepEqual(extractStableSamples(samples).fraction, 1);
  assert.equal(extractStableSamples(still(DRIFT_WINDOW)).fraction, 0, 'no full window yet');

  const touched = still(100);
  touched[50] = { ...touched[50], lx: touched[50].lx + DRIFT_MOVE_SPREAD + 0.01 };
  const { stable, fraction } = extractStableSamples(touched);
  // Il campione mosso contamina tutte le finestre che lo contengono.
  assert.equal(stable.length, 100 - DRIFT_WINDOW - (DRIFT_WINDOW + 1));
  assert.ok(fraction < 1);

  // Un drift enorme ma fermo è stabile: conta l'escursione, non il valore.
  assert.equal(extractStableSamples(still(80, { lx: 0.9, ly: 0, rx: -0.9, ry: 0 })).fraction, 1);
});

test('analyzeDrift reports median offset, p95 noise and per-axis direction in percent', () => {
  const samples = still(40, { lx: 0.03, ly: 0.04, rx: 0, ry: -0.1 });
  samples[0] = { lx: 0.9, ly: 0.9, rx: 0.9, ry: 0.9 }; // un sobbalzo isolato non sposta la mediana
  const r = analyzeDrift(samples);
  assert.ok(Math.abs(r.left.offset - 5) < 1e-9);
  assert.ok(Math.abs(r.right.offset - 10) < 1e-9);
  assert.equal(r.left.noise, 0);
  assert.deepEqual([r.left.x, r.left.y, r.right.x, r.right.y], [0.03, 0.04, 0, -0.1]);
});

test('verdictFor draws the public thresholds at 1.2% and 3.5% through GRID_TABLE', () => {
  assert.deepEqual(verdictFor({ offset: 0.555 }), { cls: 'v-ok', label: 'Centered · 0.6% · at floor', tier: 'centered' });
  // 1.24 non è "centrato" (KPI v1 invariato) ma è entro un passo del reticolo.
  assert.deepEqual(verdictFor({ offset: 1.24 }), { cls: 'v-ok', label: 'Within 1 step · 1.2% · 1 step', tier: 'within-1-step' });
  assert.equal(verdictFor({ offset: DRIFT_OK_MAX }).tier, 'within-1-step');
  assert.equal(verdictFor({ offset: 2 }).cls, 'v-mild');
  assert.equal(verdictFor({ offset: 3.49 }).cls, 'v-mild');
  assert.deepEqual(verdictFor({ offset: DRIFT_MILD_MAX }), { cls: 'v-bad', label: 'Marked drift · 3.5%', tier: 'marked' });
  assert.equal(verdictFor({ offset: 15 }).tier, 'guided-only');
});

test('verdictFor shows no percentage for a pinned axis or a moving signal', () => {
  assert.deepEqual(verdictFor({ offset: 100.001, x: 1, y: 0.0039, noise: 0 }), { cls: 'v-bad', label: 'Pinned', tier: 'pinned' });
  assert.deepEqual(verdictFor({ offset: 2, x: 0.02, y: 0, noise: 4, unstable: true }), { cls: 'v-bad', label: 'Moving', tier: 'moving' });
});

test('summarizeResult rounds to three decimals and keeps per-axis xy in percent', () => {
  assert.equal(summarizeResult(null), null);
  const s = summarizeResult({
    left: { offset: 1.23456, noise: 0.78431, x: 0.0123456, y: -0.00001 },
    right: { offset: 0.5546, noise: 0, x: 0.0039, y: 0.0039 },
  });
  assert.deepEqual(s, { off: [1.235, 0.555], noise: [0.784, 0], xy: [[1.235, -0.001], [0.39, 0.39]] });
});

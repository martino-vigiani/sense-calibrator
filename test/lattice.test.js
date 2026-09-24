import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CENTERED_MAX,
  CENTER_SCORE_ANCHORS,
  FLOOR_PCT,
  GRID_TABLE,
  GUIDED_ONLY_MIN,
  LSB_PCT,
  MILD_MAX,
  ONE_STEP_PCT,
  TIER_OVERRIDES,
  WITHIN_ONE_STEP_MAX,
  axisShape,
  centerScoreFor,
  decodeOff,
  formatOffset,
  isPinned,
  isWithinOneStep,
  stepsFromAxis,
  tierFor,
  tierForOffset,
} from '../js/calib/lattice.js';
import { DRIFT_MILD_MAX, DRIFT_OK_MAX, analyzeDrift, parseSticks } from '../js/calib/measure.js';
import { QUICK_DEFAULTS } from '../js/calib/quick.js';
import { QUICK_CENTER_RADIUS } from '../js/quick-center-guard.js';

const report = bytes => {
  const buf = new Uint8Array(63);
  buf.set(bytes);
  return new DataView(buf.buffer);
};
// Offset radiale del solo stick sinistro per una coppia di byte, passando per
// la stessa pipeline della pagina (parseSticks → analyzeDrift).
const offsetOf = (bx, by) => {
  const s = parseSticks(0x01, report([bx, by, 128, 127]));
  return analyzeDrift(Array.from({ length: 40 }, () => s)).left.offset;
};
const round3 = v => +v.toFixed(3);

test('lattice constants: 1 LSB = 0.784%, floor 0.555%, first step 1.240%', () => {
  assert.equal(round3(LSB_PCT), 0.784);
  assert.equal(round3(FLOOR_PCT), 0.555);
  assert.equal(round3(ONE_STEP_PCT), 1.240);
  assert.equal(round3(offsetOf(127, 128)), round3(FLOOR_PCT));
  assert.equal(round3(offsetOf(129, 127)), round3(ONE_STEP_PCT));
  // Il tetto "entro 1 passo" sta tra 1.240 e il gradino successivo (1+1 = 1.664).
  assert.ok(ONE_STEP_PCT < WITHIN_ONE_STEP_MAX && WITHIN_ONE_STEP_MAX < offsetOf(129, 126));
});

test('the table boundaries are the verdict, stop-rule and preflight numbers', () => {
  assert.equal(DRIFT_OK_MAX, CENTERED_MAX);
  assert.equal(DRIFT_MILD_MAX, MILD_MAX);
  assert.equal(QUICK_DEFAULTS.okMax, GRID_TABLE[0].max, 'the Quick stop target is the centered tier');
  assert.equal(GUIDED_ONLY_MIN, QUICK_CENTER_RADIUS * 100);
});

test('GRID_TABLE is ordered, contiguous, frozen and covers every offset', () => {
  assert.ok(Object.isFrozen(GRID_TABLE));
  const ids = GRID_TABLE.map(row => row.id);
  assert.deepEqual(ids, ['centered', 'within-1-step', 'mild', 'marked', 'guided-only']);
  for (let i = 1; i < GRID_TABLE.length; i++) assert.ok(GRID_TABLE[i].max > GRID_TABLE[i - 1].max);
  assert.equal(GRID_TABLE.at(-1).max, Infinity);
  for (const row of GRID_TABLE) {
    assert.ok(Object.isFrozen(row));
    for (const key of ['label', 'badge', 'cls', 'outcome']) assert.equal(typeof row[key], 'string', `${row.id}.${key}`);
  }
  assert.equal(GRID_TABLE[0].label, 'Centered (measurement limit)');
  assert.equal(GRID_TABLE[1].label, 'Within 1 step (fine to save)');
  assert.deepEqual(GRID_TABLE.map(row => row.centerScore), [100, 90, null, null, 0]);
  assert.deepEqual(Object.keys(TIER_OVERRIDES), ['moving', 'pinned']);
  for (const row of Object.values(TIER_OVERRIDES)) assert.equal(row.showsOffset, false);
});

test('tierForOffset puts every boundary on the documented side', () => {
  const cases = [
    [0, 'centered'], [0.555, 'centered'], [1.199, 'centered'],
    [1.2, 'within-1-step'], [1.24, 'within-1-step'], [1.25, 'within-1-step'],
    [1.251, 'mild'], [1.664, 'mild'], [3.499, 'mild'],
    [3.5, 'marked'], [3.551, 'marked'], [14.99, 'marked'],
    [15, 'guided-only'], [100.001, 'guided-only'],
  ];
  for (const [off, id] of cases) assert.equal(tierForOffset(off).id, id, String(off));
  for (const bad of [-1, NaN, Infinity, null, undefined, '1']) assert.equal(tierForOffset(bad), null);
  assert.equal(isWithinOneStep(1.24), true);
  assert.equal(isWithinOneStep(1.664), false);
});

test('tierFor: Moving beats Pinned beats the offset', () => {
  assert.equal(tierFor({ offset: 100.001, x: -1, y: 0.0039, noise: 0 }).id, 'pinned');
  assert.equal(tierFor({ offset: 100.001, x: -1, y: 0.0039, noise: 0, unstable: true }).id, 'moving');
  // Un asse al bordo ma rumoroso non è "incollato": è una mano o un guasto diverso.
  assert.equal(tierFor({ offset: 99.5, x: 0.995, y: 0, noise: 2 }).id, 'guided-only');
  assert.equal(tierFor({ offset: 0.555, x: 0.0039, y: -0.0039, noise: 0 }).id, 'centered');
  assert.equal(tierFor({ offset: 1.24 }).id, 'within-1-step', 'without x/y there is no pinned check');
  assert.equal(tierFor(null), null);
  assert.equal(isPinned({ x: 0.99, y: 0, noise: 0.5 }), true);
  assert.equal(isPinned({ x: 0.98, y: 0, noise: 0 }), false);
});

test('stepsFromAxis counts whole bytes beyond the 127/128 floor', () => {
  const axis = b => parseSticks(0x01, report([b, 128, 128, 128])).lx;
  assert.deepEqual([127, 128, 126, 129, 0, 255].map(b => stepsFromAxis(axis(b))), [0, 0, 1, 1, 127, 127]);
  assert.equal(stepsFromAxis(0), 0, 'a half-byte median counts as the floor');
  assert.equal(stepsFromAxis(NaN), null);
});

test('decodeOff recovers the per-axis steps of every byte pair within 0.0005', () => {
  // Tutte le coppie di byte fino a 40 passi per asse, arrotondate come la telemetria.
  for (let a = 0; a <= 40; a++) {
    for (let b = 0; b <= a; b++) {
      const off = round3(offsetOf(128 + a, 127 - b));
      const d = decodeOff(off);
      assert.ok(d, `${a},${b} decodes`);
      assert.ok(d.error <= 0.0005, `${a},${b} error ${d.error}`);
      assert.ok(d.candidates.some(c => c.a === a && c.b === b), `${a},${b} is a candidate`);
      if (!d.ambiguous) assert.deepEqual([d.a, d.b], [a, b]);
    }
  }
});

test('decodeOff flags ambiguous radii and prefers the single-axis reading', () => {
  // 7²+1² = 5²+5² in mezzi LSB: 3 passi su un asse oppure 2+2.
  const d = decodeOff(2.773);
  assert.equal(d.ambiguous, true);
  assert.deepEqual([d.a, d.b], [3, 0]);
  assert.deepEqual(d.candidates, [{ a: 2, b: 2 }, { a: 3, b: 0 }]);
  assert.equal(axisShape(2.773), 'ambiguous');
  assert.equal(axisShape(0.555), 'single-axis');
  assert.equal(axisShape(1.24), 'single-axis');
  assert.equal(axisShape(1.664), 'two-axis');
  // Il record sintetico fw:1234 aveva valori fuori reticolo.
  assert.equal(decodeOff(2.1), null);
  assert.equal(decodeOff(0.4), null);
  assert.equal(axisShape(2.1), 'off-lattice');
  assert.equal(decodeOff(-1), null);
  assert.deepEqual([decodeOff(100.001).a, decodeOff(100.001).b], [127, 0], 'an axis pinned at byte 0 or 255');
});

test('formatOffset is the single offset formatter', () => {
  assert.equal(formatOffset(0.555), '0.6% · at floor');
  assert.equal(formatOffset(1.24), '1.2% · 1 step');
  assert.equal(formatOffset(2), '2.0% · 2 steps');
  assert.equal(formatOffset(1.664), '1.7% · 1+1 steps');
  assert.equal(formatOffset(2.773), '2.8% · 3 steps');
  assert.equal(formatOffset(2.1), '2.1%', 'off-lattice values show only the percentage');
  assert.equal(formatOffset(40.394), '40.4%', 'no step count past the Marked tier');
  assert.equal(formatOffset(NaN), '—');
});

test('centerScoreFor follows the lattice anchors: floor 100, one step 90, 3.5 → 60, 8 → 0', () => {
  assert.equal(CENTER_SCORE_ANCHORS.length, 4);
  assert.equal(centerScoreFor(0.555), 100);
  assert.equal(centerScoreFor(0.3), 100);
  assert.equal(centerScoreFor(1.24), 90);
  assert.equal(centerScoreFor(3.5), 60);
  assert.equal(centerScoreFor(8), 0);
  assert.equal(centerScoreFor(40), 0);
  assert.equal(centerScoreFor(-1), null);
  // Coerente con la tabella: i livelli con un punteggio fisso lo danno al loro valore tipico.
  assert.equal(centerScoreFor(FLOOR_PCT), GRID_TABLE[0].centerScore);
  assert.equal(centerScoreFor(ONE_STEP_PCT), GRID_TABLE[1].centerScore);
  let previous = Infinity;
  for (let off = 0; off <= 10; off += 0.05) {
    const score = centerScoreFor(off);
    assert.ok(score <= previous, `monotone at ${off}`);
    previous = score;
  }
});

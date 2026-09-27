import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RANGE_DEFAULTS, circularityRms, createRangeTracker, createStickRange, pushStick, rangeStatus, stickCoverage, stickStatus,
} from '../js/calib/range-coverage.js';

// Copertura del range (WS7) su traiettorie sintetiche. Le coordinate passano
// dallo stesso reticolo a 8 bit degli input report: byte 0..255, poi
// normalizzate come parseSticks.
const q = v => {
  const raw = Math.max(0, Math.min(255, Math.round(v * 127.5 + 127.5)));
  return (raw - 127.5) / 127.5;
};

// Rotazione fisica di raggio 1 letta con un range memorizzato `scale` volte
// troppo stretto (>1) o troppo largo (<1): ogni asse satura a ±1 da solo.
function* rotation({ rate = 250, secPerTurn = 2, turns = 1, dir = 1, scale = 1, phase = 0 }) {
  const n = Math.round(rate * secPerTurn * turns);
  for (let k = 0; k <= n; k++) {
    const a = phase + dir * 2 * Math.PI * k / (rate * secPerTurn);
    yield [q(scale * Math.cos(a)), q(scale * Math.sin(a))];
  }
}

function feed(s, points) {
  for (const [x, y] of points) pushStick(s, x, y);
  return s;
}

// La regola di prima, per confronto: bins alimentati a rAF e soglia sul massimo non limitato.
function oldCoverage(points) {
  const bins = new Array(36).fill(0);
  for (const [x, y] of points) {
    const r = Math.hypot(x, y);
    const i = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * 36) % 36;
    if (r > bins[i]) bins[i] = r;
  }
  const g = Math.max(...bins);
  if (g < 0.5) return 0;
  const thr = Math.max(0.6, g * 0.88);
  return bins.filter(v => v >= thr).length / 36;
}

test('a fast rotation gives full coverage whatever the sample rate', () => {
  for (const rate of [60, 125, 250]) {
    const s = feed(createStickRange(), rotation({ rate, secPerTurn: 0.3 }));
    assert.equal(stickCoverage(s), 1, `rate ${rate} Hz`);
  }
  // Il difetto di prima: a 60 Hz (rAF) una rotazione da 0.3 s riempiva metà dei settori.
  assert.ok(oldCoverage(rotation({ rate: 60, secPerTurn: 0.3 })) < 0.6);
});

test('sectors between two samples are filled only along short arcs, with the chord radius', () => {
  // due campioni sul bordo a 90°: il tragitto può aver tagliato l'angolo, niente riempimento
  const wide = createStickRange();
  pushStick(wide, 1, 0);
  pushStick(wide, 0, 1);
  assert.equal(wide.bins.filter(v => v > 0).length, 2);
  // a 20°: riempiti con il raggio della corda (cos 10°), mai con quello del bordo
  const near = createStickRange();
  pushStick(near, 1, 0);
  const a = 20 * Math.PI / 180;
  pushStick(near, Math.cos(a), Math.sin(a));
  const filled = near.bins.filter(v => v > 0 && v < 1);
  assert.ok(filled.length >= 1);
  for (const v of filled) assert.ok(Math.abs(v - Math.cos(a / 2)) < 1e-9);
  // un passaggio per il centro non riempie nulla
  const flick = createStickRange();
  pushStick(flick, 1, 0);
  pushStick(flick, -1, 0);
  assert.equal(flick.bins.filter(v => v > 0).length, 2);
});

test('a stored range 1.2–1.4× too narrow (or too wide) still reaches full coverage', () => {
  for (const scale of [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4]) {
    for (const rate of [60, 250]) {
      const s = feed(createStickRange(), rotation({ rate, scale }));
      assert.equal(stickCoverage(s), 1, `scale ${scale} at ${rate} Hz`);
    }
  }
  assert.ok(oldCoverage(rotation({ rate: 250, scale: 1.4 })) < 0.5, 'the old unbounded threshold failed here');
});

test('zero motion never completes, never allows Finish anyway, and has zero coverage', () => {
  const t = createRangeTracker();
  let seed = 1;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 / 127.5;
  for (let i = 0; i < 250 * 60; i++) t.push({ lx: q(0.01 + noise()), ly: q(noise()), rx: q(noise()), ry: q(-0.02 + noise()) });
  const st = rangeStatus(t, 60_000);
  assert.equal(st.coverage, 0);
  assert.equal(st.complete, false);
  assert.equal(st.degenerate, true);
  assert.equal(st.canFinish, false);
  assert.equal(st.finishAnyway, false);
  assert.equal(st.missingDirs.length, 8);
});

test('audit 10: cardinal jumps with turns and reversal do not count as full edge coverage', () => {
  const tracker = createRangeTracker();
  for (const dir of [1, 1, -1]) {
    for (let turn = 0; turn < 2; turn++) {
      for (let i = 0; i < 4; i++) {
        const angle = dir * (turn * 4 + i) * Math.PI / 2;
        const x = q(Math.cos(angle)), y = q(Math.sin(angle));
        tracker.push({ lx: x, ly: y, rx: x, ry: y });
      }
    }
  }
  const status = rangeStatus(tracker, 16000);
  assert.ok(status.coverage < 0.3, `only ${status.coverage} of the sectors were reached`);
  assert.equal(status.complete, false);
  assert.equal(status.finishAnyway, true);
  assert.match(status.missing.join(' '), /cover more of the edge/);
});

test('a stick held still on the rim accumulates no turns and no reversals', () => {
  const s = createStickRange();
  let seed = 7;
  const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 4 / 127.5;
  for (let i = 0; i < 250 * 30; i++) pushStick(s, q(0.7 + jitter()), q(-0.7 + jitter()));
  const st = stickStatus(s);
  assert.ok(st.turns < 0.1, `${st.turns} turns`);
  assert.equal(s.reversals, 0);
  assert.equal(st.complete, false);
});

test('Done needs every direction at 0.9 of the maximum, two turns and a change of direction', () => {
  // un giro solo, in un verso
  let s = feed(createStickRange(), rotation({ turns: 1 }));
  let st = stickStatus(s);
  assert.deepEqual([st.enoughTurns, st.reversed, st.missingDirs.length], [false, false, 0]);
  // due giri nello stesso verso: manca l'inversione
  s = feed(createStickRange(), rotation({ turns: 2.1 }));
  st = stickStatus(s);
  assert.deepEqual([st.enoughTurns, st.reversed, st.complete], [true, false, false]);
  // due giri, poi mezzo giro nell'altro verso
  feed(s, rotation({ turns: 0.6, dir: -1, phase: 2.1 * 2 * Math.PI }));
  st = stickStatus(s);
  assert.equal(st.reversed, true);
  assert.equal(st.complete, true);
  // un "più": tre lati a fondo, uno solo al 75% (la regola di prima, 0.7, lo accettava)
  const plus = createStickRange();
  feed(plus, [[1, 0], [0, 1], [0, -1], [-0.75, 0]]);
  st = stickStatus(plus);
  assert.deepEqual(st.missingDirs, ['left']);
  assert.equal(st.shortDirs.length, 0);
});

test('Finish anyway appears only after 15 s, names the missing directions, and never on a degenerate range', () => {
  const t = createRangeTracker();
  // entrambi gli stick un giro in un verso: incompleto ma non degenere
  const a = [...rotation({ turns: 1 })];
  for (const [x, y] of a) t.push({ lx: x, ly: y, rx: x, ry: y });
  let st = rangeStatus(t, RANGE_DEFAULTS.unlockMs - 1);
  assert.equal(st.complete, false);
  assert.equal(st.canFinish, false);
  st = rangeStatus(t, RANGE_DEFAULTS.unlockMs);
  assert.equal(st.finishAnyway, true);
  assert.equal(st.canFinish, true);
  assert.ok(st.missing.some(m => /L: .* more turn/.test(m)));
  assert.ok(st.missing.includes('R: turn the other way too'));

  // solo lo stick destro si è mosso: il sinistro renderebbe il range degenere
  const d = createRangeTracker();
  for (const [x, y] of rotation({ turns: 3 })) d.push({ lx: 0, ly: 0, rx: x, ry: y });
  st = rangeStatus(d, 60_000);
  assert.equal(st.degenerate, true);
  assert.equal(st.canFinish, false);
  assert.deepEqual(st.missingDirs.filter(m => m.startsWith('L')), ['L left', 'L right', 'L up', 'L down']);
});

test('circularity RMS is null until every sector is reached, near 0 on a circle, larger on a square gate', () => {
  const partial = feed(createStickRange(), rotation({ turns: 0.5 }));
  assert.equal(circularityRms(partial), null);
  const circle = feed(createStickRange(), rotation({ turns: 1 }));
  assert.ok(circularityRms(circle) < 1, `${circularityRms(circle)}`);
  // cancello quadrato: le diagonali arrivano a √2
  const square = createStickRange();
  for (const [x, y] of rotation({ turns: 1 })) {
    const m = Math.max(Math.abs(x), Math.abs(y));
    pushStick(square, x / m, y / m);
  }
  assert.ok(circularityRms(square) > 15);
  // un cancello leggermente irregolare (±10%) sta nella fascia "normale"
  const lumpy = createStickRange();
  for (const [x, y] of rotation({ turns: 1 })) {
    const k = 1 + 0.1 * Math.cos(4 * Math.atan2(y, x));
    pushStick(lumpy, x * k, y * k);
  }
  const c = circularityRms(lumpy);
  assert.ok(c > 5 && c < 10, `${c}`);
});

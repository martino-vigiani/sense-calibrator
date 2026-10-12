// js/calib/landing.js: rilasci rilevati dagli input report su sorgenti
// sintetiche (posizioni in unità normalizzate, un report ogni 4 ms come un
// DualSense via USB), e il riassunto per stick.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LANDING_DEFAULTS, createLandingDetector, summarizeLandings } from '../js/calib/landing.js';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';
import { QUICK_STABLE_MS, QUICK_STABLE_SPREAD } from '../js/calib/sampling.js';

const LSB = 1 / 127.5;
const REST = { lx: 0, ly: 0, rx: 0, ry: 0 };

// Generatore pseudo-casuale deterministico (rumore di qualche LSB).
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Alimenta il rilevatore da t0 a t1 con `at(t)` → sticks; ritorna i rilasci.
function feed(det, at, t0, t1, dt = 4) {
  const out = [];
  for (let t = t0; t < t1; t += dt) out.push(...det.push(at(t), t));
  return out;
}

// Un flick dello stick sinistro: riposo in `from`, spinta fino a `peak` lungo
// x, tenuta, ritorno a molla in ~30 ms verso `to`, poi riposo con rumore.
function flick({ from = [0, 0], to = [0, 0], peak = 0.9, at = 1000, holdMs = 200, noiseLsb = 1, seed = 1 } = {}) {
  const r = rng(seed);
  const noise = () => (r() - 0.5) * 2 * noiseLsb * LSB;
  return t => {
    let x, y;
    if (t < at) [x, y] = from;
    else if (t < at + 80) { const k = (t - at) / 80; x = from[0] + k * (peak - from[0]); y = from[1]; }
    else if (t < at + 80 + holdMs) { x = peak; y = from[1]; }
    else if (t < at + 110 + holdMs) { const k = (t - at - 80 - holdMs) / 30; x = peak + k * (to[0] - peak); y = from[1] + k * (to[1] - from[1]); }
    else [x, y] = to;
    return { ...REST, lx: x + noise(), ly: y + noise() };
  };
}

test('the defaults reuse the existing thresholds', () => {
  assert.equal(LANDING_DEFAULTS.moveSpread, DRIFT_MOVE_SPREAD);
  assert.equal(LANDING_DEFAULTS.stableSpread, QUICK_STABLE_SPREAD);
  assert.equal(LANDING_DEFAULTS.holdMs, QUICK_STABLE_MS);
  assert.equal(LANDING_DEFAULTS.maxLand, 0.15);
});

test('a flick and a spring return give one landing where the stick stops', () => {
  const det = createLandingDetector();
  const to = [5 * LSB, -3 * LSB];
  const landings = feed(det, flick({ to }), 0, 3000);
  assert.equal(landings.length, 1);
  const [l] = landings;
  assert.equal(l.stick, 'left');
  assert.ok(Math.abs(l.landAxes[0] - 5) <= 0.5 && Math.abs(l.landAxes[1] + 3) <= 0.5, JSON.stringify(l.landAxes));
  assert.ok(Math.abs(l.landPct - Math.hypot(5, 3) * 100 / 127.5) < 0.5);
  assert.ok(l.peak >= 89 && l.peak <= 92, `peak ${l.peak}`);
  // Ritorno finito a ~1310 ms: lo stick è fermo da lì, l'assestamento è breve.
  assert.ok(l.t >= 1290 && l.t <= 1330, `t ${l.t}`);
  assert.ok(l.settleMs >= 0 && l.settleMs < 40, `settleMs ${l.settleMs}`);
});

test('the two sticks are tracked independently', () => {
  const det = createLandingDetector();
  const left = flick({ to: [2 * LSB, 0] });
  const right = flick({ to: [-4 * LSB, 1 * LSB], at: 1500, seed: 9 });
  const landings = feed(det, t => {
    const l = left(t); const r = right(t);
    return { lx: l.lx, ly: l.ly, rx: r.lx, ry: r.ly };
  }, 0, 3500);
  assert.deepEqual(landings.map(l => l.stick), ['left', 'right']);
  assert.ok(landings[1].landAxes[0] < -3);
});

test('a touch below the peak threshold is not a release', () => {
  const det = createLandingDetector();
  assert.equal(feed(det, flick({ peak: 0.15 }), 0, 3000).length, 0);
  // Ma un picco appena sopra la soglia sì.
  assert.equal(feed(det, flick({ peak: 0.3, at: 4000 }), 3000, 6000).length, 1);
});

test('a thumb held still past 15% is a hold, not a landing; the release after it is', () => {
  const det = createLandingDetector();
  // Spinta al 60%, tenuta ferma 2 s, poi rilascio.
  const landings = feed(det, flick({ peak: 0.6, holdMs: 2000, to: [1 * LSB, 0] }), 0, 4500);
  assert.equal(landings.length, 1);
  assert.ok(landings[0].t > 3000, 'the landing is after the hold');
  assert.ok(landings[0].peak >= 59);
  // Una tenuta senza rilascio non produce nulla.
  const held = createLandingDetector();
  assert.equal(feed(held, flick({ peak: 0.6, holdMs: 10_000 }), 0, 8000).length, 0);
  assert.equal(held.phase('left'), 'held');
});

test('a stick that keeps moving never lands', () => {
  const det = createLandingDetector();
  const landings = feed(det, t => ({ ...REST, lx: 0.5 * Math.sin(t / 50), ly: 0.5 * Math.cos(t / 50) }), 0, 5000);
  assert.equal(landings.length, 0);
});

test('a report gap over a second forgets the movement in flight', () => {
  const det = createLandingDetector();
  const at = flick({ to: [3 * LSB, 0] });
  feed(det, at, 0, 1100); // a metà della spinta
  // 1,5 s senza report, poi lo stick è già fermo: nessun rilascio attribuibile.
  assert.equal(feed(det, at, 2600, 4000).length, 0);
});

test('a short gap restarts the still window, so the landing waits for 300 ms of continuous reports', () => {
  const det = createLandingDetector();
  const at = flick({ to: [0, 0] });
  const out = [];
  for (let t = 0; t < 3000; t += 4) {
    if (t > 1330 && t < 1480) continue; // buco di 150 ms subito dopo il ritorno
    out.push(...det.push(at(t), t));
  }
  assert.equal(out.length, 1);
  assert.ok(out[0].t >= 1480, `t ${out[0].t}`);
});

test('a noisy stick at rest (2 LSB) still lands; a vibration over 3.5% does not', () => {
  const det = createLandingDetector();
  assert.equal(feed(det, flick({ noiseLsb: 2 }), 0, 3000).length, 1);
  const shaky = createLandingDetector();
  assert.equal(feed(shaky, flick({ noiseLsb: 3 }), 0, 3000).length, 0);
});

test('time going backwards resets instead of producing a landing', () => {
  const det = createLandingDetector();
  feed(det, flick(), 0, 1200);
  assert.equal(feed(det, flick(), 500, 600).length, 0);
  assert.equal(det.phase('left'), 'unknown');
});

test('summarizeLandings: median, dispersion and mean drift per stick', () => {
  const mk = (stick, x, y) => ({ t: 0, stick, peak: 90, landAxes: [x, y], landPct: Math.hypot(x, y) / 1.275, settleMs: 10 });
  // Sinistro raccolto lontano dal centro (calibrazione persa), destro sparso
  // intorno al centro (stick che si ferma ogni volta altrove).
  const list = [
    mk('left', 6, 2), mk('left', 6.5, 2), mk('left', 5.5, 2), mk('left', 6, 2.5), mk('left', 6, 1.5),
    mk('right', 4, 0), mk('right', -4, 0), mk('right', 0, 4), mk('right', 0, -4), mk('right', 0, 0),
  ];
  const s = summarizeLandings(list);
  assert.equal(s.left.count, 5);
  assert.deepEqual(s.left.median, [6, 2]);
  assert.ok(s.left.spreadLsb[1] <= 0.5);
  assert.ok(Math.abs(s.left.medianPct - Math.hypot(6, 2) * 100 / 127.5) < 0.01);
  assert.ok(Math.abs(s.left.driftLsb - Math.hypot(6, 2)) < 0.2);
  assert.deepEqual(s.right.median, [0, 0]);
  assert.equal(s.right.spreadLsb[1], 4);
  assert.equal(s.right.spreadPct[1], 3.14);
  assert.equal(s.right.medianPct, 0);
  assert.equal(s.right.driftLsb, 3.2);
  assert.equal(s.right.settleMs, 10);
});

test('summarizeLandings: no landings gives count 0 and nulls', () => {
  const s = summarizeLandings([]);
  assert.deepEqual(Object.keys(s), ['left', 'right']);
  for (const stick of ['left', 'right']) {
    assert.equal(s[stick].count, 0);
    assert.equal(s[stick].median, null);
    assert.equal(s[stick].spreadLsb, null);
  }
});

test('a worn stick that lands in different places is told apart from a lost calibration by the summary', () => {
  // Stesso stick, due modelli: arrivo fisso a +6 LSB contro arrivo casuale
  // entro ±5 LSB. Il riassunto separa i due casi per dispersione e mediana.
  const run = landAt => {
    const det = createLandingDetector();
    const out = [];
    for (let i = 0; i < 20; i++) {
      const [x, y] = landAt(i);
      out.push(...feed(det, flick({ at: i * 2000 + 500, to: [x * LSB, y * LSB], seed: i + 1 }), i * 2000, i * 2000 + 2000));
    }
    return summarizeLandings(out).left;
  };
  const r = rng(3);
  const lost = run(() => [6, 0]);
  const worn = run(() => [(r() - 0.5) * 10, (r() - 0.5) * 10]);
  assert.equal(lost.count, 20);
  assert.equal(worn.count, 20);
  assert.ok(lost.medianPct > 4 && lost.spreadLsb[1] < 1.5, JSON.stringify(lost));
  assert.ok(worn.spreadLsb[1] > 3, JSON.stringify(worn));
});

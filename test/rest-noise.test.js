// Riassunto del rumore a riposo (js/calib/rest-noise.js, evento v2 `rest`):
// numeri su sequenze scritte a mano, scarto dei tocchi, buchi nei report,
// tetto per caricamento. Nessun campione esce dal collettore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REST_DEFAULTS, createRestNoiseCollector } from '../js/calib/rest-noise.js';

const L = v => v / 127.5; // LSB → unità normalizzate di parseSticks
const at = (lx, ly = 0, rx = 0, ry = 0) => ({ lx: L(lx), ly: L(ly), rx: L(rx), ry: L(ry) });

// Spinge `ms` di report ogni `period` ms; `fn(i)` dà gli stick del report i.
function feed(c, { from = 0, ms = 30_000, period = 4, fn, drift = false }) {
  const out = [];
  let i = 0;
  for (let t = from; t <= from + ms; t += period, i++) {
    const s = c.push(fn(i, t), t, { drift });
    if (s) out.push(s);
  }
  return out;
}

test('a quiet stick flickering one LSB on one axis: median, spread, excursions and report rate', () => {
  const c = createRestNoiseCollector();
  // sinistro: byte fermo a +0.5, un report su 10 a +1.5 (1 LSB), per 1 report
  const [s] = feed(c, { fn: i => at(i % 10 === 0 ? 1.5 : 0.5, -0.5, 3.5, 0.5) });
  assert.ok(s);
  const [left, right] = s.sticks;
  assert.equal(left.p50, 0);
  assert.equal(left.p95, 1, "10% of the reports are 1 LSB out");
  assert.equal(left.max, 1);
  assert.equal(left.ex[0], Math.ceil(s.reports / 10), 'every flicker is one excursion ≥1 LSB');
  assert.deepEqual(left.ex.slice(1), [0, 0]);
  assert.equal(left.sy, 0);
  assert.ok(left.sx > 0.25 && left.sx < 0.35, `${left.sx}`);
  assert.equal(left.off, Math.round(Math.hypot(0.5, 0.5) / 127.5 * 10000) / 100, 'offset of the median point in %');
  assert.deepEqual([right.p50, right.max, right.ex], [0, 0, [0, 0, 0]]);
  assert.equal(right.off, Math.round(Math.hypot(3.5, 0.5) / 127.5 * 10000) / 100);
  assert.deepEqual(s.intervalMs, [4, 4, 4]);
  assert.equal(s.gaps, 0);
  assert.equal(s.durMs, 30_000);
  assert.equal(s.reports, 7501);
  assert.equal(s.discarded, 0);
});

test('a longer excursion counts once per run, at each threshold it crosses', () => {
  const c = createRestNoiseCollector();
  // tre corse: 1 LSB per 5 report, 2.5 LSB per 5 report, 5 LSB per 3 report
  const bump = i => (i >= 100 && i < 105 ? 1 : i >= 200 && i < 205 ? 2.5 : i >= 300 && i < 303 ? 5 : 0);
  const [s] = feed(c, { fn: i => at(0.5 + bump(i), 0.5) });
  assert.deepEqual(s.sticks[0].ex, [3, 2, 1]);
  assert.equal(s.sticks[0].max, 5);
});

test('a hand on a stick drops the window, counts it, and the next clean window reports the count', () => {
  const c = createRestNoiseCollector();
  // un tocco di 12 LSB (oltre l'8%) a metà finestra
  const touched = feed(c, { fn: i => at(i > 3000 && i < 3050 ? 12.5 : 0.5, 0.5) });
  assert.deepEqual(touched, []);
  assert.equal(c.discarded, 1);
  // un salto grande (oltre il doppio della soglia) scarta subito
  feed(c, { from: 40_000, ms: 1000, fn: i => at(i === 100 ? 40 : 0.5, 0.5) });
  assert.equal(c.discarded, 2);
  const [s] = feed(c, { from: 50_000, fn: () => at(0.5, 0.5) });
  assert.equal(s.discarded, 2);
  assert.equal(c.discarded, 0, 'reset after being reported');
});

test('a report gap over one second restarts the window without calling it a touch', () => {
  const c = createRestNoiseCollector();
  assert.deepEqual(feed(c, { ms: 20_000, fn: () => at(0.5) }), []);
  const [s] = feed(c, { from: 21_500, fn: () => at(0.5) });
  assert.ok(s);
  assert.equal(s.durMs, 30_000, 'the window restarted after the gap');
  assert.equal(s.discarded, 0);
});

test('gaps between 100 ms and 1 s are counted, not reset, and show in the interval stats', () => {
  const c = createRestNoiseCollector();
  let t = 0;
  let s = null;
  for (let i = 0; !s; i++) {
    t += i % 1000 === 999 ? 250 : 4;
    s = c.push(at(0.5), t);
  }
  assert.ok(s.gaps >= 3);
  assert.equal(s.intervalMs[2], 250);
  assert.equal(s.intervalMs[0], 4);
});

test('reset drops the window in progress; drift marks the window it touched', () => {
  const c = createRestNoiseCollector();
  feed(c, { ms: 10_000, fn: () => at(0.5), drift: true });
  c.reset();
  assert.equal(c.samples, 0);
  const [idle] = feed(c, { from: 11_000, fn: () => at(0.5) });
  assert.equal(idle.drift, false);
  const [drift] = feed(c, { from: 50_000, fn: () => at(0.5), drift: true });
  assert.equal(drift.drift, true);
});

test('at most maxPerLoad summaries per page load, then it stops collecting', () => {
  const c = createRestNoiseCollector();
  const all = feed(c, { ms: 30_000 * (REST_DEFAULTS.maxPerLoad + 3), fn: () => at(0.5) });
  assert.equal(all.length, REST_DEFAULTS.maxPerLoad);
  assert.equal(c.done, true);
  assert.equal(c.push(at(0.5), 1e9), null);
});

test('the summary holds aggregates only: no samples, times or positions beyond the median offset', () => {
  const c = createRestNoiseCollector();
  const [s] = feed(c, { fn: i => at(0.5 + (i % 3 === 0 ? 1 : 0), -2.5) });
  assert.deepEqual(Object.keys(s).sort(), ['discarded', 'drift', 'durMs', 'gaps', 'intervalMs', 'reports', 'sticks']);
  for (const stick of s.sticks) {
    assert.deepEqual(Object.keys(stick).sort(), ['ex', 'max', 'off', 'p50', 'p95', 'sx', 'sy']);
  }
  assert.ok(JSON.stringify(s).length < 400);
});

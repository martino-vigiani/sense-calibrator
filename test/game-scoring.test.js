// Test di precisione v4 (WS8): punteggi, misura per report, regole di tocco,
// salto, interruzioni, confronto prima/dopo e le attese spiegate. La macchina
// a stati è quella vera di js/game.js; il controller e l'utente sono il modello
// di ops/sim/precision-user.mjs (model-verified, mai un DualSense vero).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GAME_PHASES, PRECISION_DEFAULTS, STORAGE_KEY, STABILITY_SCORE_ANCHORS, UNIDENTIFIED,
  analyzeCenter, centerScore, compareStick, comparisonHtml, controllerKey, createPrecisionTest,
  headlineSentence, loadPrevious, localSalt, rangeText, returnText, savePrevious, stabilityScoreFor, windowIsStill,
} from '../js/game.js';
import { FLOOR_PCT, LSB_PCT, ONE_STEP_PCT, MILD_MAX, centerScoreFor } from '../js/calib/lattice.js';
import { DRIFT_MOVE_SPREAD } from '../js/calib/measure.js';
import { QUICK_NOISE_WORN } from '../js/calib/quick.js';
import { simulateRun, durationSample, quantile } from '../ops/sim/precision-user.mjs';
import { discrimination, CENTER_ZERO_PCT } from '../ops/sim/precision-discrimination.mjs';
import { syntheticTemplates, latticeOff } from '../ops/sim/population.mjs';

const byte = b => (b - 127.5) / 127.5;
const sticksOf = (lx, ly, rx = 127, ry = 128) => ({ lx: byte(lx), ly: byte(ly), rx: byte(rx), ry: byte(ry) });

// Finestre di 30 report da una funzione (i) → sticks.
function windowsOf(n, f) {
  const out = [];
  for (let w = 0; w < n; w++) out.push(Array.from({ length: 30 }, (_, i) => f(w * 30 + i)));
  return out;
}

/* ---------------- punteggi ---------------- */

test('Center comes from the GRID_TABLE anchors: floor 100, one step 90, 3.5% 60, 8% 0', () => {
  assert.equal(centerScore, centerScoreFor);
  assert.equal(centerScore(FLOOR_PCT), 100);
  assert.equal(centerScore(0), 100);
  assert.equal(centerScore(ONE_STEP_PCT), 90);
  assert.equal(centerScore(MILD_MAX), 60);
  assert.equal(centerScore(8), 0);
  assert.equal(centerScore(40), 0);
});

test('bytes 127/128 score Center 100 and a one-step stick scores 90, measured from reports', () => {
  // 127/128 alternati (mediana a mezzo byte) e fermi su 127/128: entrambi al pavimento
  const flicker = analyzeCenter(windowsOf(25, i => sticksOf(i % 2 ? 127 : 128, i % 3 ? 128 : 127, 128, 127)));
  assert.equal(centerScore(flicker.drift.left.offset), 100);
  const fixed = analyzeCenter(windowsOf(25, () => sticksOf(127, 128, 128, 128)));
  assert.equal(centerScore(fixed.drift.left.offset), 100);
  assert.equal(centerScore(fixed.drift.right.offset), 100);
  // un asse a 126: 1.240%, un passo
  const step = analyzeCenter(windowsOf(25, () => sticksOf(126, 128)));
  assert.ok(Math.abs(step.drift.left.offset - ONE_STEP_PCT) < 1e-9);
  assert.equal(centerScore(step.drift.left.offset), 90);

  // e dalla macchina a stati completa, con rumore e un utente modello
  const perfect = simulateRun({ seed: 11, sticks: { L: { rest: [-0.5, -0.5], noise: 0.3 }, R: { rest: [0.5, -0.5], noise: 0.3 } } });
  assert.equal(perfect.phase, 'done');
  assert.equal(perfect.result.L.score.center, 100);
  assert.equal(perfect.result.R.score.center, 100);
  assert.equal(perfect.result.calibration, 100);
  const oneStep = simulateRun({ seed: 12, sticks: { L: { rest: [1.5, -0.5], noise: 0.3 } } });
  assert.equal(oneStep.result.L.score.center, 90);
  assert.equal(oneStep.result.calibration, 90);
});

test('Stability: 1 LSB of jitter costs 5 points, the worn-sensor threshold is 75', () => {
  assert.deepEqual(STABILITY_SCORE_ANCHORS.map(a => a[1]), [100, 95, 75, 0]);
  assert.equal(stabilityScoreFor(0), 100);
  assert.equal(stabilityScoreFor(LSB_PCT), 95);
  assert.equal(stabilityScoreFor(QUICK_NOISE_WORN), 75);
  assert.equal(stabilityScoreFor(4), 0);
  assert.equal(stabilityScoreFor(9), 0);
});

test('discrimination: Mild and Marked medians differ by ≥20 and a 1-LSB step moves ≥8 (synthetic population)', () => {
  // Offset "before" della popolazione sintetica (la telemetria vera non entra
  // nei test: ops/sim/precision-discrimination.mjs la legge a mano).
  const offsets = syntheticTemplates().flatMap(t => t.sticks.map(s => latticeOff(...s.lat)));
  const d = discrimination(offsets);
  assert.ok(d.mildMarkedGap >= 20, `gap ${d.mildMarkedGap}`);
  // Ogni passo di 1 LSB su un asse, con entrambi gli estremi sotto lo zero (8%):
  // il residuo reale sta su un asse (F5).
  for (let a = 0; ; a++) {
    const v = Math.hypot(a + 0.5, 0.5) * LSB_PCT;
    const next = Math.hypot(a + 1.5, 0.5) * LSB_PCT;
    if (next >= CENTER_ZERO_PCT) break;
    assert.ok(centerScore(v) - centerScore(next) >= 8, `${v.toFixed(3)} → ${next.toFixed(3)}`);
  }
});

/* ---------------- tocchi ---------------- */

test('a moving window is dropped, a touched run never scores, and a slow push is caught too', () => {
  const still = windowsOf(1, () => sticksOf(127, 128))[0];
  assert.equal(windowIsStill(still), true);
  const moved = still.map((s, i) => ({ ...s, lx: s.lx + (i === 10 ? DRIFT_MOVE_SPREAD + 0.01 : 0) }));
  assert.equal(windowIsStill(moved), false);

  // 50% delle finestre mosse: toccata, nessun drift
  const touched = analyzeCenter(windowsOf(24, i => sticksOf(127 + (Math.floor(i / 30) % 2 ? (i % 2) * 30 : 0), 128)));
  assert.equal(touched.touched, true);
  assert.equal(touched.drift, null);
  // spinta lenta: ogni finestra è ferma, ma il riposo si sposta di 12 LSB
  const creep = analyzeCenter(windowsOf(25, i => sticksOf(127 + Math.min(12, Math.floor(i / 60)), 128)));
  assert.ok(creep.creeping > 0);
  assert.equal(creep.touched, true);
  assert.equal(creep.drift, null);
});

test('a simulated touch never scores: brush, slow push and a thumb that never lets go', () => {
  const base = { user: { handsOnAtStart: 0 } };
  // sfregamento breve (<40% della corsa): le finestre toccate sono scartate e
  // il punteggio è quello dello stick fermo
  const brush = simulateRun({ ...base, seed: 21, scenario: { touch: { stick: 'L', from: 1000, dur: 300 } } });
  assert.ok(brush.result.center.kept < brush.result.center.total);
  assert.equal(brush.result.L.score.center, 100);
  // tocco lungo: la corsa riparte da sola, e il punteggio viene dalla corsa pulita
  const long = simulateRun({ ...base, seed: 22, scenario: { touch: { stick: 'L', from: 500, dur: 1500 } } });
  assert.equal(long.result.centerRetries, 1);
  assert.equal(long.result.L.score.center, 100);
  // spinta lenta (sotto la soglia di spread in ogni finestra)
  for (const amp of [0.05, 0.3]) {
    const creep = simulateRun({ ...base, seed: 23, scenario: { touch: { stick: 'L', from: 600, dur: 1600, amp, shape: 'creep' } } });
    assert.equal(creep.result.centerRetries, 1, `creep ${amp}`);
    assert.equal(creep.result.L.score.center, 100, `creep ${amp}`);
  }
  // pollice in movimento per sempre: dopo 2 riprese automatiche nessun punteggio
  const hold = simulateRun({ seed: 24, scenario: { hold: true } });
  assert.equal(hold.phase, 'center-failed');
  assert.equal(hold.result, null);
});

/* ---------------- Return e Range: informativi ---------------- */

test('a skipped Return reports "Not measured", never 0, and does not touch the headline', () => {
  const skipped = simulateRun({ seed: 31, scenario: { neverFlick: true, skipReturnAt: 3000 } });
  assert.equal(skipped.phase, 'done');
  assert.equal(skipped.result.returnSkipped, true);
  assert.equal(skipped.result.L.ret, null);
  assert.equal(skipped.result.R.ret, null);
  assert.equal(returnText(skipped.result.L.ret), 'Not measured');
  assert.equal(skipped.result.calibration, 100);
  // senza flick e senza Skip: il tetto di 30 s chiude la prova, stesso esito
  const idle = simulateRun({ seed: 32, scenario: { neverFlick: true } });
  assert.equal(idle.result.returnTimedOut, true);
  assert.equal(returnText(idle.result.R.ret), 'Not measured');
  assert.ok(idle.result.durationMs >= PRECISION_DEFAULTS.returnCapMs);
  // Range senza letture: "Not measured"; con bordo parziale lo dice.
  const e = createPrecisionTest();
  assert.equal(e.skip(0), false, 'nothing to skip before Return');
  assert.equal(rangeText(null), 'Not measured');
  assert.equal(rangeText({ coverage: 0.2, circ: 40, under: 1, over: 0 }), 'Partial result: 20% of the edge measured');
});

test('audit 16: partial edge coverage has only a partial Range result', () => {
  for (const coverage of [0.2, 0.5]) {
    const partial = rangeText({ coverage, circ: 0, under: 0, over: 0 });
    assert.match(partial, /Partial result/);
    assert.doesNotMatch(partial, /all around|Falls short|Hits its limit/);
  }
});

test('Return rejects a guided release and measures four prescribed flicks per stick', () => {
  const r = simulateRun({ seed: 33, user: { pGuided: 0.3 } });
  assert.equal(r.phase, 'done');
  assert.ok(r.result.attempts.guided > 0, 'some releases were guided');
  assert.equal(r.result.L.ret.n, 4);
  assert.equal(r.result.R.ret.n, 4);
  assert.match(returnText(r.result.L.ret), /of 4 flicks$/);
  assert.ok(r.result.L.range.coverage >= PRECISION_DEFAULTS.rangeCoverage);
  assert.equal(PRECISION_DEFAULTS.releaseMaxMs, 80);
  assert.deepEqual([...PRECISION_DEFAULTS.returnDirs], ['up', 'right', 'down', 'left']);
});

/* ---------------- campionamento per report ---------------- */

test('sampling is report-driven: frames alone never advance a check, a gap or a hidden tab interrupts', () => {
  const e = createPrecisionTest();
  e.start(0);
  // solo frame, nessun report: resta in attesa e dice perché
  for (let t = 0; t < 5000; t += 16) e.tick(t);
  assert.equal(e.phase, 'ready');
  assert.match(e.view(5000).why, /No input from the controller/);
  // report fermi a riposo: parte Center
  let t = 5000;
  for (; e.phase !== 'center'; t += 4) e.feed(sticksOf(127, 128), t);
  // buco di 150 ms durante Center: interrotto, al frame o al report dopo
  e.tick(t + 150);
  assert.equal(e.phase, 'interrupted');
  assert.equal(e.view(t + 150).retry, 'Retry');
  assert.match(e.view(t + 150).why, /stopped sending data/);
  assert.equal(e.retry(t + 200), true);
  assert.equal(e.phase, 'ready');
  for (t += 200; e.phase !== 'center'; t += 4) e.feed(sticksOf(127, 128), t);
  assert.equal(e.interrupt('hidden', t), true);
  assert.match(e.view(t).why, /background/);

  // e dal modello: buco nei report e tab nascosta, poi Retry e fine regolare
  const gap = simulateRun({ seed: 41, scenario: { gap: { at: 5000, dur: 400 } } });
  assert.equal(gap.result.interruptions, 1);
  assert.equal(gap.result.calibration, 100);
  const hidden = simulateRun({ seed: 42, scenario: { hidden: { at: 2000 } } });
  assert.equal(hidden.result.interruptions, 1);
  assert.equal(hidden.phase, 'done');
});

test('Retry after an interrupted Return redoes the direction once: no stick records a flick twice', () => {
  // Una leva chiude "up", l'altra no, poi un buco nei report: la riprova
  // rifà "up" per entrambe e il flick già chiuso non va contato due volte.
  const e = createPrecisionTest();
  const rest = sticksOf(127, 128, 127, 128);
  const DIR = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
  let t = 0;
  const feed = s => { e.feed(s, t); t += 4; };
  e.start(t);
  while (e.phase !== 'return') feed(rest);
  const flick = (dir, keys) => {
    const [x, y] = DIR[dir];
    const out = { ...rest };
    for (const k of keys) { out[`${k}x`] = x; out[`${k}y`] = y; }
    for (let i = 0; i < 5; i++) feed(out);   // fuori e rilascio di molla, < 80 ms
  };
  const settle = () => { for (let i = 0; i < 90; i++) feed(rest); };

  flick('up', ['l']);
  settle();
  assert.equal(e.phase, 'return', 'still waiting for the right stick on "up"');
  e.tick(t + 150);
  assert.equal(e.phase, 'interrupted');
  assert.equal(e.retry(t + 200), true);
  assert.equal(e.phase, 'return');
  t += 200;
  for (const dir of PRECISION_DEFAULTS.returnDirs) { flick(dir, ['l', 'r']); settle(); }
  assert.equal(e.phase, 'range');
  e.skip(t);
  const res = e.result();
  for (const k of ['L', 'R']) {
    assert.equal(res[k].ret.n, 4, `${k}: four flicks, not five`);
    assert.deepEqual(res[k].ret.dirs, ['up', 'right', 'down', 'left'], `${k}: one flick per direction`);
    assert.match(returnText(res[k].ret, res.flicksPerStick), / 4 of 4 flicks$/);
  }

  // e dal modello (lo scenario del revisore): buchi di 150 ms sparsi in Return
  for (let seed = 1; seed <= 12; seed++) {
    for (let at = 5000; at <= 14000; at += 250) {
      const r = simulateRun({ seed, scenario: { gap: { at, dur: 150 } } });
      if (r.phase !== 'done') continue;
      for (const k of ['L', 'R']) {
        const ret = r.result[k].ret;
        if (!ret) continue;
        assert.ok(ret.n <= 4, `seed ${seed}, gap at ${at}: ${k} has ${ret.n} flicks`);
        assert.equal(new Set(ret.dirs).size, ret.n, `seed ${seed}, gap at ${at}: ${k} repeats a direction`);
      }
    }
  }
});

test('game.js samples from HID reports and uses the shared hands-off meter; no timers', async () => {
  const src = await readFile(new URL('../js/game.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*createHandsOffMeter[^}]*\} from '\.\/ui\/hands-off\.js'/);
  assert.doesNotMatch(src, /setInterval|setTimeout/);
  // nessuna prova si accumula nel ciclo di disegno
  const step = src.slice(src.indexOf('  function step(ts) {'), src.indexOf('  /* ---------------- sequenza'));
  assert.doesNotMatch(step, /engine\.feed/);
  assert.match(app, /subscribe: fn => stickSource\.subscribe\(\(\) => fn\(sticks, performance\.now\(\)\)\)/);
});

test('a jittery sensor that never rests ends with an explanation, not an endless wait', () => {
  const r = simulateRun({ seed: 43, sticks: { L: { rest: [-0.5, -0.5], noise: 3 } } });
  assert.equal(r.phase, 'center-failed');
  assert.equal(r.deadWaits.length, 0);
  // una sensore rumoroso ma sotto la soglia di movimento si misura e perde in Stability
  const noisy = simulateRun({ seed: 44, sticks: { L: { rest: [-0.5, -0.5], noise: 1.2 } } });
  assert.equal(noisy.phase, 'done');
  assert.equal(noisy.result.L.score.center, 100);
  assert.ok(noisy.result.L.score.stability < 75);
  assert.ok(noisy.result.hardware < 75);
  assert.match(headlineSentence(noisy.result), /jitters .* calibration can't fix/);
});

/* ---------------- attese e durata ---------------- */

test('no wait over 2 s goes unexplained (instrumented), and the instrument catches a mute view', () => {
  const scenarios = [
    {}, { touch: { stick: 'L', from: 500, dur: 1500 } }, { hold: true }, { gap: { at: 6000, dur: 300 } },
    { hidden: { at: 1500 } }, { neverFlick: true }, { neverFlick: true, skipReturnAt: 5000 },
  ];
  let explained = 0;
  for (const [i, scenario] of scenarios.entries()) {
    const r = simulateRun({ seed: 50 + i, scenario });
    assert.deepEqual(r.deadWaits, [], JSON.stringify(scenario));
    explained += r.explainedWaits;
  }
  assert.ok(explained > 0, 'the long waits exist and carry a reason');
  const mute = simulateRun({ seed: 56, scenario: { neverFlick: true, muteWhy: true } });
  assert.ok(mute.deadWaits.length > 0, 'without reasons the instrument reports a dead wait');
});

test('the median simulated run is ≤60 s and the copy states it (model-verified)', async () => {
  const runs = durationSample(40);
  assert.ok(runs.every(r => r.phase === 'done'));
  assert.ok(runs.every(r => r.deadWaits.length === 0));
  const median = quantile(runs.map(r => r.durationMs), 0.5);
  assert.ok(median <= 60000, `median ${median} ms`);
  // La copy arrotonda la mediana ai 5 s: se il test cambia durata, la copy
  // va aggiornata con lui.
  const stated = Math.max(5, Math.round(median / 5000) * 5);
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const claims = [...html.matchAll(/about (\d+) seconds/g)].map(m => Number(m[1]));
  const gameCopy = [
    html.match(/<p id="game-instr"[^>]*>([^<]*)<\/p>/)[1],
    html.match(/<h4>Precision test<\/h4>\s*<p>([^<]*)<\/p>/)[1],
  ];
  for (const text of gameCopy) assert.match(text, new RegExp(`about ${stated} seconds`), text);
  assert.ok(claims.includes(stated));
});

/* ---------------- confronto prima/dopo ---------------- */

test('before/after: a change is real only when an axis moved by one full LSB', () => {
  const at = (bx, by) => ({ x: byte(bx), y: byte(by), offset: Math.hypot(byte(bx), byte(by)) * 100, noise: 0.784 });
  assert.equal(compareStick(at(126, 128), at(127, 128)).center, 'better');
  assert.equal(compareStick(at(127, 128), at(126, 128)).center, 'worse');
  // da 1 passo a sinistra a 1 passo a destra: stesso raggio, direzione diversa
  assert.equal(compareStick(at(126, 128), at(129, 128)).center, 'moved');
  // sfarfallio 127/128 (mediana a mezzo byte) contro 127 fermo: rumore
  const half = { x: 0, y: byte(128), offset: 0.39, noise: 0.784 };
  assert.equal(compareStick(half, at(127, 128)).center, 'same');
  // rumore: conta solo un LSB intero
  assert.equal(compareStick({ ...at(127, 128), noise: 0.784 }, { ...at(127, 128), noise: 1.2 }).stability, 'same');
  assert.equal(compareStick({ ...at(127, 128), noise: 0.784 }, { ...at(127, 128), noise: 1.6 }).stability, 'worse');

  const res = { calibration: 100, hardware: 95, L: { score: at(127, 128) }, R: { score: at(128, 127) } };
  const html = comparisonHtml({ ts: 0, calibration: 70, hardware: 95, L: at(124, 128), R: at(128, 127) }, res, { now: 2 * 86400000 });
  assert.match(html, /Calibration 70 &rarr; 100/);
  assert.match(html, /Left<\/span> 3 steps &rarr; at floor <b class="game-delta" data-change="better">better<\/b>/);
  assert.match(html, /Right<\/span> at floor, as before <b class="game-delta" data-change="same">same<\/b>/);
  assert.match(html, /2 days ago/);
  assert.match(comparisonHtml(null, res), /First result for this controller/);
});

test('"Previous" is keyed by a salted SHA-256 of the serial and never stores the serial', async () => {
  const mem = () => {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
  };
  const store = mem();
  store.setItem('senseGameLastScore.v3', '{"overall":80}');
  const salt = localSalt(store, n => new Uint8Array(n).fill(7));
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.equal(localSalt(store), salt, 'the salt persists');
  const k1 = await controllerKey('A1B2C3D4E5', salt);
  const k2 = await controllerKey('A1B2C3D4E5', '00'.repeat(16));
  assert.match(k1, /^[0-9a-f]{32}$/);
  assert.notEqual(k1, k2, 'another salt, another key');
  assert.equal(await controllerKey('', salt), null);
  assert.equal(await controllerKey('A1B2C3D4E5', null), null);

  const run = simulateRun({ seed: 61 });
  savePrevious(store, k1, run.result, 1000);
  const raw = store.getItem(STORAGE_KEY);
  assert.equal(STORAGE_KEY, 'senseGameLastScore.v4');
  assert.doesNotMatch(raw, /A1B2C3D4E5/);
  assert.equal(store.getItem('senseGameLastScore.v3'), null, 'v3 scores are not comparable and are dropped');
  assert.equal(loadPrevious(store, k1).calibration, run.result.calibration);
  assert.equal(loadPrevious(store, k2), null, 'another controller has no previous result');
  assert.equal(loadPrevious(store, UNIDENTIFIED), null);
  // al massimo 8 controller ricordati
  for (let i = 0; i < 12; i++) savePrevious(store, `k${i}`, run.result, 2000 + i);
  assert.equal(Object.keys(JSON.parse(store.getItem(STORAGE_KEY)).entries).length, 8);
});

/* ---------------- titolo ---------------- */

test('the headline is two numbers and one plain sentence', () => {
  const s = (offset, noise) => ({ offset, noise, center: centerScore(offset), stability: stabilityScoreFor(noise), x: 0, y: 0 });
  const res = (L, R) => ({ L: { score: L }, R: { score: R }, calibration: Math.min(L.center, R.center), hardware: Math.min(L.stability, R.stability) });
  assert.equal(headlineSentence(res(s(FLOOR_PCT, 0.78), s(FLOOR_PCT, 0))), 'Both sticks rest dead center and hold steady: nothing to fix.');
  assert.match(headlineSentence(res(s(ONE_STEP_PCT, 0.78), s(FLOOR_PCT, 0))), /within one step/);
  assert.equal(headlineSentence(res(s(FLOOR_PCT, 0), s(2.0, 0.78))), 'The right stick rests 2.0% · 2 steps off center: a Quick calibration should fix that.');
  assert.match(headlineSentence(res(s(20, 0), s(FLOOR_PCT, 0))), /Guided calibration/);
  assert.match(headlineSentence(res(s(3, 0), s(FLOOR_PCT, 2.5))), /left stick rests .* and the right stick jitters by ±2\.5%/);
  for (const r of [res(s(3, 0), s(FLOOR_PCT, 2.5)), res(s(FLOOR_PCT, 0), s(FLOOR_PCT, 0))]) {
    assert.equal(headlineSentence(r).split(/[.:]\s+[A-Z]/).length, 1, 'one sentence');
  }
  assert.deepEqual([...GAME_PHASES], ['Center', 'Return', 'Range']);
});

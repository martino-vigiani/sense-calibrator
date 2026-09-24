#!/usr/bin/env node
// Fit rapido del modello firmware/rumore (parametri q, mu, s, sf, k di
// fits.json) con un emulatore minimale delle passate: niente HID né orologio,
// solo il reticolo e la regola di arresto REALE (decideAfterPass). Serve a
// scegliere i parametri; la validazione si fa con run.mjs + score.mjs, che
// eseguono runQuick per intero.
//
// Modello: per ogni stick, con probabilità q, un bias persistente su un asse
// (log-normale mu/s, più k per LSB di drift iniziale) e un errore fresco per
// passata N(0, sf) su entrambi gli assi.
//
//   node ops/sim/fit.mjs [--grid coarse|fine] [--reps 8] [--seed 11] [--top 5]
// Stampa la classifica; non riscrive fits.json (va aggiornato a mano).
import { decideAfterPass } from '../../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../../js/calib/quick.js';
import { BUCKETS, LSB, bucket, loadSessions, targetStats, templates } from './population.mjs';
import { gauss, rng } from './fake-dualsense.mjs';

const latOf = x => { const b = Math.floor(128 + x); return Math.abs(b - 127.5); };

export function simPure(par, tpls, nRep, seed = 1, params = QUICK_DEFAULTS) {
  const r = rng(seed);
  const res = [];
  for (let rep = 0; rep < nRep; rep++) for (const tpl of tpls) {
    const st = tpl.sticks.map(s => {
      const [mn, mj] = s.lat;
      const dmag = Math.hypot(mn, mj);
      const biased = r() < par.q;
      const axis = r() < 0.5 ? 0 : 1;
      const B = biased ? (r() < 0.5 ? -1 : 1) * (Math.exp(par.mu + par.s * gauss(r)) + par.k * dmag) : 0;
      return { B, axis };
    });
    const passes = [];
    let prevWorst = null, bestWorst = null;
    for (let pass = 1; pass <= params.maxPasses; pass++) {
      let worst = 0;
      for (const s of st) {
        const ex = (s.axis === 0 ? s.B : 0) + par.sf * gauss(r);
        const ey = (s.axis === 1 ? s.B : 0) + par.sf * gauss(r);
        worst = Math.max(worst, Math.hypot(latOf(ex), latOf(ey)) * LSB);
      }
      worst = +worst.toFixed(2);
      passes.push(worst);
      const d = decideAfterPass({ pass, worst, prevWorst, bestWorst }, params);
      ({ prevWorst, bestWorst } = d);
      if (d.stop) break;
    }
    res.push({ tpl, passes });
  }
  return res;
}

export function simStats(res) {
  const n = res.length, s = {};
  s.pass1Hist = new Array(BUCKETS.length).fill(0);
  for (const r of res) s.pass1Hist[bucket(r.passes[0])] += 1 / n;
  s.passLen = [0, 0, 0, 0]; for (const r of res) s.passLen[Math.min(r.passes.length, 4) - 1] += 1 / n;
  let from = 0, same = 0, better = 0;
  for (const r of res) for (let k = 0; k + 1 < r.passes.length; k++) { if (r.passes[k] < 1.2) continue; from++; if (Math.abs(r.passes[k + 1] - r.passes[k]) < 0.05) same++; else if (r.passes[k + 1] < r.passes[k]) better++; }
  s.trSame = same / from; s.trBetter = better / from;
  s.afterPass = res.filter(r => r.passes.at(-1) < 1.2).length / n;
  s.after124 = res.filter(r => Math.abs(r.passes.at(-1) - 1.24) < 0.01).length / n;
  s.byBefore = [[0, 1.2], [1.2, 3.5], [3.5, 8], [8, 15]].map(([lo, hi]) => {
    const g = res.filter(r => { const b = Math.max(...r.tpl.sticks.map(x => Math.hypot(...x.lat) * LSB)); return b >= lo && b < hi; });
    return g.filter(r => r.passes[0] < 1.2).length / g.length;
  });
  return s;
}

export function dist(a, b) {
  let d = 0;
  for (let i = 0; i < a.pass1Hist.length; i++) d += (a.pass1Hist[i] - b.pass1Hist[i]) ** 2 / (b.pass1Hist[i] + 0.01);
  for (let i = 0; i < 4; i++) d += (a.passLen[i] - b.passLen[i]) ** 2 / (b.passLen[i] + 0.01);
  d += 2 * (a.trSame - b.trSame) ** 2 / 0.25 + 2 * (a.trBetter - b.trBetter) ** 2 / 0.25;
  for (let i = 0; i < 4; i++) d += 0.5 * (a.byBefore[i] - b.byBefore[i]) ** 2 / 0.25;
  return d;
}

export const GRIDS = {
  coarse: () => {
    const g = [];
    for (const q of [0.1, 0.15, 0.2, 0.25, 0.3]) for (const mu of [-0.5, 0, 0.3, 0.6, 0.9]) for (const s of [0.3, 0.6, 0.9])
      for (const sf of [0.05, 0.15, 0.25, 0.35, 0.5]) for (const k of [0, 0.05, 0.1]) g.push({ q, mu, s, sf, k });
    return g;
  },
  fine: () => {
    const g = [];
    for (const q of [0.15, 0.2, 0.25, 0.3]) for (const mu of [-0.3, 0, 0.3, 0.6]) for (const s of [0.9, 1.1, 1.3, 1.5])
      for (const sf of [0.28, 0.32, 0.36, 0.4]) for (const k of [0, 0.05, 0.1]) g.push({ q, mu, s, sf, k });
    return g;
  },
};

if (process.argv[1]?.endsWith('fit.mjs')) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (i % 2 ? acc : [...acc, [v.replace(/^--/, ''), a[i + 1]]]), []));
  const grid = GRIDS[args.grid ?? 'fine']();
  const reps = Number(args.reps ?? 8), seed = Number(args.seed ?? 11), top = Number(args.top ?? 5);
  const rows = loadSessions();
  const T = targetStats(rows), TPL = templates(rows);
  const t0 = Date.now();
  const out = grid.map(par => { const st = simStats(simPure(par, TPL, reps, seed)); return { par, d: dist(st, T), st }; }).sort((a, b) => a.d - b.d);
  const r3 = v => +v.toFixed(3);
  console.log(JSON.stringify({
    grid: args.grid ?? 'fine', combinations: grid.length, ms: Date.now() - t0,
    target: { pass1Hist: T.pass1Hist.map(r3), passLen: T.passLen.map(r3), trSame: r3(T.trSame), trBetter: r3(T.trBetter), afterPass: r3(T.afterPass), byBefore: T.byBefore.map(r3) },
    top: out.slice(0, top).map(o => ({ d: r3(o.d), par: o.par, holdout: r3(dist(simStats(simPure(o.par, TPL, reps, seed + 988)), T)), trSame: r3(o.st.trSame), afterPass: r3(o.st.afterPass) })),
  }, null, 1));
}

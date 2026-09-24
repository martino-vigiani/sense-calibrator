#!/usr/bin/env node
// Punteggio delle uscite di run.mjs contro la telemetria reale (coorte PG).
// Tutti i numeri sono "model-verified": misurano il codice reale contro un
// controller simulato, non l'hardware.
//
// Intervalli di confidenza: bootstrap a CLUSTER, un cluster per template
// (ogni template reale è ripetuto più volte nella popolazione, quindi le sue
// sessioni non sono indipendenti; un bootstrap per sessione darebbe intervalli
// troppo stretti). Le varianti sono confrontate appaiate alla baseline,
// sessione per sessione a parità di seed.
//
//   node ops/sim/score.mjs --baseline out-baseline.json [variant.json ...] [--cohort PG] [--boot 2000]
import fs from 'node:fs';
import { cohort, loadSessions, passStats, plausible, worstOf } from './population.mjs';
import { MODEL_LABEL } from './run.mjs';

const f = x => (x === null || Number.isNaN(x) ? null : +x.toFixed(3));
const aw = r => Math.max(...r.s.after.off);
const bw = r => Math.max(...r.s.before.off);
export const completed = res => res.filter(r => r.s.after && r.s.passes.length && r.s.passes.every(p => p !== null));

export function simStats(res) {
  const done = completed(res);
  const n = done.length;
  const frac = pred => n ? done.filter(pred).length / n : null;
  const ps = passStats(done.map(r => r.s));
  const durs = done.map(r => r.dur).sort((a, b) => a - b);
  const commits = res.reduce((a, r) => a + r.counts.end, 0);
  return {
    sessions: res.length,
    completed: n,
    preflightBlocked: f(res.filter(r => r.s.aborted === 'preflight').length / res.length),
    noData: f(res.filter(r => r.s.aborted === 'no-data').length / res.length),
    errors: res.filter(r => r.outcome === 'error' || r.outcome === 'sim-error').length,
    passRate: f(frac(r => aw(r) < 1.2)),
    withinOneStep: f(frac(r => aw(r) < 1.25)),
    truePass: f(frac(r => r.trueQuant < 1.2)),
    worseThanStart: f(frac(r => aw(r) - bw(r) > 0.8)),
    lostGround: f(frac(r => aw(r) - r.s.best > 0.8)),
    final15: f(frac(r => aw(r) >= 15)),
    meanPasses: f(done.reduce((a, r) => a + r.s.passes.length, 0) / n),
    passLen: ps.passLen.map(f),
    pass1Hist: ps.pass1Hist.map(f),
    plateau: f(ps.trSame),
    nextBetter: f(ps.trBetter),
    unstable: f(frac(r => r.s.unstableEvents > 0)),
    gateOff: f(frac(r => r.s.gateOff)),
    meanDurS: f(done.reduce((a, r) => a + r.dur, 0) / n / 1000),
    p95DurS: f(durs[Math.floor(n * 0.95)] / 1000),
    maxDurS: f(durs.at(-1) / 1000),
    // Ogni passata committata dovrebbe avere esattamente i campioni previsti.
    samplesPerCommit: commits ? f(res.reduce((a, r) => a + r.counts.sample, 0) / commits) : null,
    outcomes: res.reduce((acc, r) => { acc[r.outcome] = (acc[r.outcome] ?? 0) + 1; return acc; }, {}),
  };
}

export function realStats(rows) {
  const n = rows.length;
  const ps = passStats(rows);
  return {
    sessions: n,
    passRate: f(rows.filter(r => worstOf(r.after) < 1.2).length / n),
    withinOneStep: f(rows.filter(r => worstOf(r.after) < 1.25).length / n),
    worseThanStart: f(rows.filter(r => worstOf(r.after) - worstOf(r.before) > 0.8).length / n),
    final15: f(rows.filter(r => worstOf(r.after) >= 15).length / n),
    passLen: ps.passLen.map(f),
    passCounts: ps.passLen.map(p => Math.round(p * n)),
    pass1Hist: ps.pass1Hist.map(f),
    plateau: f(ps.trSame),
    nextBetter: f(ps.trBetter),
  };
}

// Distanza L1 tra distribuzioni del numero di passate (1..max).
export function passLenL1(sim, real) {
  const len = Math.max(sim.length, real.length);
  let d = 0;
  for (let k = 0; k < len; k++) d += Math.abs((sim[k] ?? 0) - (real[k] ?? 0));
  return d;
}

// Generatore deterministico per il bootstrap (Park–Miller).
function lcg(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

// Bootstrap a cluster della media di `value(r)` (o della differenza appaiata).
export function clusterBootstrap(values, clusters, { boot = 2000, seed = 1 } = {}) {
  const byCluster = new Map();
  values.forEach((v, i) => {
    if (v === null) return;
    const c = clusters[i];
    if (!byCluster.has(c)) byCluster.set(c, { sum: 0, n: 0 });
    const e = byCluster.get(c); e.sum += v; e.n += 1;
  });
  const cl = [...byCluster.values()];
  const total = cl.reduce((a, c) => a + c.sum, 0) / cl.reduce((a, c) => a + c.n, 0);
  const rnd = lcg(seed);
  const boots = [];
  for (let k = 0; k < boot; k++) {
    let sum = 0, n = 0;
    for (let j = 0; j < cl.length; j++) { const c = cl[Math.floor(rnd() * cl.length)]; sum += c.sum; n += c.n; }
    boots.push(sum / n);
  }
  boots.sort((a, b) => a - b);
  return { mean: f(total), lo: f(boots[Math.floor(boot * 0.025)]), hi: f(boots[Math.floor(boot * 0.975)]), clusters: cl.length };
}

const passOf = r => (r.s.after && r.s.passes.every(p => p !== null) ? (aw(r) < 1.2 ? 1 : 0) : null);

function parseArgs(argv) {
  const opts = { baseline: null, cohort: 'PG', boot: 2000, files: [] };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--baseline') opts.baseline = argv[++k];
    else if (a === '--cohort') opts.cohort = argv[++k];
    else if (a === '--boot') opts.boot = Number(argv[++k]);
    else opts.files.push(a);
  }
  if (!opts.baseline) throw new Error('--baseline <run output> is required');
  return opts;
}

const readRun = file => JSON.parse(fs.readFileSync(file, 'utf8'));

if (process.argv[1]?.endsWith('score.mjs')) {
  const opts = parseArgs(process.argv.slice(2));
  const rows = loadSessions();
  const real = realStats(cohort(rows, opts.cohort));
  // Riferimento del piano (0.533): transizioni sulle sessioni plausibili di tutto il dataset.
  const plateauAllPlausible = f(passStats(rows.filter(plausible)).trSame);
  const base = readRun(opts.baseline);
  const baseStats = simStats(base.sessions);
  const report = {
    label: MODEL_LABEL,
    real: { cohort: opts.cohort, ...real },
    baseline: {
      file: opts.baseline,
      opts: base.opts,
      ...baseStats,
      passRateCI: clusterBootstrap(base.sessions.map(passOf), base.sessions.map(r => r.tpl), { boot: opts.boot }),
      vsReal: {
        passRateDelta: f(baseStats.passRate - real.passRate),
        passLenL1: f(passLenL1(baseStats.passLen, real.passLen)),
        plateau: { sim: baseStats.plateau, real: real.plateau, realAllPlausible: plateauAllPlausible },
      },
    },
    variants: [],
  };
  for (const file of opts.files) {
    const v = readRun(file);
    if (v.sessions.length !== base.sessions.length) throw new Error(`${file}: not paired with the baseline`);
    const diff = v.sessions.map((r, i) => {
      const a = passOf(r), b = passOf(base.sessions[i]);
      return a === null || b === null ? null : a - b;
    });
    report.variants.push({
      file, opts: v.opts, ...simStats(v.sessions),
      passRateDelta: clusterBootstrap(diff, v.sessions.map(r => r.tpl), { boot: opts.boot }),
    });
  }
  console.log(JSON.stringify(report, null, 2));
}

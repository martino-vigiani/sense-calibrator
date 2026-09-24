#!/usr/bin/env node
// Esegue N sessioni sintetiche (replay della distribuzione reale) contro il
// codice REALE di runQuick (js/calib/quick.js), oppure contro l'harness
// pre-refactor (--impl legacy) per la prova di equivalenza. Output JSON.
//
// Tutti i risultati sono "model-verified": dicono cosa fa il codice contro un
// modello di controller tarato sulla telemetria, non cosa fa un DualSense vero.
//
//   node ops/sim/run.mjs --n 1785 --seed 1 [--variant baseline] [--scenario normal|hold|<ops/sim/scenarios/*.mjs>]
//        [--population real|synthetic] [--impl module|legacy] [--fit best] [--workers 4]
//        [--params '{"maxPasses":4}'] [--out out.json]
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { VClock } from './vclock.mjs';
import { FakeDualSense, rng, gauss } from './fake-dualsense.mjs';
import { loadSessions, templates, syntheticTemplates, LSB } from './population.mjs';

const FITS = JSON.parse(fs.readFileSync(new URL('./fits.json', import.meta.url)));
export const MODEL_LABEL = 'model-verified';

export function fitParams(name = 'best') {
  const fit = FITS[name];
  if (!fit) throw new Error(`unknown fit ${name}; available: ${Object.keys(FITS).join(', ')}`);
  return fit.par;
}

// L'ordine delle chiamate a `r()` è quello del prototipo: cambiarlo cambia
// ogni sessione a parità di seed.
export function makeSession(tpl, r, pop, { scenario = 'normal', fit = fitParams() } = {}) {
  const sticks = tpl.sticks.map(s => {
    const [mn, mj] = s.lat;
    const cont = v => (v - 0.5 + r()) * (r() < 0.5 ? -1 : 1);
    const drift = r() < 0.5 ? [cont(mn), cont(mj)] : [cont(mj), cont(mn)];
    const worn = r() < pop.wornP;
    const noise = worn ? Math.exp(Math.log(0.4) + r() * Math.log(3 / 0.4)) : pop.sigmaN;
    const biased = r() < fit.q;
    const B = biased ? (r() < 0.5 ? -1 : 1) * (Math.exp(fit.mu + fit.s * gauss(r)) + fit.k * Math.hypot(mn, mj)) : 0;
    return { drift, noise, bias: { axis: r() < 0.5 ? 0 : 1, B } };
  });
  const schedule = [];
  if (r() < pop.heldAtStart) schedule.push({ stick: r() < 0.5 ? 0 : 1, t0: 0, dur: 500 + r() * 4000, tail: 200, amp: [30 * gauss(r), 30 * gauss(r)] });
  // tocchi casuali (Poisson) durante la sessione
  for (let t = 0; t < 60000;) { t += -Math.log(r() + 1e-12) / pop.touchRate * 1000; schedule.push({ stick: r() < 0.5 ? 0 : 1, t0: t, dur: 100 + r() * 900, tail: 150, amp: [25 * gauss(r), 25 * gauss(r)] }); }
  // Scenario "hold": una mano ferma sullo stick durante la passata 1.
  if (scenario === 'hold') { const ang = r() * 2 * Math.PI, m = 15 + r() * 45; schedule.push({ stick: r() < 0.5 ? 0 : 1, t0: 2000 + r() * 4000, dur: 1000 + r() * 5000, tail: 150, amp: [m * Math.cos(ang), m * Math.sin(ang)] }); }
  return { sticks, schedule };
}

export const POP = { sigmaN: +(process.env.SIGMA_N ?? 0.095), wornP: 0.05, heldAtStart: 0.03, touchRate: 1 / 400,
  timing: { period: 4, jitter: 0.3, gapProb: 0.0005, gapMs: [30, 200] }, fw: { sf: fitParams().sf, cmdMs: [2, 6] } };

export function loadTemplates(population) {
  if (population === 'synthetic') return syntheticTemplates();
  if (population === 'real') return templates(loadSessions());
  throw new Error(`unknown population ${population}`);
}

async function makeImpl(impl) {
  if (impl === 'legacy') {
    const { makeLegacyInstance, loadLegacySource, outcomeFromToast } = await import('./legacy/load-app.mjs');
    const app = loadLegacySource();
    return (clock, dev, tpl) => {
      const { api, events, DS5 } = makeLegacyInstance(clock, app);
      dev.oninputreport = api.onInputReport;
      api.setDs5(new DS5(dev, null));
      api.setInfo({ board: tpl.board, fwversion: 0 });
      return async () => {
        await api.quickCalibrate();
        const s = events.sessions[0];
        return { s, outcome: outcomeFromToast(events.toasts[0], s) };
      };
    };
  }
  if (impl === 'module') {
    const { makeSimInstance } = await import('./harness.mjs');
    return (clock, dev, tpl, params, hook = {}) => {
      const inst = makeSimInstance(clock, dev, { board: tpl.board, fw: 0 }, params, { isCurrent: hook.isCurrent, source: hook.source, runOpts: hook.runOpts });
      return async () => {
        const res = await inst.run();
        return { s: res.session, outcome: res.outcome, committed: res.committed, probe: inst.probe };
      };
    };
  }
  throw new Error(`unknown impl ${impl}`);
}

async function resolveParams(variant, params) {
  const { VARIANTS } = await import('./variants.mjs');
  const base = VARIANTS[variant];
  if (!base) throw new Error(`unknown variant ${variant}; available: ${Object.keys(VARIANTS).join(', ')}`);
  return { ...base, ...params };
}

// Scenari aggiuntivi in ops/sim/scenarios/<nome>.mjs (default export):
//   base        scenario incorporato su cui si appoggia ('normal' | 'hold')
//   templates(tpls, { population }) → sottoinsieme di template (opzionale)
//   apply(spec, r2, tpl)            disturbi aggiunti alla sessione
//   setup({ clock, dev, spec, r2, pop, seed, i }) → { isCurrent, source,
//               runOpts, report() } per gli scenari che toccano il ciclo di
//               vita (replug)
// `r2` è un generatore separato: lo scenario non sposta la sequenza casuale
// della sessione base, quindi le sessioni restano appaiate con la baseline.
export const BUILTIN_SCENARIOS = ['normal', 'hold'];
export async function loadScenario(name) {
  if (BUILTIN_SCENARIOS.includes(name)) return { base: name };
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad scenario name ${name}`);
  const mod = await import(new URL(`./scenarios/${name}.mjs`, import.meta.url));
  return { base: 'normal', ...mod.default };
}

// Una sessione per indice: seed del generatore e del device dipendono solo da
// (seed, i), quindi le sessioni sono indipendenti e parallelizzabili.
export async function runRange({ from, to, seed = 1, impl = 'module', population = 'real', scenario = 'normal', variant = 'baseline', params = {}, fit = 'best' }) {
  const scen = await loadScenario(scenario);
  const tpls = scen.templates ? scen.templates(loadTemplates(population), { population }) : loadTemplates(population);
  if (!tpls.length) throw new Error(`scenario ${scenario}: no templates`);
  const fitPar = fitParams(fit);
  const pop = { ...POP, fw: { ...POP.fw, sf: fitPar.sf } };
  const create = await makeImpl(impl);
  const resolved = impl === 'module' ? await resolveParams(variant, params) : null;
  const out = [];
  for (let i = from; i < to; i++) {
    const tplIndex = i % tpls.length;
    const tpl = tpls[tplIndex];
    const r = rng(seed * 100003 + i);
    const spec = makeSession(tpl, r, pop, { scenario: scen.base, fit: fitPar });
    const r2 = rng(seed * 15485863 + i + 17);
    scen.apply?.(spec, r2, tpl);
    const clock = new VClock();
    const dev = new FakeDualSense({ clock, seed: seed * 7919 + i + 1, sticks: spec.sticks, fw: pop.fw, timing: pop.timing, hand: { schedule: spec.schedule } });
    const hook = scen.setup?.({ clock, dev, spec, r2, pop, seed, i }) ?? {};
    const run = create(clock, dev, tpl, resolved, hook);
    let s, outcome, committed = null, probe = null;
    try {
      ({ s, outcome, committed = null, probe = null } = await clock.run(run()));
    } catch (e) {
      s = { passes: [], after: null, aborted: 'sim-' + e.message };
      outcome = 'sim-error';
    }
    dev.close();
    const extra = hook.report?.() ?? {};
    // verità: residuo continuo per asse (LSB) dopo l'ultima calibEnd
    const trueRes = dev.sticks.map(st => [0, 1].map(a => st.rest[a] - st.center[a]));
    const trueQuant = dev.calibEnds ? Math.max(...trueRes.map(([x, y]) => Math.hypot(Math.floor(Math.abs(x)) + 0.5, Math.floor(Math.abs(y)) + 0.5) * LSB)) : null;
    const { t, ...session } = s ?? {};
    const rec = { i, tpl: tplIndex, s: session, outcome, dur: clock.now(), calibEnds: dev.calibEnds, trueQuant, counts: { ...dev.counts } };
    // Campi di sicurezza (WS1): fuori dal golden di equivalenza (goldenRecord).
    if (committed !== null) rec.committed = committed;
    if (probe) rec.probe = { ...probe };
    if (Object.keys(extra).length) rec.extra = extra;
    out.push(rec);
  }
  return out;
}

export async function runVariant(opts) {
  const { n, workers = 1 } = opts;
  if (workers <= 1) return runRange({ ...opts, from: 0, to: n });
  const chunk = Math.ceil(n / workers);
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    const from = w * chunk, to = Math.min(n, from + chunk);
    if (from >= to) break;
    jobs.push(new Promise((resolve, reject) => {
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { ...opts, from, to } });
      worker.once('message', resolve);
      worker.once('error', reject);
    }));
  }
  return (await Promise.all(jobs)).flat();
}

function parseArgs(argv) {
  const opts = { n: 1785, seed: 1, impl: 'module', population: 'real', scenario: 'normal', variant: 'baseline', params: {}, fit: 'best', workers: 1, out: null };
  for (let k = 0; k < argv.length; k += 2) {
    const flag = argv[k].replace(/^--/, '');
    const value = argv[k + 1];
    if (!(flag in opts)) throw new Error(`unknown flag --${flag}`);
    opts[flag] = ['n', 'seed', 'workers'].includes(flag) ? Number(value) : flag === 'params' ? JSON.parse(value) : value;
  }
  return opts;
}

const { isMainThread, parentPort, workerData } = await import('node:worker_threads');
if (!isMainThread && workerData?.from !== undefined) {
  parentPort.postMessage(await runRange(workerData));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.workers === 0) opts.workers = Math.max(1, os.availableParallelism() - 1);
  const t0 = Date.now();
  const res = await runVariant(opts);
  const wall = (Date.now() - t0) / 1000;
  const out = opts.out ?? `out-${opts.impl}-${opts.variant}-${opts.scenario}-${opts.seed}.json`;
  fs.writeFileSync(out, JSON.stringify({ label: MODEL_LABEL, opts, wallS: wall, sessions: res }));
  console.log(`[${MODEL_LABEL}] ${opts.impl}/${opts.variant}/${opts.scenario} seed ${opts.seed}: ${res.length} sessions in ${wall.toFixed(1)} s → ${out}`);
}

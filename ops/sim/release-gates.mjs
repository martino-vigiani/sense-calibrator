#!/usr/bin/env node
// Gate automatici di rilascio del piano §4.2 (solo sviluppo, non fa parte di
// npm test: servono la telemetria reale e ~15 minuti di CPU).
//
//   SENSE_TELEMETRY=/path/sessions.jsonl node ops/sim/release-gates.mjs \
//     --baseline 57621c0 [--ws1 26732b0] [--dir /tmp/sense-gates] \
//     [--fits best,alt1,alt2] [--seeds 1,2,3] [--parallel 4] [--workers 3] \
//     [--boot 1000] [--params '{"refToleranceLsb":4}'] [--skip-real 1] [--json out.json]
//     [--runs-only normal,one-step]   (esperimenti: solo quelle corse, niente valutazione)
//
// Cosa fa:
// 1. costruisce l'albero di baseline (`git archive <commit>`) e, se chiesto,
//    quello di WS1, sotto `--dir/trees/`, e ci copia sopra QUESTO ops/sim:
//    stesso simulatore, stessi scenari, codice di calibrazione diverso;
// 2. esegue la matrice fit × seed × scenario (normal n=1785, gli scenari WS1
//    n=714) sui due alberi con run.mjs, in parallelo; ogni uscita ha un
//    `.stamp` (hash dei sorgenti + opzioni) e viene riusata solo se il timbro
//    coincide, quindi una modifica al codice rifà solo il candidato;
// 3. stampa ogni numero di §4.2 accanto alla sua soglia, PASS/FAIL, per ogni
//    fit × seed; più il gate 2 (equivalenza ristretta, seed 1) e il gate 4
//    (replay dei dati reali), salvo `--skip-real 1`.
//
// Tutto è "model-verified" (gate 3) o "real-data replay" (gate 4): mai una
// verifica hardware. Il candidato è l'albero di lavoro di questo file, così
// com'è (anche con modifiche non committate).
//
// Gate ridefiniti (decisione del 2026-09-25, vedi ops/sim/README.md):
// - "Final ≥15%, normal ≤0.1%" è irraggiungibile col modello: i runaway alla
//   PRIMA passata vengono dall'errore di cattura del firmware del modello e
//   sono identici nella baseline. Il gate è ora attribuibile al codice: non
//   più sessioni ≥15% della baseline appaiata (final15Normal). Il tasso
//   grezzo e le sessioni spostate in ciascun verso restano stampati come INFO.
// - "Forced hold ≤ WS1 e CI superiore <1.7%": il limite di CI si legge sulle
//   sessioni ATTRIBUIBILI alla tenuta (≥15% con la tenuta, non ≥15% nella
//   stessa sessione senza); il confronto con WS1 resta sul tasso grezzo, per
//   fit × seed, contro l'albero `--ws1` (se omesso, contro la tabella di
//   riferimento in WS1_FORCED_HOLD).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safetyStats, effective } from './safety-gates.mjs';
import { clusterBootstrap } from './score.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SIM_DIR = fileURLToPath(new URL('./', import.meta.url));
export const RELEASE_LABEL = 'model-verified';

export const SCENARIOS = {
  normal: 1785,
  'forced-hold': 714,
  'rim-hold': 714,
  'moving-hold': 714,
  'noisy-hold': 714,
  replug: 714,
  'already-centered': 714,
  'one-step': 714,
};

// Tasso "Final ≥15%, forced hold" misurato sull'albero WS1 (26732b0, punta del
// ramo quick-safety, con ops/sim di questo rilascio), n=714 per fit × seed.
// Registrato il 2026-09-25 da questo script con `--ws1 26732b0`: vedi README.
// Sessioni ≥15% su 714: best 4/5/5, alt1 6/9/7, alt2 0/0/1 (seed 1/2/3).
export const WS1_FORCED_HOLD = Object.freeze({
  'best-s1': 4 / 714, 'best-s2': 5 / 714, 'best-s3': 5 / 714,
  'alt1-s1': 6 / 714, 'alt1-s2': 9 / 714, 'alt1-s3': 7 / 714,
  'alt2-s1': 0 / 714, 'alt2-s2': 0 / 714, 'alt2-s3': 1 / 714,
});

// Gate 3.3 ridefinito: il candidato non ha PIÙ sessioni ≥15% della baseline
// appaiata. Non "0 in più per sessione": le passate dopo la prima non sono
// appaiate (il modello usa un solo generatore casuale per tempi dei report,
// rumore e cattura, quindi basta un report letto in più perché la cattura
// della passata 2 sia un'altra estrazione) e una sessione può spostarsi di un
// LSB attraverso il 15% in entrambe le direzioni.
export function final15Normal(base, cand, isHigh) {
  const b = base.filter(isHigh).length, c = cand.filter(isHigh).length;
  const extra = cand.filter((r, i) => isHigh(r) && !isHigh(base[i])).length;
  const fewer = base.filter((r, i) => isHigh(r) && !isHigh(cand[i])).length;
  return { base: b, cand: c, extra, fewer, pass: c <= b };
}

function parseArgs(argv) {
  const opts = {
    baseline: null, ws1: null, dir: path.join(process.env.TMPDIR ?? '/tmp', 'sense-release-gates'),
    fits: 'best,alt1,alt2', seeds: '1,2,3', parallel: 4, workers: 3, boot: 1000, params: '{}', 'skip-real': null, json: null,
    'runs-only': null,
  };
  for (let k = 0; k < argv.length; k += 2) {
    const flag = argv[k].replace(/^--/, '');
    if (!(flag in opts)) throw new Error(`unknown flag --${flag}`);
    opts[flag] = argv[k + 1];
  }
  if (!opts.baseline) throw new Error('usage: release-gates.mjs --baseline <commit> [--ws1 <commit>] [--dir d]');
  return {
    ...opts,
    fits: opts.fits.split(','),
    seeds: opts.seeds.split(',').map(Number),
    parallel: Number(opts.parallel),
    workers: Number(opts.workers),
    boot: Number(opts.boot),
    params: JSON.parse(opts.params),
  };
}

// Hash dei file che decidono il risultato di una corsa: il codice di
// calibrazione (js/) e il simulatore (ops/sim, fits compresi), tranne questo
// valutatore.
function treeHash(root) {
  const h = crypto.createHash('sha256');
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      // Questo file valuta soltanto: cambiarlo non deve rifare le corse.
      else if (/\.(m?js|json)$/.test(name) && name !== 'release-gates.mjs') { h.update(path.relative(root, p)); h.update(fs.readFileSync(p)); }
    }
  };
  walk(path.join(root, 'js'));
  walk(path.join(root, 'ops', 'sim'));
  return h.digest('hex').slice(0, 16);
}

// Albero di un commit con QUESTO ops/sim sopra. Non tocca il checkout né i
// worktree: `git archive` legge solo gli oggetti.
function buildTree(commit, dir) {
  const sha = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=12', commit], { encoding: 'utf8' }).trim();
  const tree = path.join(dir, 'trees', sha);
  if (!fs.existsSync(path.join(tree, '.complete'))) {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.mkdirSync(tree, { recursive: true });
    const tar = execFileSync('git', ['-C', ROOT, 'archive', sha], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', tree], { input: tar });
    fs.writeFileSync(path.join(tree, '.complete'), sha);
  }
  fs.rmSync(path.join(tree, 'ops', 'sim'), { recursive: true, force: true });
  fs.cpSync(SIM_DIR, path.join(tree, 'ops', 'sim'), { recursive: true });
  return { sha, root: tree };
}

function runJob(job) {
  return new Promise((resolve, reject) => {
    const args = [path.join(job.root, 'ops/sim/run.mjs'), '--n', String(job.n), '--seed', String(job.seed), '--fit', job.fit,
      '--scenario', job.scenario, '--workers', String(job.workers), '--out', job.out];
    if (job.params && Object.keys(job.params).length) args.push('--params', JSON.stringify(job.params));
    const child = spawn(process.execPath, args, { cwd: job.root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`${job.label}: exit ${code}\n${err.slice(-2000)}`));
      fs.writeFileSync(`${job.out}.stamp`, job.stamp);
      resolve();
    });
  });
}

async function pool(jobs, size, onDone) {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await runJob(job);
      onDone(job);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
}

const bw = r => (r.s.before ? Math.max(...r.s.before.off) : null);
const passK = r => { const e = effective(r); return e !== null && e < 1.2 ? 1 : 0; };
const worseK = r => { const e = effective(r), b = bw(r); return e === null || b === null ? null : e - b > 0.8 ? 1 : 0; };
const high = r => { const e = effective(r); return e !== null && e >= 15; };
const oneStep = r => bw(r) !== null && Math.abs(bw(r) - 1.24) < 0.01;
const pctS = x => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(2)}%`);
const ci = c => `${pctS(c.mean)} [${pctS(c.lo)}, ${pctS(c.hi)}]`;

// Tutti i gate §4.2 per una coppia fit × seed. `load(side, scenario)` →
// sessioni della corsa; `ws1` il tasso di riferimento del forced hold.
export function evaluateRun({ load, boot = 1000, ws1Rate = null }) {
  const rows = [];
  const gate = (id, metric, value, threshold, pass, info = false) => rows.push({ id, metric, value, threshold, pass, info });
  const B = load('base', 'normal'), C = load('cand', 'normal');
  if (B.length !== C.length) throw new Error('normal runs are not paired');
  const tpl = C.map(r => r.tpl);
  const sb = safetyStats(B, { boot }), sc = safetyStats(C, { boot });

  const dPass = clusterBootstrap(C.map((r, i) => passK(r) - passK(B[i])), tpl, { boot });
  gate('3.1', 'Pass-rate Δ (normal, paired)', `${ci(dPass)} (base ${pctS(sb.passRateAll.mean)} → ${pctS(sc.passRateAll.mean)})`, '≥ −0.5 pp', dPass.mean >= -0.005);
  const dWorse = clusterBootstrap(C.map((r, i) => { const a = worseK(r), b = worseK(B[i]); return a === null || b === null ? null : a - b; }), tpl, { boot });
  gate('3.2', 'Worse than start >0.8 (normal)', `${pctS(sc.worseThanStart.mean)} vs base ${pctS(sb.worseThanStart.mean)} (Δ ${ci(dWorse)})`, '≤ baseline', dWorse.mean <= 0);

  const f15 = final15Normal(B, C, high);
  gate('3.3', 'Final ≥15% normal, candidate vs paired baseline (count)', `${f15.cand} vs base ${f15.base}`, '≤ baseline', f15.pass);
  gate('3.3x', 'Final ≥15% normal, sessions that moved across 15% (INFO)', `+${f15.extra} / −${f15.fewer}`, 'one-LSB moves both ways', f15.extra <= f15.fewer, true);
  gate('3.3i', 'Final ≥15% normal, raw (model first-pass runaways)', `${sc.final15Count}/${C.length} = ${pctS(sc.final15Count / C.length)} (base ${sb.final15Count})`, '≤0.1% (superseded, INFO)', sc.final15Count / C.length <= 0.001, true);

  // Tenute: attribuibile = ≥15% con il disturbo, non ≥15% nella stessa sessione senza.
  const attributable = (runs, ref) => runs.map(r => (high(r) && !(ref[r.i] && high(ref[r.i])) ? 1 : 0));
  const CF = load('cand', 'forced-hold'), BF = load('base', 'forced-hold');
  const cf = safetyStats(CF, { boot });
  const cfRate = cf.final15Count / CF.length;
  const attrF = attributable(CF, C);
  const attrFci = clusterBootstrap(attrF, CF.map(r => r.tpl), { boot });
  if (ws1Rate === null) gate('3.4a', 'Forced hold final ≥15% vs WS1', `${pctS(cfRate)} (WS1 not measured)`, '≤ WS1', false);
  else gate('3.4a', 'Forced hold final ≥15% vs WS1', `${pctS(cfRate)} (WS1 ${pctS(ws1Rate)}, base ${pctS(safetyStats(BF, { boot }).final15Count / BF.length)})`, '≤ WS1', cfRate <= ws1Rate + 1e-9);
  gate('3.4b', 'Forced hold final ≥15%, attributable to the hold, CI upper', `${attrF.reduce((a, b) => a + b, 0)} sessions, ${ci(attrFci)}`, '< 1.7%', attrFci.hi < 0.017);
  gate('3.4i', 'Forced hold final ≥15%, raw CI upper (superseded, INFO)', ci(cf.final15), '< 1.7%', cf.final15.hi < 0.017, true);

  const CR = load('cand', 'rim-hold');
  const rimAttr = attributable(CR, C).reduce((a, b) => a + b, 0);
  gate('3.5', 'Rim hold final ≥15%, attributable', `${rimAttr}`, '0', rimAttr === 0);

  for (const sc2 of ['moving-hold', 'noisy-hold']) {
    const cs = safetyStats(load('cand', sc2), { boot }), bs = safetyStats(load('base', sc2), { boot });
    gate('3.6', `${sc2} final ≥15%`, `${cs.final15Count} vs base ${bs.final15Count}`, '≤ baseline', cs.final15Count <= bs.final15Count);
    gate('3.6', `${sc2} calibSample after a timeout`, `${cs.samplesAfterTimeout}`, '0', cs.samplesAfterTimeout === 0);
  }

  const ac = safetyStats(load('cand', 'already-centered'), { boot });
  gate('3.7', 'Commands on starts below 1.2 (already-centered + normal)', `${ac.commandsOnStartsBelowOk + sc.commandsOnStartsBelowOk} on ${ac.startsBelowOk + sc.startsBelowOk} starts`, '0', ac.commandsOnStartsBelowOk + sc.commandsOnStartsBelowOk === 0);

  const rate124 = runs => { const xs = runs.filter(oneStep); return { n: xs.length, rate: xs.length ? xs.filter(passK).length / xs.length : null }; };
  const o1c = rate124(load('cand', 'one-step')), o1b = rate124(load('base', 'one-step'));
  const d124 = o1c.rate - o1b.rate;
  gate('3.8', '1.24 starts pass rate (one-step scenario)', `${pctS(o1c.rate)} vs base ${pctS(o1b.rate)} (Δ ${(d124 * 100).toFixed(1)} pp, n=${o1c.n})`, 'within 2 pp', Math.abs(d124) <= 0.02);
  const n1c = rate124(C), n1b = rate124(B);
  gate('3.8i', '1.24 starts pass rate (normal subset)', `${pctS(n1c.rate)} vs base ${pctS(n1b.rate)} (Δ ${((n1c.rate - n1b.rate) * 100).toFixed(1)} pp, n=${n1c.n})`, 'within 2 pp (INFO)', Math.abs(n1c.rate - n1b.rate) <= 0.02, true);

  let min12 = 1, maxDur = 0;
  for (const s of Object.keys(SCENARIOS)) {
    const st = s === 'normal' ? sc : safetyStats(load('cand', s), { boot: 10 });
    min12 = Math.min(min12, st.committedPassesWith12Samples);
    maxDur = Math.max(maxDur, st.maxDurS);
  }
  gate('3.9', 'Committed passes with exactly 12 samples (all scenarios)', pctS(min12), '100%', min12 === 1);
  const rp = safetyStats(load('cand', 'replug'), { boot: 10 });
  gate('3.10', 'Replug mid-pass: commands to device B', `${rp.commandsToB}`, '0', rp.commandsToB === 0);
  gate('3.10', 'Replug mid-pass: unsaved correct', pctS(rp.unsavedCorrect), '100%', rp.unsavedCorrect === 1);
  gate('3.11', 'Timing p95 (normal)', `${sc.p95DurS} s`, '≤ 30 s', sc.p95DurS <= 30);
  gate('3.11', 'Timing max (all scenarios)', `${maxDur} s`, '≤ 90 s', maxDur <= 90);
  return rows;
}

async function realDataGates({ workers }) {
  const rows = [];
  const gate = (id, metric, value, threshold, pass) => rows.push({ id, metric, value, threshold, pass, info: false });
  const { runVariant } = await import('./run.mjs');
  const { restrictedCompare } = await import('./equivalence.mjs');
  const common = { n: 1785, seed: 1, scenario: 'normal', population: 'real', workers };
  const legacy = await runVariant({ ...common, impl: 'legacy' });
  const mod = await runVariant({ ...common, impl: 'module', variant: 'baseline' });
  const eq = restrictedCompare(legacy, mod);
  gate('2', 'WS0 equivalence, restricted to sessions no WS1 rule touches (seed 1)', `${eq.compared - eq.fieldDiffs}/${eq.compared} identical, unexpected outcome changes ${eq.unexpectedOutcomeChanges}`, 'all identical, 0 unexpected', eq.fieldDiffs === 0 && eq.unexpectedOutcomeChanges === 0 && eq.compared > 0);

  const { QUICK_DEFAULTS } = await import('../../js/calib/quick.js');
  const { VARIANTS } = await import('./variants.mjs');
  const { cohort, loadSessions } = await import('./population.mjs');
  const { replayCohort, convergedWorseCheck } = await import('./replay-sequences.mjs');
  const { replayOutcomes } = await import('./replay-telemetry.mjs');
  const { render } = await import('../../js/ui/outcome.js');
  const pg = cohort(loadSessions(), 'PG');
  const { summary } = replayCohort(pg, QUICK_DEFAULTS);
  gate('4', 'Replay: starts below 1.2 skipped / starts at 1.24 skipped', `${summary.skippedBeforeStart} of ${summary.startsBelowOkMax} / ${summary.skippedAtOrAboveOkMax}`, `all ${summary.startsBelowOkMax} / 0`, summary.skippedBeforeStart === summary.startsBelowOkMax && summary.skippedAtOrAboveOkMax === 0);
  const cw = convergedWorseCheck(pg, QUICK_DEFAULTS, { ...QUICK_DEFAULTS, ...VARIANTS.legacyStop });
  gate('4', '"Converged but worse" sessions ask for another pass', `${cw.continued} continue, ${cw.stoppedAtCeiling} stopped at the 15% ceiling, of ${cw.legacyConvergedWorse}`, 'none stops as converged', cw.pass);
  gate('4', 'Extra irreversible passes (published)', `${summary.extraPasses} (other stick at 0.555: ${summary.extraPassesOtherStickAtFloor} in ${summary.sessionsWithExtraOtherStickAtFloor} sessions)`, `≤1 per session at 0.555`, summary.extraPassesOtherStickAtFloor <= summary.sessionsWithExtraOtherStickAtFloor);
  const rt = replayOutcomes(pg, QUICK_DEFAULTS, render).summary;
  gate('4', 'Replay-telemetry: worn on worse-than-start / risky with Write unguarded', `${rt.wornWhenWorseThanStart} / ${rt.riskyWithWriteUnguarded}`, '0 / 0', rt.wornWhenWorseThanStart === 0 && rt.riskyWithWriteUnguarded === 0 && rt.renderErrors === 0);
  return rows;
}

function printRows(title, rows) {
  console.log(`\n== ${title}`);
  for (const r of rows) {
    const tag = r.info ? (r.pass ? 'info' : 'INFO') : (r.pass ? 'PASS' : 'FAIL');
    console.log(`${tag.padEnd(4)} ${r.id.padEnd(5)} ${r.metric}: ${r.value}   [${r.threshold}]`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.SENSE_TELEMETRY && !fs.existsSync(path.join(ROOT, 'data/telemetry/sessions.jsonl'))) {
    throw new Error('set SENSE_TELEMETRY: the scenarios replay the real templates');
  }
  fs.mkdirSync(path.join(opts.dir, 'runs'), { recursive: true });
  const base = buildTree(opts.baseline, opts.dir);
  const ws1 = opts.ws1 ? buildTree(opts.ws1, opts.dir) : null;
  const sides = {
    base: { root: base.root, stamp: `base:${base.sha}:${treeHash(base.root)}`, params: {} },
    cand: { root: ROOT, stamp: `cand:${treeHash(ROOT)}:${JSON.stringify(opts.params)}`, params: opts.params },
    ...(ws1 ? { ws1: { root: ws1.root, stamp: `ws1:${ws1.sha}:${treeHash(ws1.root)}`, params: {} } } : {}),
  };
  // Un candidato con `--params` ha file propri: la baseline resta condivisa.
  const paramTag = Object.keys(opts.params).length ? `-p${crypto.createHash('sha256').update(JSON.stringify(opts.params)).digest('hex').slice(0, 8)}` : '';
  const out = (side, fit, seed, scenario) => path.join(opts.dir, 'runs', `${side === 'cand' ? `cand${paramTag}` : side}-${fit}-s${seed}-${scenario}.json`);
  const jobs = [];
  for (const [side, s] of Object.entries(sides)) {
    for (const fit of opts.fits) for (const seed of opts.seeds) {
      for (const [scenario, n] of Object.entries(SCENARIOS)) {
        if (side === 'ws1' && scenario !== 'forced-hold') continue;
        const file = out(side, fit, seed, scenario);
        const stamp = `${s.stamp}|${fit}|${seed}|${scenario}|${n}`;
        const fresh = fs.existsSync(file) && fs.existsSync(`${file}.stamp`) && fs.readFileSync(`${file}.stamp`, 'utf8') === stamp;
        if (!fresh) jobs.push({ label: `${side} ${fit} s${seed} ${scenario}`, root: s.root, fit, seed, scenario, n, workers: opts.workers, out: file, stamp, params: s.params });
      }
    }
  }
  const only = opts['runs-only'] ? opts['runs-only'].split(',') : null;
  if (only) jobs.splice(0, jobs.length, ...jobs.filter(j => only.includes(j.scenario)));
  const t0 = Date.now();
  let done = 0;
  console.error(`[${RELEASE_LABEL}] ${jobs.length} runs to do (baseline ${base.sha}${ws1 ? `, ws1 ${ws1.sha}` : ''})`);
  await pool(jobs, opts.parallel, job => console.error(`  ${++done}/${jobs.length} ${job.label} (${((Date.now() - t0) / 1000).toFixed(0)} s)`));

  if (only) { console.error('runs only: no evaluation'); process.exit(0); }
  const cache = new Map();
  const read = file => {
    if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')).sessions);
    return cache.get(file);
  };
  const report = { label: RELEASE_LABEL, baseline: base.sha, ws1: ws1?.sha ?? null, params: opts.params, runs: {}, real: null };
  let failed = 0;
  for (const fit of opts.fits) for (const seed of opts.seeds) {
    const key = `${fit}-s${seed}`;
    let ws1Rate = WS1_FORCED_HOLD[key] ?? null;
    if (ws1) { const w = read(out('ws1', fit, seed, 'forced-hold')); ws1Rate = w.filter(high).length / w.length; }
    const rows = evaluateRun({ load: (side, scenario) => read(out(side, fit, seed, scenario)), boot: opts.boot, ws1Rate });
    report.runs[key] = { ws1ForcedHold: ws1Rate, rows };
    printRows(`${key} [${RELEASE_LABEL}]`, rows);
    failed += rows.filter(r => !r.pass && !r.info).length;
    cache.clear();
  }
  if (!opts['skip-real']) {
    const rows = await realDataGates({ workers: opts.workers });
    report.real = rows;
    printRows('gates 2 and 4 [model-verified equivalence, real-data replay]', rows);
    failed += rows.filter(r => !r.pass).length;
  }
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(report, null, 1));
  console.log(`\n${failed ? `${failed} gate(s) FAIL` : 'all gates PASS'} (${RELEASE_LABEL}; hardware checks are separate, see the plan §4.1/§4.3)`);
  process.exitCode = failed ? 1 : 0;
}

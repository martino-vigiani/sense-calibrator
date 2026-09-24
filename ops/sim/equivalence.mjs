#!/usr/bin/env node
// Prova di equivalenza del refactor: esegue le stesse sessioni (stesso seed,
// stessa popolazione) con l'harness pre-refactor (app.js monolitico letto da
// git, vedi legacy/load-app.mjs) e con runQuick, e confronta per sessione.
//
//   node ops/sim/equivalence.mjs [--n 1785] [--seed 1] [--scenario normal|hold]
//        [--population real|synthetic] [--workers 4] [--write-golden file]
//
// Campi confrontati: l'intero oggetto sessione (tranne `t`, il timestamp),
// l'esito, i calibEnd del firmware, il residuo vero e i comandi inviati.
// `dur` differisce per costruzione di 300 ms sulle sessioni completate: è la
// pausa prima della chiusura del modale, che resta nella UI di app.js.
import fs from 'node:fs';
import { runVariant, MODEL_LABEL } from './run.mjs';

export const EQUIV_FIELDS = ['passes', 'before', 'after', 'gate', 'unstableEvents', 'outcome'];
export const keyOf = r => JSON.stringify([r.s, r.outcome, r.calibEnds, r.trueQuant, r.counts]);
export const outcomeFieldsOf = r => JSON.stringify([r.s.passes, r.s.before, r.s.after, r.s.gate, r.s.unstableEvents, r.outcome]);

// Il golden sintetico conserva i campi che servono al test, non `dur`.
export function goldenRecord(r) {
  return { i: r.i, s: r.s, outcome: r.outcome, calibEnds: r.calibEnds, trueQuant: r.trueQuant, counts: r.counts };
}

function parseArgs(argv) {
  const opts = { n: 1785, seed: 1, scenario: 'normal', population: 'real', workers: 1, 'write-golden': null };
  for (let k = 0; k < argv.length; k += 2) {
    const flag = argv[k].replace(/^--/, '');
    if (!(flag in opts)) throw new Error(`unknown flag --${flag}`);
    opts[flag] = ['n', 'seed', 'workers'].includes(flag) ? Number(argv[k + 1]) : argv[k + 1];
  }
  return opts;
}

if (process.argv[1]?.endsWith('equivalence.mjs')) {
  const opts = parseArgs(process.argv.slice(2));
  const common = { n: opts.n, seed: opts.seed, scenario: opts.scenario, population: opts.population, workers: opts.workers };
  const t0 = Date.now();
  const legacy = await runVariant({ ...common, impl: 'legacy' });
  const t1 = Date.now();
  const mod = await runVariant({ ...common, impl: 'module' });
  const t2 = Date.now();
  let outcomeDiff = 0, fullDiff = 0;
  const durDeltas = new Map();
  for (let i = 0; i < legacy.length; i++) {
    if (outcomeFieldsOf(legacy[i]) !== outcomeFieldsOf(mod[i])) outcomeDiff++;
    if (keyOf(legacy[i]) !== keyOf(mod[i])) {
      if (fullDiff++ < 5) console.log('DIFF', i, '\n  legacy', keyOf(legacy[i]), '\n  module', keyOf(mod[i]));
    }
    const d = (legacy[i].dur - mod[i].dur).toFixed(6);
    durDeltas.set(d, (durDeltas.get(d) ?? 0) + 1);
  }
  const outcomes = {};
  for (const r of mod) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  console.log(JSON.stringify({
    label: MODEL_LABEL, ...common, sessions: legacy.length,
    outcomeFieldDiffs: outcomeDiff, fullRecordDiffs: fullDiff,
    durDeltaMs: Object.fromEntries(durDeltas), outcomes,
    wallS: { legacy: (t1 - t0) / 1000, module: (t2 - t1) / 1000 },
  }, null, 2));
  if (opts['write-golden']) {
    fs.writeFileSync(opts['write-golden'], JSON.stringify({ label: MODEL_LABEL, generatedBy: 'legacy', ...common, sessions: legacy.map(goldenRecord) }, null, 0) + '\n');
    console.log('golden written to', opts['write-golden']);
  }
  process.exitCode = outcomeDiff || fullDiff ? 1 : 0;
}

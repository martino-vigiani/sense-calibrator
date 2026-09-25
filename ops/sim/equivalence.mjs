#!/usr/bin/env node
// Prova di equivalenza del refactor: esegue le stesse sessioni (stesso seed,
// stessa popolazione) con l'harness pre-refactor (app.js monolitico letto da
// git, vedi legacy/load-app.mjs) e con runQuick, e confronta per sessione.
//
//   node ops/sim/equivalence.mjs [--n 1785] [--seed 1] [--scenario normal|hold]
//        [--population real|synthetic] [--workers 4] [--write-golden file]
//        [--restricted 1]
//
// `--restricted 1` (gate 2 del piano §4.2, dopo WS1/WS2): WS1 e WS2 cambiano
// il comportamento di proposito, quindi il confronto campo per campo vale solo
// sulle sessioni che nessuna regola WS1 può toccare (`untouchedByWs1`, la
// stessa di test/sim-equivalence.test.js); lì l'esito può cambiare solo come
// in ALLOWED_OUTCOME_CHANGES. Senza il flag il confronto è quello completo del
// refactor WS0 (oggi fallisce per costruzione: 685/1785 sul reale).
//
// Campi confrontati: l'intero oggetto sessione (tranne `t`, il timestamp),
// l'esito, i calibEnd del firmware, il residuo vero e i comandi inviati.
// `dur` differisce per costruzione di 300 ms sulle sessioni completate: è la
// pausa prima della chiusura del modale, che resta nella UI di app.js.
import fs from 'node:fs';
import { runVariant, MODEL_LABEL } from './run.mjs';
import { QUICK_DEFAULTS } from '../../js/calib/quick.js';
import { LSB_PCT } from '../../js/calib/lattice.js';

export const EQUIV_FIELDS = ['passes', 'before', 'after', 'gate', 'unstableEvents', 'outcome'];
export const keyOf = r => JSON.stringify([r.s, r.outcome, r.calibEnds, r.trueQuant, r.counts]);
export const outcomeFieldsOf = r => JSON.stringify([r.s.passes, r.s.before, r.s.after, r.s.gate, r.s.unstableEvents, r.outcome]);

// Il golden sintetico conserva i campi che servono al test, non `dur`.
export function goldenRecord(r) {
  return { i: r.i, s: r.s, outcome: r.outcome, calibEnds: r.calibEnds, trueQuant: r.trueQuant, counts: r.counts };
}

// Sessioni (del golden/legacy) che nessuna regola WS1 può toccare: una sola
// passata, partenza ≥ 1.2, nessun evento instabile, residuo sotto il tetto, e
// rumore a riposo sotto la tolleranza del riferimento in sessione (4 LSB =
// 3.14%): con un rumore più alto la regola "ogni campione entro 4 LSB dal
// riferimento" scarta finestre che il gate di prima accettava, quindi la
// sessione cambia di proposito (sul reale, seed 1: un solo caso, rumore 4.2%).
const REF_TOLERANCE_PCT = QUICK_DEFAULTS.refToleranceLsb * LSB_PCT;
export const untouchedByWs1 = g => g.s.passes.length === 1
  && Math.max(...g.s.before.off) >= 1.2
  && g.s.unstableEvents === 0
  && g.s.passes[0] < 15
  && Math.max(...(g.s.before.noise ?? [0])) < REF_TOLERANCE_PCT;

// Cambi d'esito voluti da WS2 (precedenza e nuovi esiti in quick-policy.js),
// ognuno coerente con i numeri della sessione.
export const ALLOWED_OUTCOME_CHANGES = {
  'residual>within-1-step': r => Math.max(...r.s.after.off) <= 1.25,
  'residual>residual-deterministic': r => r.s.passes.length >= 2 && r.s.passes.at(-1) === r.s.passes.at(-2),
  'worn>worse-than-start': r => Math.max(...r.s.after.off) - Math.max(...r.s.before.off) > 0.8,
};

// Confronto ristretto: `legacy` e `mod` sono due uscite di run appaiate.
export function restrictedCompare(legacy, mod) {
  let compared = 0, fieldDiffs = 0, unexpectedOutcomeChanges = 0;
  const outcomeChanges = {};
  const examples = [];
  for (let i = 0; i < legacy.length; i++) {
    const g = goldenRecord(legacy[i]);
    if (!untouchedByWs1(g)) continue;
    compared++;
    const r = goldenRecord(mod[i]);
    if (JSON.stringify({ ...r, outcome: null }) !== JSON.stringify({ ...g, outcome: null })) {
      fieldDiffs++;
      if (examples.length < 3) examples.push({ i, legacy: keyOf(legacy[i]), module: keyOf(mod[i]) });
    }
    if (r.outcome !== g.outcome) {
      const k = `${g.outcome}>${r.outcome}`;
      outcomeChanges[k] = (outcomeChanges[k] ?? 0) + 1;
      const check = ALLOWED_OUTCOME_CHANGES[k];
      if (!check || !check(r)) unexpectedOutcomeChanges++;
    }
  }
  return { compared, fieldDiffs, outcomeChanges, unexpectedOutcomeChanges, examples };
}

function parseArgs(argv) {
  const opts = { n: 1785, seed: 1, scenario: 'normal', population: 'real', workers: 1, 'write-golden': null, restricted: null };
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
  if (opts.restricted) {
    const res = restrictedCompare(legacy, mod);
    console.log(JSON.stringify({ label: MODEL_LABEL, mode: 'restricted', ...common, sessions: legacy.length, ...res }, null, 2));
    process.exitCode = res.fieldDiffs || res.unexpectedOutcomeChanges ? 1 : 0;
  } else {
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
}

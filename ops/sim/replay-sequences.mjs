#!/usr/bin/env node
// Replay delle sequenze di passate REALI nella regola di arresto: ogni sessione
// della telemetria (coorte PG di default) viene riletta passata per passata con
// decideAfterPass (js/calib/quick-policy.js) e una variante di `params`.
// Non è un modello: usa i numeri misurati, quindi dice esattamente dove una
// variante si fermerebbe prima o dopo la realtà. Oltre la fine dei dati
// registrati non si sa cosa avrebbe misurato il controller: le passate extra
// sono contate assumendo che ripetano l'ultimo valore (81/157 transizioni reali
// si ripetono identiche), e sono l'esposizione irreversibile della variante.
//
//   node ops/sim/replay-sequences.mjs [--cohort PG] [--variant baseline]
//        [--params '{"convergeEps":0}'] [--details]
import * as policy from '../../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../../js/calib/quick.js';
import { cohort, loadSessions, worstOf } from './population.mjs';

export const REPLAY_LABEL = 'real-data replay';
const FLOOR = 0.555;
const atFloor = v => Math.abs(v - FLOOR) < 0.01;

// Applica la policy a una sequenza. Ritorna dove si ferma, perché, e quante
// passate chiede oltre quelle registrate (`extra`).
export function replayDecisions(passes, params = QUICK_DEFAULTS, { beforeWorst = null, decide = policy.decideAfterPass } = {}) {
  let prevWorst = null;
  let bestWorst = null;
  const limit = Math.max(params.maxPasses, passes.length);
  for (let pass = 1; pass <= limit; pass++) {
    const worst = pass <= passes.length ? passes[pass - 1] : passes.at(-1);
    const d = decide({ pass, worst, beforeWorst, prevWorst, bestWorst }, params);
    ({ prevWorst, bestWorst } = d);
    if (d.stop || pass >= params.maxPasses) {
      return { stopAt: pass, reason: d.stop ? d.reason : 'budget', extra: Math.max(0, pass - passes.length), bestWorst };
    }
  }
  return { stopAt: limit, reason: 'budget', extra: Math.max(0, limit - passes.length), bestWorst };
}

export function replayCohort(rows, params = QUICK_DEFAULTS) {
  const summary = {
    sessions: rows.length,
    skippedBeforeStart: 0,
    sameStop: 0,
    stopsEarlier: 0,
    passesAvoided: 0,
    stopsLater: 0,
    extraPasses: 0,
    extraPassesOtherStickAtFloor: 0,
    extraPassesOther: 0,
    sessionsWithExtraOtherStickAtFloor: 0,
    reasons: {},
    startsBelowOkMax: rows.filter(r => worstOf(r.before) < params.okMax).length,
    startsAtOneStep: rows.filter(r => Math.abs(worstOf(r.before) - 1.24) < 0.01).length,
  };
  const details = [];
  for (const r of rows) {
    const beforeWorst = worstOf(r.before);
    // Punto di aggancio per una regola prima della passata 1 (es. "già
    // centrato"): se la policy la esporta, il replay la applica.
    if (typeof policy.decideBeforeStart === 'function' && policy.decideBeforeStart({ beforeWorst, before: r.before }, params)?.skip) {
      summary.skippedBeforeStart++;
      details.push({ t: r.t, passes: r.passes, skipped: true });
      continue;
    }
    const d = replayDecisions(r.passes, params, { beforeWorst });
    summary.reasons[d.reason] = (summary.reasons[d.reason] ?? 0) + 1;
    const recorded = r.passes.length;
    if (d.stopAt === recorded) summary.sameStop++;
    else if (d.stopAt < recorded) { summary.stopsEarlier++; summary.passesAvoided += recorded - d.stopAt; }
    else {
      summary.stopsLater++;
      summary.extraPasses += d.extra;
      // L'altro stick (il non peggiore) già al pavimento: ogni passata extra
      // rischia di peggiorare uno stick perfetto.
      if (atFloor(Math.min(...r.after.off))) {
        summary.extraPassesOtherStickAtFloor += d.extra;
        summary.sessionsWithExtraOtherStickAtFloor++;
      } else summary.extraPassesOther += d.extra;
    }
    details.push({ t: r.t, passes: r.passes, before: beforeWorst, stopAt: d.stopAt, reason: d.reason, extra: d.extra });
  }
  return { summary, details };
}

function parseArgs(argv) {
  const opts = { cohort: 'PG', variant: 'baseline', params: {}, details: false };
  for (let k = 0; k < argv.length; k++) {
    const flag = argv[k].replace(/^--/, '');
    if (flag === 'details') { opts.details = true; continue; }
    if (!(flag in opts)) throw new Error(`unknown flag --${flag}`);
    opts[flag] = flag === 'params' ? JSON.parse(argv[++k]) : argv[++k];
  }
  return opts;
}

if (process.argv[1]?.endsWith('replay-sequences.mjs')) {
  const opts = parseArgs(process.argv.slice(2));
  const { VARIANTS } = await import('./variants.mjs');
  if (!VARIANTS[opts.variant]) throw new Error(`unknown variant ${opts.variant}`);
  const params = { ...QUICK_DEFAULTS, ...VARIANTS[opts.variant], ...opts.params };
  const rows = cohort(loadSessions(), opts.cohort);
  const { summary, details } = replayCohort(rows, params);
  console.log(JSON.stringify({ label: REPLAY_LABEL, cohort: opts.cohort, variant: opts.variant, overrides: { ...VARIANTS[opts.variant], ...opts.params }, summary, ...(opts.details ? { details } : {}) }, null, 2));
}

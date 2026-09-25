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
//
// L'uscita include sempre `convergedWorse` (gate 4 del piano §4.2): le sessioni
// che la regola PRECEDENTE (variante legacyStop) fermava per "convergenza" su
// un valore peggiore della partenza (13 nella coorte PG), e per ognuna se la
// variante in prova chiede almeno una passata in più. Il gate passa solo se
// tutte continuano, salvo quelle chiuse dal tetto del 15% ('catastrophic').
import * as policy from '../../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../../js/calib/quick.js';
import { cohort, loadSessions, worstOf } from './population.mjs';

export const REPLAY_LABEL = 'real-data replay';
const FLOOR = 0.555;
const atFloor = v => Math.abs(v - FLOOR) < 0.01;

// Applica la policy a una sequenza. Ritorna dove si ferma, perché, e quante
// passate chiede oltre quelle registrate (`extra`), e quante ne ha aggiunte la
// regola rispetto a quella precedente (`added`: recupero o plateau).
// `otherWorst` è lo stick migliore: la telemetria v1 lo conosce solo a fine
// sessione (after.off), quindi il replay usa quel valore per ogni passata.
// Per le passate extra è l'ipotesi coerente con "ripetono l'ultimo valore".
export function replayDecisions(passes, params = QUICK_DEFAULTS, { beforeWorst = null, otherWorst = null, decide = policy.decideAfterPass } = {}) {
  let prevWorst = null;
  let bestWorst = null;
  let bestPass = null;
  let extraUsed = 0;
  const kinds = {};
  const limit = Math.max(params.maxPasses, passes.length);
  for (let pass = 1; pass <= limit; pass++) {
    const worst = pass <= passes.length ? passes[pass - 1] : passes.at(-1);
    const d = decide({ pass, worst, beforeWorst, prevWorst, bestWorst, bestPass, otherWorst, extraUsed }, params);
    ({ prevWorst, bestWorst } = d);
    bestPass = d.bestPass ?? bestPass;
    extraUsed = d.extraUsed ?? extraUsed;
    if (d.extra) kinds[d.extra] = (kinds[d.extra] ?? 0) + 1;
    if (d.stop || pass >= params.maxPasses) {
      return { stopAt: pass, reason: d.stop ? d.reason : 'budget', extra: Math.max(0, pass - passes.length), added: kinds, bestWorst, worst };
    }
  }
  return { stopAt: limit, reason: 'budget', extra: Math.max(0, limit - passes.length), added: kinds, bestWorst, worst: passes.at(-1) };
}

export function replayCohort(rows, params = QUICK_DEFAULTS) {
  const summary = {
    sessions: rows.length,
    skippedBeforeStart: 0,
    skippedAtOrAboveOkMax: 0,
    sameStop: 0,
    stopsEarlier: 0,
    passesAvoided: 0,
    stopsLater: 0,
    extraPasses: 0,
    extraPassesOtherStickAtFloor: 0,
    extraPassesOther: 0,
    sessionsWithExtraOtherStickAtFloor: 0,
    // Sessioni in cui la variante si ferma per "convergenza" su un valore
    // peggiore del punto di partenza (> convergeEps): con `bestWorst` seminato
    // dal punto di partenza devono essere 0 (13 nella regola precedente).
    convergedWorseThanStart: 0,
    // Decisioni "continua" dove la regola precedente si fermava: recupero da
    // un plateau peggiore dell'inizio, e continuazione su plateau (0 di default).
    recoveryContinuations: 0,
    plateauContinuations: 0,
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
      // Controllo WS1: una partenza a un passo (1.24) non va mai saltata.
      if (beforeWorst >= params.okMax) summary.skippedAtOrAboveOkMax++;
      details.push({ t: r.t, passes: r.passes, skipped: true });
      continue;
    }
    const d = replayDecisions(r.passes, params, { beforeWorst, otherWorst: Math.min(...r.after.off) });
    summary.reasons[d.reason] = (summary.reasons[d.reason] ?? 0) + 1;
    if (d.reason === 'converged' && d.worst > beforeWorst + params.convergeEps) summary.convergedWorseThanStart++;
    summary.recoveryContinuations += d.added.recovery ?? 0;
    summary.plateauContinuations += d.added.plateau ?? 0;
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

// Le sessioni "convergenti ma peggiori dell'inizio" per la regola precedente
// (`legacyParams`, cioè QUICK_DEFAULTS + VARIANTS.legacyStop), e dove si ferma
// `params` sulle stesse. `continued`: la variante chiede almeno una passata
// oltre il punto in cui la regola precedente dichiarava convergenza.
export function convergedWorseCheck(rows, params, legacyParams) {
  const sessions = [];
  for (const r of rows) {
    const beforeWorst = worstOf(r.before);
    const otherWorst = Math.min(...r.after.off);
    const legacy = replayDecisions(r.passes, legacyParams, { beforeWorst, otherWorst });
    if (legacy.reason !== 'converged' || !(legacy.worst > beforeWorst + legacyParams.convergeEps)) continue;
    const skipped = typeof policy.decideBeforeStart === 'function' && policy.decideBeforeStart({ beforeWorst }, params)?.skip;
    const now = skipped ? null : replayDecisions(r.passes, params, { beforeWorst, otherWorst });
    sessions.push({
      before: beforeWorst,
      passes: r.passes,
      legacyStopAt: legacy.stopAt,
      now: skipped ? 'skipped' : { stopAt: now.stopAt, reason: now.reason },
      // Una partenza saltata (sotto okMax) non riceve nessuna passata: meglio
      // ancora di "una in più", la sequenza peggiore non avviene.
      continued: skipped || now.stopAt > legacy.stopAt,
      // ≥15%: il tetto fisico chiude il ciclo come 'catastrophic' (mai
      // "convergenza", nessuna passata automatica): è l'arresto voluto.
      ceiling: !skipped && now.reason === 'catastrophic',
    });
  }
  const bad = sessions.filter(s => !s.continued && !s.ceiling);
  return {
    legacyConvergedWorse: sessions.length,
    continued: sessions.filter(s => s.continued).length,
    stoppedAtCeiling: sessions.filter(s => !s.continued && s.ceiling).length,
    notContinued: bad,
    pass: bad.length === 0,
    sessions,
  };
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
  const cw = convergedWorseCheck(rows, params, { ...QUICK_DEFAULTS, ...VARIANTS.legacyStop });
  const { sessions: _all, ...convergedWorse } = cw;
  console.log(JSON.stringify({ label: REPLAY_LABEL, cohort: opts.cohort, variant: opts.variant, overrides: { ...VARIANTS[opts.variant], ...opts.params }, summary, convergedWorse, ...(opts.details ? { details } : {}) }, null, 2));
}

#!/usr/bin/env node
// Replay delle sessioni Quick REALI nell'esito mostrato all'utente: per ogni
// sessione della telemetria v1 ricostruisce i fatti che la pagina aveva a fine
// calibrazione (worst finale, punto di partenza, migliore passata, rumore,
// eventi instabili) e li passa a classifyOutcome (js/calib/quick-policy.js),
// cioè alla stessa funzione che sceglie il messaggio nella pagina.
//
// Serve a vedere, sui dati veri, quanti utenti ricevono quale messaggio, e a
// contare gli esiti sbagliati noti (es. "worn" su un risultato peggiore
// dell'inizio) prima e dopo una modifica. Con `--renderer modulo.mjs` ogni
// esito viene anche passato alla funzione `render(outcome, facts)` esportata
// dal modulo, così un renderer di UI puro può essere provato su tutte le
// sessioni reali (il renderer può restituire { writeDisabled, writeGuarded }).
//
//   node ops/sim/replay-telemetry.mjs [--cohort PG] [--renderer path] [--details]
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyOutcome } from '../../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../../js/calib/quick.js';
import { cohort, loadSessions, worstOf } from './population.mjs';

export const REPLAY_LABEL = 'real-data replay';

// Fatti ricostruibili dalla telemetria v1 (9 campi). `bestWorst` è il minimo
// fra il punto di partenza e le passate verificate, come nel ciclo
// (decideAfterPass lo semina con il punto di partenza); `maxNoise` è il rumore
// della verifica finale (after.noise); `passes` serve a riconoscere un residuo
// che si ripete identico.
export function factsFromSession(r) {
  const verified = r.passes.filter(p => p !== null);
  const beforeWorst = r.before ? worstOf(r.before) : null;
  const seeds = beforeWorst === null ? verified : [beforeWorst, ...verified];
  return {
    worst: r.after ? worstOf(r.after) : null,
    beforeWorst,
    bestWorst: seeds.length ? Math.min(...seeds) : null,
    maxNoise: r.after ? Math.max(...r.after.noise) : null,
    unstableEvents: r.unstableEvents ?? 0,
    passes: r.passes,
  };
}

export function replayOutcomes(rows, params = QUICK_DEFAULTS, render = null) {
  const summary = {
    sessions: rows.length,
    outcomes: {},
    wornWhenWorseThanStart: 0,
    worseThanStart: 0,
    lostGround: 0,
    final15: 0,
    // Sessioni peggiori/perse/catastrofiche con "Write" né disabilitato né
    // protetto da una conferma. Senza renderer vale lo stato di oggi: nessuna
    // protezione, quindi tutte.
    riskyWithWriteUnguarded: 0,
    renderErrors: 0,
    lastPassMatchesAfter: 0,
  };
  const details = [];
  for (const r of rows) {
    const facts = factsFromSession(r);
    const outcome = classifyOutcome(facts, params);
    summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
    const worse = facts.worst !== null && facts.beforeWorst !== null && facts.worst - facts.beforeWorst > params.regressionEps;
    // "Perso terreno" rispetto alla migliore PASSATA, come prima del seme con
    // il punto di partenza: così il contatore resta confrontabile nel tempo
    // (il peggioramento rispetto all'inizio ha già il suo).
    const verified = r.passes.filter(p => p !== null);
    const lost = facts.worst !== null && verified.length > 0 && facts.worst - Math.min(...verified) > params.regressionEps;
    const catastrophic = facts.worst !== null && facts.worst >= 15;
    if (worse) summary.worseThanStart++;
    if (lost) summary.lostGround++;
    if (catastrophic) summary.final15++;
    if (worse && outcome === 'worn') summary.wornWhenWorseThanStart++;
    if (facts.worst !== null && Math.abs(r.passes.at(-1) - facts.worst) < 0.01) summary.lastPassMatchesAfter++;
    let rendered = null;
    if (render) {
      try { rendered = render(outcome, facts) ?? null; } catch { summary.renderErrors++; }
    }
    const guarded = rendered?.writeDisabled === true || rendered?.writeGuarded === true;
    if ((worse || lost || catastrophic) && !guarded) summary.riskyWithWriteUnguarded++;
    details.push({ t: r.t, board: r.board, outcome, ...facts, worse, lost, catastrophic, rendered });
  }
  return { summary, details };
}

function parseArgs(argv) {
  const opts = { cohort: 'PG', renderer: null, details: false };
  for (let k = 0; k < argv.length; k++) {
    const flag = argv[k].replace(/^--/, '');
    if (flag === 'details') { opts.details = true; continue; }
    if (!(flag in opts)) throw new Error(`unknown flag --${flag}`);
    opts[flag] = argv[++k];
  }
  return opts;
}

if (process.argv[1]?.endsWith('replay-telemetry.mjs')) {
  const opts = parseArgs(process.argv.slice(2));
  const render = opts.renderer ? (await import(pathToFileURL(path.resolve(opts.renderer)).href)).render : null;
  const rows = cohort(loadSessions(), opts.cohort);
  const { summary, details } = replayOutcomes(rows, QUICK_DEFAULTS, render);
  console.log(JSON.stringify({ label: REPLAY_LABEL, cohort: opts.cohort, renderer: opts.renderer, summary, ...(opts.details ? { details } : {}) }, null, 2));
}

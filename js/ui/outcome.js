'use strict';

// Esito di una calibrazione per l'utente: testo del pannello persistente
// #calib-outcome, blocco del tasto Write, messaggio del test drift.
//
// Modulo PURO: niente DOM, niente HID, niente timer. La pagina (app.js) lo
// usa per disegnare, ops/sim/replay-telemetry.mjs lo prova su tutte le
// sessioni reali (export `render`), i test lo coprono riga per riga di
// GRID_TABLE. Le etichette e i confini vengono da js/calib/lattice.js: qui si
// sceglie solo il testo, mai una soglia nuova.
//
// Regole che nessun testo di questo modulo può violare:
// - a 15% o più (QUICK_CATASTROPHIC_PCT) nessun esito suona come un successo e
//   Write è disabilitato: il controller monta sempre l'ultima passata, e un
//   "complete" inviterebbe a scrivere in NVS una calibrazione rovinata;
// - il consiglio di spegnere il controller (C0-11) compare solo con la NVS
//   letta `locked`, l'unico caso in cui il piano lo ammette finché H10 non
//   passa; "scollega" non compare mai come rimedio: cosa fa lo scollegamento
//   (H11) non è verificato, e il testo lo dice;
// - Range: la raccomandazione Range → Guided resta ipotetica finché H12 non
//   dice se Range sposta anche il centro.
import {
  GRID_TABLE, GUIDED_ONLY_MIN, LSB_PCT, TIER_OVERRIDES, formatOffset, tierFor, tierForOffset,
} from '../calib/lattice.js';
import { QUICK_CATASTROPHIC_PCT, classifyOutcome } from '../calib/quick-policy.js';
import { QUICK_DEFAULTS, QUICK_REGRESSION_EPS } from '../calib/quick.js';

// Tasso di riuscita pubblicato nel testo. Viene dal report di qualità v2 di
// WS3 (ops/calib-telemetry), coorte PG (n=354, generato il 2026-09-25):
// 267/354 = 75.4% finiscono sotto 1.2% (centrato), 298/354 = 84.2% entro un
// passo. Per livello di partenza (stessa coorte): Mild 71/96 = 74%, Marked
// 147/199 = 74%; con rumore a riposo >1.5%, 22/36 = 61% finiscono centrati
// (la guida lo dice "about 6 in 10"). Va rigenerato a ogni release: è un
// dato, non una promessa.
export const FIX_RATE = Object.freeze({
  cohort: 'PG',
  n: 354,
  centered: 0.754,
  withinOneStep: 0.842,
  source: 'WS3 quality report v2, 2026-09-25',
});
// La stessa cifra a parole: "about 3 in 4" regge da 0.70 a 0.80.
export const FIX_RATE_WORDS = 'about 3 in 4';

// Un asse a fondo corsa (mediana ≥99%) dopo una calibrazione: non è un drift
// residuo ma un range perso o un contatto guasto. Dalla sintesi `xy` (in %)
// di summarizeResult, che non porta il rumore: qui basta l'asse al bordo.
export const PINNED_AXIS_PCT = 99;

// Testo della rimessa a posto. Solo con NVS `locked` (vedi sopra).
export const POWER_OFF_ADVICE = 'Turn the controller off (hold PS for 10 s) before reconnecting it: that discards the temporary calibration.';
export const UNPLUG_UNKNOWN = 'We haven’t confirmed whether unplugging the cable alone discards it, so don’t rely on that.';

export function revertAdvice(nvStatus) {
  return nvStatus === 'locked' ? `${POWER_OFF_ADVICE} ${UNPLUG_UNKNOWN}` : null;
}

// Riparazione per uno stick consumato (rumore alto a riposo). L'ordine conta:
// prima la garanzia (aprire il controller la fa decadere), poi la pulizia,
// poi la sostituzione del modulo, e solo alla fine di nuovo la calibrazione.
export const REPAIR_STEPS = Object.freeze([
  'Check the warranty first: Sony or the store may replace it, and opening the controller usually ends the warranty.',
  'Cleaning can help: a little contact cleaner or compressed air around the base of the stick, with the stick moved in circles.',
  'If it keeps wandering, a repair shop can replace the stick module, including Hall-effect or TMR sticks that don’t wear the same way.',
  'After any repair, run the drift test and calibrate again.',
]);

const SIDES = ['Left', 'Right'];
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const worstOfSummary = s => (s && Array.isArray(s.off) && s.off.every(isNum) ? Math.max(...s.off) : null);

// Un asse incollato al bordo in una sintesi { off, noise, xy } (xy in %).
export function pinnedFromSummary(summary) {
  if (!summary || !Array.isArray(summary.xy)) return false;
  return summary.xy.some(pair => Array.isArray(pair) && pair.some(v => isNum(v) && Math.abs(v) >= PINNED_AXIS_PCT));
}

// Righe per stick: prima → dopo, con la cifra di formatOffset (percentuale e
// passi) e il livello di GRID_TABLE del dopo. `before`/`after` sono sintesi di
// summarizeResult; una delle due può mancare.
export function stickRows(before, after) {
  const rows = [];
  for (let i = 0; i < 2; i++) {
    const b = before?.off?.[i];
    const a = after?.off?.[i];
    if (!isNum(b) && !isNum(a)) continue;
    const pinned = isNum(a) && Array.isArray(after?.xy?.[i]) && after.xy[i].some(v => isNum(v) && Math.abs(v) >= PINNED_AXIS_PCT);
    const tier = pinned ? TIER_OVERRIDES.pinned : (isNum(a) ? tierForOffset(a) : null);
    rows.push({
      side: SIDES[i],
      before: isNum(b) ? formatOffset(b) : null,
      after: isNum(a) ? (pinned ? 'Pinned at the edge' : formatOffset(a)) : null,
      tier: tier?.id ?? null,
    });
  }
  return rows;
}

// Parole semplici per ogni riga di GRID_TABLE e per i due livelli che la
// scavalcano. `advice` è il passo successivo; `recommendation` la chiave della
// tabella, così un'azione (Guided, Range) viene dalla stessa fonte.
const TIER_WORDS = {
  centered: {
    headline: 'Centered',
    advice: 'At the measurement limit: nothing left to fix.',
  },
  'within-1-step': {
    headline: 'Within 1 step: fine to save',
    advice: `One axis is a single step (${LSB_PCT.toFixed(2)}%) from the floor, the smallest error the controller can report. That is far smaller than the dead zone games use.`,
  },
  mild: {
    headline: 'Mild drift',
    advice: `Quick calibration usually fixes this: ${FIX_RATE_WORDS} sessions end fully centered.`,
  },
  marked: {
    headline: 'Marked drift',
    advice: `Start with Quick calibration (${FIX_RATE_WORDS} sessions end fully centered). If it can’t get closer, use Guided.`,
  },
  'guided-only': {
    headline: 'Severe offset',
    advice: `Too far off-center for Quick calibration, which only starts within ${GUIDED_ONLY_MIN}%. Use Guided calibration.`,
  },
  moving: {
    headline: 'Moving',
    advice: 'The reading never settled. If nobody was touching the sticks, the sensor may be worn: calibration can’t fix a signal that won’t hold still.',
  },
  pinned: {
    headline: 'Pinned at the edge',
    advice: 'An axis reads at the very edge. That isn’t ordinary drift: try Range calibration first, then Guided if the center is still off. If it stays at the edge, the stick is likely faulty.',
  },
};

export function describeTier(id) {
  const row = GRID_TABLE.find(r => r.id === id) ?? TIER_OVERRIDES[id];
  if (!row) return null;
  return { id: row.id, ...TIER_WORDS[row.id], recommendation: row.recommendation };
}

/* ------------------------------ blocco di Write ------------------------------ */

// Motivi, dal più grave. `disabled`: Write non si può premere. `guarded`:
// avviso, Cancel col fuoco e seconda conferma esplicita.
export const LOCK_REASONS = Object.freeze({
  poisoned: { mode: 'disabled', text: 'The controller stopped responding. Turn it off (hold PS for 10 s) and reconnect it; nothing more can be sent on this connection.' },
  'needs-power-cycle': { mode: 'disabled', text: 'A calibration pass was left open. Turn the controller off (hold PS for 10 s) and reconnect it before saving anything.' },
  catastrophic: { mode: 'disabled', text: 'The last result is 15% or more off-center. Saving it would make the drift permanent.' },
  pinned: { mode: 'disabled', text: 'An axis reads at the very edge. Saving would store a broken calibration.' },
  'range-incomplete': { mode: 'disabled', text: 'The range calibration didn’t cover the whole edge. Run Range calibration again before saving.' },
  'range-already-closed': { mode: 'disabled', text: 'The range session had already closed, so its result is unknown. Run Range calibration again before saving.' },
  'worse-than-start': { mode: 'guarded', text: 'The result is worse than when you started.' },
  'lost-ground': { mode: 'guarded', text: 'An earlier pass was better than the result the controller has now.' },
  unverified: { mode: 'guarded', text: 'The last calibration couldn’t be verified. Run the drift test and check the numbers first.' },
});

// Stato di Write da tutto ciò che la RAM del controller contiene ora.
//   center  ultimo esito del centro (Quick o Guided): { outcome, worst,
//           beforeWorst, bestWorst, pinned, committed } oppure null
//   range   ultimo esito del range: { incomplete, alreadyClosed } oppure null
//   poisoned, needsPowerCycle  stato del controller
// Ritorna { mode: 'allowed'|'guarded'|'disabled', reasons: [{ code, mode, text }] }.
// Oltre all'esito, controlla i numeri (rete di sicurezza): un esito futuro o
// 'moved' non sfugge al tetto del 15% né al confronto con la partenza.
export function writeLockFor({ center = null, range = null, poisoned = false, needsPowerCycle = false } = {}) {
  const codes = [];
  if (poisoned) codes.push('poisoned');
  if (needsPowerCycle) codes.push('needs-power-cycle');
  if (center) {
    const { outcome, worst = null, beforeWorst = null, bestWorst = null, pinned = false, committed = true } = center;
    if (outcome === 'stalled' && !needsPowerCycle) codes.push('needs-power-cycle');
    if (outcome === 'catastrophic' || (isNum(worst) && worst >= QUICK_CATASTROPHIC_PCT)) codes.push('catastrophic');
    if (pinned) codes.push('pinned');
    if (outcome === 'worse-than-start' || (isNum(worst) && isNum(beforeWorst) && worst - beforeWorst > QUICK_REGRESSION_EPS)) codes.push('worse-than-start');
    if (outcome === 'lost-ground' || (isNum(worst) && isNum(bestWorst) && worst - bestWorst > QUICK_REGRESSION_EPS)) codes.push('lost-ground');
    if (!isNum(worst) && committed && outcome !== 'stalled' && outcome !== 'catastrophic') codes.push('unverified');
  }
  if (range?.incomplete) codes.push('range-incomplete');
  if (range?.alreadyClosed) codes.push('range-already-closed');
  const unique = [...new Set(codes)];
  const reasons = unique.map(code => ({ code, ...LOCK_REASONS[code] }));
  const mode = reasons.some(r => r.mode === 'disabled') ? 'disabled'
    : reasons.some(r => r.mode === 'guarded') ? 'guarded' : 'allowed';
  return { mode, reasons };
}

/* ------------------------------ viste dell'esito ------------------------------ */

const pct = v => `${v.toFixed(1)}%`;
const fmt = v => (isNum(v) ? formatOffset(v) : '—');

// Azioni che il pannello può offrire. L'app le collega ai bottoni veri, che
// passano comunque dai loro controlli (NVS, avvelenamento, power cycle).
const ACTION = {
  guided: { id: 'guided', label: 'Guided calibration' },
  range: { id: 'range', label: 'Range calibration' },
  quick: { id: 'quick', label: 'Run Quick again' },
  retest: { id: 'retest', label: 'Run the drift test' },
  recovery: { id: 'recovery', label: 'Try one recovery pass' },
};

// Il controller ha smesso di rispondere (timeout HID, DS5 avvelenato): la
// risposta del comando appeso non è mai arrivata, quindi non si sa se una
// calibrazione sia stata applicata. Nessuna "passata precedente", nessun
// salvataggio (Write è spento) e nessun Restart (rifiuta un DS5 avvelenato):
// l'unica uscita è spegnere e ricollegare. Il messaggio HID grezzo resta nel
// log, non nel pannello.
export const POISONED_OUTCOME = Object.freeze({
  title: 'The controller stopped responding',
  lines: Object.freeze([
    'The controller stopped responding. A calibration may or may not have been applied. Turn it off (hold PS for 10 s) and reconnect it, then run the drift test.',
  ]),
});
export const isPoisonError = error => error?.timeout === true || error?.poisoned === true;

// Sessione di calibrazione lasciata aperta da un errore a metà passata: come
// dopo uno stallo, il controller va spento prima di qualunque altro comando.
const LEFT_OPEN = 'The controller was left mid-calibration. Turn it off (hold PS for 10 s) and reconnect it before calibrating or saving again.';

function routeFor(worst, pinned) {
  if (pinned) return [ACTION.range, ACTION.guided];
  if (isNum(worst) && worst >= GUIDED_ONLY_MIN) return [ACTION.guided];
  return [];
}

// Vista dell'esito della calibrazione rapida.
//   run = { outcome, worst, beforeWorst, bestWorst, committed, session? }
//   (il ritorno di runQuick; `session.before/after` danno le righe per stick)
export function quickOutcomeView(run, { nvStatus = null } = {}) {
  const { outcome, worst = null, beforeWorst = null, bestWorst = null, committed = false } = run;
  const before = run.session?.before ?? null;
  const after = run.session?.after ?? null;
  const pinned = pinnedFromSummary(after);
  const revert = revertAdvice(nvStatus);
  const sticks = stickRows(before, after);
  const center = { outcome, worst, beforeWorst, bestWorst, pinned, committed };
  const view = (tone, title, lines, actions = [], extra = {}) => ({
    kind: 'quick', outcome, tone, title, lines: lines.filter(Boolean), sticks, actions, center, repair: false, ...extra,
  });

  if (outcome === 'already-centered') {
    return view('ok', 'Already centered: nothing was sent', [
      `Both sticks already read ${fmt(beforeWorst)} or better, the measurement limit. Another pass could only keep them there or make them worse.`,
    ], [], { center: null });
  }
  if (outcome === 'stalled') {
    return view('bad', 'Calibration stopped: the sticks never settled', [
      'Nothing was committed, but the controller was left mid-calibration.',
      'Turn the controller off (hold PS for 10 s) and reconnect it before calibrating or saving again.',
    ]);
  }
  if (outcome === 'error' && isPoisonError(run.error)) {
    return view('bad', POISONED_OUTCOME.title, [...POISONED_OUTCOME.lines], [], { center: { ...center, committed: true }, poisoned: true });
  }
  if (outcome === 'error') {
    const message = run.error?.message ? String(run.error.message) : 'unknown error';
    const leftOpen = run.needsPowerCycle === true;
    return view(committed || leftOpen ? 'bad' : 'warn', 'Calibration failed', [
      `The controller reported: ${message.replace(/\.+$/, '')}.`,
      committed ? 'A calibration was already applied to the controller and its result wasn’t verified. Run the drift test before deciding to save.'
        : (leftOpen ? null : 'Nothing was changed on the controller.'),
      leftOpen ? LEFT_OPEN : 'If it keeps failing, restart the controller.',
    ], leftOpen ? [] : [ACTION.retest], { center: committed || leftOpen ? { ...center, committed: true } : null });
  }
  // Rete di sicurezza indipendente dall'esito: 15% o più non è mai un successo.
  if (outcome === 'catastrophic' || (isNum(worst) && worst >= QUICK_CATASTROPHIC_PCT)) {
    return view('bad', 'Don’t save this result', [
      `The last pass ended at ${pct(worst)}${isNum(beforeWorst) ? ` (it started at ${pct(beforeWorst)})` : ''}: far too off-center for a released stick. A stick was probably held or moved, or the sensor is failing.`,
      revert ?? 'Run it again with the controller on a table and both sticks released, or use Guided calibration.',
      'Quick calibration stopped by itself: it doesn’t retry at this distance.',
    ], [ACTION.guided, ACTION.recovery]);
  }
  if (pinned) {
    return view('bad', 'An axis is stuck at the edge', [
      'After calibration an axis reads at the very edge. That isn’t drift Quick calibration can fix, and saving it would store a broken calibration.',
      revert,
      'Try Range calibration first, then Guided if the center is still off. We haven’t confirmed yet whether Range also moves the center.',
    ], routeFor(worst, true));
  }
  if (outcome === 'moved' && !isNum(worst)) {
    return view('warn', 'Calibration stopped: the sticks weren’t released', [
      'A pass was applied but couldn’t be checked before the sticks were touched. Run the drift test to see where they are now.',
    ], [ACTION.retest]);
  }
  if (outcome === 'unverified' || !isNum(worst)) {
    return view('warn', 'Result not verified', [
      'The calibration was applied, but the sticks never held still long enough to measure it. Run the drift test before deciding to save.',
    ], [ACTION.retest]);
  }
  switch (outcome) {
    case 'centered':
      return view('ok', 'Both sticks centered', [
        `Worst stick ${fmt(worst)}, the measurement limit. Write it to memory to keep it after the controller turns off.`,
      ]);
    case 'within-1-step':
      return view('ok', 'Within 1 step: fine to save', [
        `Worst stick ${fmt(worst)}. ${describeTier('within-1-step').advice}`,
      ]);
    case 'worse-than-start':
      return view('bad', 'Worse than when you started', [
        `Don’t write this to memory. The result is ${fmt(worst)}; the sticks started at ${fmt(beforeWorst)}. Every pass replaces the previous one, so the controller can’t go back to where it started.`,
        revert ?? 'Run Quick again with the controller on a table and both sticks released.',
      ], [ACTION.quick]);
    case 'lost-ground':
      return view('warn', 'An earlier pass was better', [
        `A pass reached ${fmt(bestWorst)}, but the controller keeps the last pass, now at ${fmt(worst)}. Run Quick again to try to get back there; saving now keeps ${pct(worst)}.`,
        revert,
      ], [ACTION.quick]);
    case 'worn':
      return view('warn', 'Re-centered as far as a worn sensor allows', [
        `Worst stick ${fmt(worst)}. The signal wanders even at rest, a sign of a worn or dirty stick sensor. Calibration can re-center the stick, but the noise will stay.`,
        'You can save this if it’s better than before.',
      ], [], { repair: true });
    case 'unstable':
      return view('warn', 'The sticks moved during calibration', [
        `Worst stick ${fmt(worst)}. Some samples were skipped because the sticks were moving. Put the controller on a table, hands off, and run it again.`,
      ], [ACTION.quick]);
    case 'moved':
      return view('warn', 'Calibration stopped: the sticks weren’t released', [
        `The last checked pass left the worst stick at ${fmt(worst)}. Release both sticks and run it again to continue.`,
      ], [ACTION.quick]);
    case 'residual-deterministic':
      return view('warn', 'Quick calibration can’t get closer: try Guided', [
        `Worst stick ${fmt(worst)}. The last two passes landed on exactly the same value, so another Quick run is unlikely to change it. Guided calibration samples the center differently.`,
        'You can save this if it’s better than before.',
      ], [ACTION.guided]);
    default: {
      const improved = isNum(beforeWorst) && beforeWorst - worst > QUICK_REGRESSION_EPS;
      return view('warn', improved ? 'Improved, not fully centered' : 'Not fully centered', [
        `Worst stick ${fmt(worst)}${isNum(beforeWorst) ? `, from ${fmt(beforeWorst)}` : ''}. You can save it if it’s better than before, run Quick again, or try Guided.`,
      ], [ACTION.quick, ACTION.guided]);
    }
  }
}

// Esito della procedura guidata: prima e dopo misurati dal wizard, stessa
// classificazione (e stessi margini) della rapida, con la partenza come unico
// riferimento. `error` se la procedura è fallita dopo un commit.
export function guidedOutcomeView({ before = null, after = null, error = null, committed = true, leftOpen = false } = {}, { nvStatus = null } = {}) {
  const beforeWorst = worstOfSummary(before);
  const worst = worstOfSummary(after);
  const pinned = pinnedFromSummary(after);
  const center = { outcome: 'guided', worst, beforeWorst, bestWorst: beforeWorst, pinned, committed };
  const sticks = stickRows(before, after);
  const revert = revertAdvice(nvStatus);
  const view = (outcome, tone, title, lines, actions = [], extra = {}) => ({
    kind: 'guided', outcome, tone, title, lines: lines.filter(Boolean), sticks, actions, center: { ...center, outcome }, repair: false, ...extra,
  });
  if (error && isPoisonError(error)) {
    return view('error', 'bad', POISONED_OUTCOME.title, [...POISONED_OUTCOME.lines], [],
      { center: { ...center, outcome: 'error', worst: null, committed: true }, poisoned: true });
  }
  if (error) {
    return view('error', committed || leftOpen ? 'bad' : 'warn', 'Guided calibration failed', [
      `The controller reported: ${String(error.message ?? error).replace(/\.+$/, '')}.`,
      committed ? 'Part of it may have been applied. Run the drift test before deciding to save.'
        : (leftOpen ? null : 'Nothing was changed on the controller.'),
      leftOpen ? LEFT_OPEN : 'If it keeps failing, restart the controller.',
    ], leftOpen ? [] : [ACTION.retest], { center: committed || leftOpen ? { ...center, outcome: 'error', worst: null, committed: true } : null });
  }
  if (!isNum(worst)) {
    return view('unverified', 'warn', 'Guided calibration applied, not verified', [
      'The sticks didn’t hold still long enough to measure the result. Run the drift test before deciding to save.',
    ], [ACTION.retest]);
  }
  if (worst >= QUICK_CATASTROPHIC_PCT) {
    return view('catastrophic', 'bad', 'Don’t save this result', [
      `The result is ${pct(worst)}: far too off-center. A stick was probably still held when a corner was sampled, or the sensor is failing.`,
      revert ?? 'Run Guided again, releasing both sticks fully before each Continue.',
    ], [ACTION.guided]);
  }
  if (pinned) {
    return view('pinned', 'bad', 'An axis is stuck at the edge', [
      'An axis reads at the very edge. Saving it would store a broken calibration.',
      revert,
      'Try Range calibration, then Guided again. We haven’t confirmed yet whether Range also moves the center.',
    ], [ACTION.range, ACTION.guided]);
  }
  // Stessa regola della rapida, con la partenza come migliore punto noto.
  const noise = Array.isArray(after?.noise) && after.noise.every(isNum) ? Math.max(...after.noise) : null;
  const outcome = classifyOutcome({ worst, beforeWorst, bestWorst: beforeWorst, maxNoise: noise, unstableEvents: 0, passes: [worst] }, QUICK_DEFAULTS);
  if (outcome === 'worse-than-start') {
    return view(outcome, 'bad', 'Worse than when you started', [
      `Don’t write this to memory. The result is ${fmt(worst)}; the sticks started at ${fmt(beforeWorst)}.`,
      revert ?? 'Run Guided again, releasing both sticks fully before each Continue.',
    ], [ACTION.guided]);
  }
  if (outcome === 'centered') return view(outcome, 'ok', 'Both sticks centered', [`Worst stick ${fmt(worst)}, the measurement limit. Write it to memory to keep it.`]);
  if (outcome === 'within-1-step') return view(outcome, 'ok', 'Within 1 step: fine to save', [`Worst stick ${fmt(worst)}. ${describeTier('within-1-step').advice}`]);
  if (outcome === 'worn') {
    return view(outcome, 'warn', 'Re-centered as far as a worn sensor allows', [
      `Worst stick ${fmt(worst)}. The signal wanders even at rest: calibration can re-center the stick, but the noise will stay.`,
    ], [], { repair: true });
  }
  return view(outcome, 'warn', 'Not fully centered', [
    `Worst stick ${fmt(worst)}${isNum(beforeWorst) ? `, from ${fmt(beforeWorst)}` : ''}. You can save it if it’s better than before, or run the procedure again.`,
  ], [ACTION.guided]);
}

// Esito del range. `incomplete` copre anche "Finish anyway" (WS7).
export function rangeOutcomeView({ incomplete = false, alreadyClosed = false, error = null, committed = false } = {}) {
  const range = { incomplete, alreadyClosed: alreadyClosed || (!!error && committed) };
  const view = (tone, title, lines, actions = []) => ({ kind: 'range', outcome: 'range', tone, title, lines, sticks: [], actions, range, repair: false });
  if (error && isPoisonError(error)) return view('bad', POISONED_OUTCOME.title, [...POISONED_OUTCOME.lines]);
  if (error) {
    return view(committed ? 'bad' : 'warn', 'Range calibration failed', [
      `The controller reported: ${String(error.message ?? error).replace(/\.+$/, '')}.`,
      committed ? 'Its result is unknown, so Write is off until you run Range calibration again.' : 'Nothing was changed on the controller.',
    ], [ACTION.range]);
  }
  if (alreadyClosed) {
    return view('warn', 'Range session had already closed', [
      'The controller had already ended the range session, so nothing from this run was applied.',
      'Write stays off until a range calibration completes: run it again.',
    ], [ACTION.range]);
  }
  if (incomplete) {
    return view('bad', 'Range incomplete: not saved', [
      'The sticks didn’t cover the whole edge, and the controller is now using that partial range. Write is off.',
      'Run Range calibration again and rotate both sticks all the way round, pressed against the edge.',
    ], [ACTION.range]);
  }
  return view('ok', 'Range calibration applied (not saved yet)', [
    'Check the result with the drift test and the precision test, then write it to memory to keep it.',
  ], [ACTION.retest]);
}

/* ------------------------------ test drift ------------------------------ */

// Messaggio del test drift e raccomandazione, dal livello peggiore dei due
// stick. `result` è l'uscita di analyzeDrift (con `unstable` sul risultato
// intero); `previous` il test prima dell'ultima calibrazione non salvata.
const SEVERITY = ['centered', 'within-1-step', 'mild', 'marked', 'guided-only', 'pinned', 'moving'];
export function stickTier(result, side) {
  const r = result?.[side];
  if (!r) return null;
  return tierFor({ ...r, unstable: result.unstable === true });
}

export function driftMessage(result, { previous = null, unsaved = false } = {}) {
  const tiers = ['left', 'right'].map(side => stickTier(result, side)).filter(Boolean);
  const worstTier = tiers.sort((a, b) => SEVERITY.indexOf(b.id) - SEVERITY.indexOf(a.id))[0];
  const worst = Math.max(result.left.offset, result.right.offset);
  const noisy = Math.max(result.left.noise, result.right.noise) > QUICK_DEFAULTS.noiseWorn;
  let text;
  switch (worstTier?.id) {
    case 'moving':
      text = 'The sticks kept moving during the test. If nobody was touching them, the signal is unstable (a sign of a worn sensor): calibration can reduce drift like this, but not remove it.';
      break;
    case 'pinned':
      text = `Pinned at the edge: ${describeTier('pinned').advice}`;
      break;
    case 'guided-only':
      text = `Severe offset (${pct(worst)}). ${describeTier('guided-only').advice}`;
      break;
    case 'marked':
      text = `Marked drift detected. ${describeTier('marked').advice}`;
      break;
    case 'mild':
      text = `Mild drift detected. ${describeTier('mild').advice}`;
      break;
    case 'within-1-step':
      text = 'Within 1 step of center: fine to use as it is. Quick calibration often brings it to the floor if you want it perfect.';
      break;
    default:
      text = 'Sticks correctly centered. No calibration needed.';
  }
  if (noisy && worstTier?.id !== 'moving') {
    text += ' The signal is also noisy at rest, a sign of wear: calibration can re-center the stick, but the noise will stay.';
  }
  if (previous && unsaved) {
    const before = Math.max(previous.left.offset, previous.right.offset);
    text = `Worst stick: before ${formatOffset(before)} → now ${formatOffset(worst)}. ${text}`;
  }
  return { text, tier: worstTier?.id ?? null, recommendation: worstTier?.recommendation ?? null };
}

/* ------------------------------ HTML e log ------------------------------ */

const escapeHtml = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// HTML del pannello #calib-outcome. Tutto il testo passa da escapeHtml: i
// messaggi d'errore vengono dal controller o dal browser.
export function outcomeHtml(view) {
  if (!view) return '';
  const e = escapeHtml;
  const rows = view.sticks?.length
    ? `<dl class="outcome-sticks">${view.sticks.map(r => `<div><dt>${e(r.side)}</dt><dd>${r.before ? `<span class="outcome-before">${e(r.before)}</span> <span aria-hidden="true">→</span><span class="sr-only"> to </span> ` : ''}<b>${e(r.after ?? 'not measured')}</b></dd></div>`).join('')}</dl>`
    : '';
  const lines = view.lines.map(l => `<p>${e(l)}</p>`).join('');
  const repair = view.repair
    ? `<details class="outcome-repair"><summary>What else can fix a worn stick</summary><ol>${REPAIR_STEPS.map(s => `<li>${e(s)}</li>`).join('')}</ol></details>`
    : '';
  const actions = view.actions?.length
    ? `<div class="outcome-actions">${view.actions.map(a => `<button type="button" class="btn btn-secondary btn-sm" data-outcome-action="${e(a.id)}">${e(a.label)}</button>`).join('')}</div>`
    : '';
  return `<h3 class="outcome-title">${e(view.title)}</h3>${rows}${lines}${repair}${actions}`;
}

// Riga del pannello log, coerente col pannello: "complete" solo quando lo è.
export function outcomeLogLine(run) {
  const { outcome, worst } = run;
  if (outcome === 'catastrophic' || (isNum(worst) && worst >= QUICK_CATASTROPHIC_PCT)) {
    return `Quick calibration stopped: last pass at ${worst.toFixed(1)}%, the result must not be saved.`;
  }
  if (outcome === 'moved') return 'Quick calibration stopped before the next pass: the sticks were not released.';
  if (!isNum(worst)) return 'Quick calibration applied, result not verified.';
  return `Quick calibration complete (${outcome}, worst stick ${formatOffset(worst)}).`;
}

// Riepilogo per il modale di Write: le cifre per stick e, se c'è, l'avviso.
export function flashSummary(view, lock) {
  const rows = view?.sticks ?? [];
  const numbers = rows.filter(r => r.after).map(r => `${r.side}: ${r.before ? `${r.before} → ` : ''}${r.after}`);
  const warnings = lock.reasons.filter(r => r.mode === 'guarded').map(r => r.text);
  return { numbers, warnings, guarded: lock.mode === 'guarded', disabled: lock.mode === 'disabled' };
}

/* ------------------------------ replay ------------------------------ */

// Renderer per ops/sim/replay-telemetry.mjs --renderer: dai fatti di una
// sessione reale (v1, 9 campi) costruisce la vista e il blocco di Write come
// la pagina. `nvStatus` di default `locked`: il caso che mostra più testo.
export function render(outcome, facts) {
  const run = {
    outcome,
    worst: facts.worst,
    beforeWorst: facts.beforeWorst,
    bestWorst: facts.bestWorst,
    committed: true,
    session: facts.session ?? null,
  };
  const view = quickOutcomeView(run, { nvStatus: facts.nvStatus ?? 'locked' });
  const lock = writeLockFor({ center: view.center });
  const html = outcomeHtml(view);
  return {
    title: view.title,
    tone: view.tone,
    lock: lock.mode,
    writeDisabled: lock.mode === 'disabled',
    writeGuarded: lock.mode === 'guarded',
    showsWorn: view.outcome === 'worn' || /worn/i.test(view.title),
    htmlLength: html.length,
  };
}

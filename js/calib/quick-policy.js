'use strict';

import { LSB_PCT } from './lattice.js';

// Regole di arresto ed esito della calibrazione rapida, come funzioni pure.
// Il simulatore e ops/sim/replay-sequences.mjs le applicano a sequenze di
// passate reali o sintetiche per confrontare varianti di `params` senza
// toccare un controller.

// Tetto fisico: un residuo verificato ≥15% non è drift di uno stick rilasciato
// ma uno stick tenuto o un sensore guasto. È lo stesso raggio assoluto del
// guard di avvio (QUICK_CENTER_RADIUS in js/quick-center-guard.js, 0.15), in
// punti percentuali. Sopra questo valore la regola non dichiara mai
// "convergenza" e non spende altre passate: ogni passata è irreversibile, e
// ripetere con la stessa mano sullo stick riscrive lo stesso errore
// ([100,100], [16…16] nei dati reali). Il recupero è un'opzione esplicita
// dell'utente (quick-safety / UX dei risultati), non una decisione del ciclo.
export const QUICK_CATASTROPHIC_PCT = 15;

// Margine sotto il tetto entro cui la regola NON aggiunge passate rispetto a
// quella precedente (recupero, continuazione su plateau): un passo di reticolo
// su entrambi gli assi, 1 LSB·√2 ≈ 1.109 punti. Un plateau a 14.52 (dopo una
// partenza a 8.39) è a un passo da 15.3: la regola precedente si fermava lì
// ("worse-than-start", sotto il 15%), la continuazione di recupero spendeva
// un'altra passata irreversibile e finiva 'catastrophic' (model-verified,
// ops/sim alt1-s2 #144 e noisy-hold alt1-s3 #459). §4.5 revoca la release per
// UNA sola sessione partita sotto il 15% che finisce oltre: le passate in più
// non si prendono dove un passo basta a superarlo.
export const QUICK_CEILING_MARGIN = LSB_PCT * Math.SQRT2;

// Un passo di quantizzazione: 1 LSB = 0.784 punti, e con un solo asse a 1 LSB
// dal centro l'offset vale 1.240%. Fino a 1.25 il residuo è "entro un passo"
// (salvabile), sopra è un residuo vero. È il limite della riga "Within 1 step"
// di GRID_TABLE (js/calib/lattice.js): lattice.js nasce in un workstream
// parallelo, quindi qui ce n'è una copia; appena esiste va importato da lì.
export const QUICK_WITHIN_ONE_STEP_MAX = 1.25;

// Continuazione su plateau: DISATTIVA di default. Il +3.2 pp è un'uscita del
// modello e sui dati reali, dallo stato che questa regola governa (due passate
// identiche ≥1.2), ci sono 3 transizioni e 0 successi. Si accende solo come
// passo separato del rollout, dopo i gate del modello e del replay.
export const QUICK_PLATEAU_EXTRA_PASSES = 0;
// Esposizione dello stick buono. Ogni passata ricalibra ENTRAMBI gli stick
// (calibBegin [1,1,1]): quando l'altro stick è già al pavimento (0.555, cioè
// < okMax) ogni passata in più rischia di rovinare uno stick perfetto (9 dei
// 155 stick perfetti nei dati sono stati danneggiati così). Le passate che
// questa regola aggiunge rispetto a quella precedente (recupero da un plateau
// peggiore dell'inizio, continuazione su plateau) sono quindi al massimo
// QUICK_EXTRA_AT_FLOOR_CAP in quel caso, qualunque sia il parametro.
export const QUICK_EXTRA_AT_FLOOR_CAP = 1;

// Default dei parametri introdotti qui, per chi chiama con un `params` che non
// li contiene (test, varianti parziali). runQuick li riceve da QUICK_DEFAULTS.
// `seedBestWithBefore: false` e `catastrophicPct: Infinity` esistono solo per
// riprodurre la regola precedente nel simulatore (variante `legacyStop`) e
// nei golden pre-refactor.
export const POLICY_DEFAULTS = Object.freeze({
  catastrophicPct: QUICK_CATASTROPHIC_PCT,
  withinOneStepMax: QUICK_WITHIN_ONE_STEP_MAX,
  plateauExtraPasses: QUICK_PLATEAU_EXTRA_PASSES,
  extraAtFloorCap: QUICK_EXTRA_AT_FLOOR_CAP,
  ceilingMargin: QUICK_CEILING_MARGIN,
  seedBestWithBefore: true,
});
const withDefaults = params => ({ ...POLICY_DEFAULTS, ...params });

// Decisione dopo una passata VERIFICATA (worst non nullo).
//   state  = { pass, worst, beforeWorst, prevWorst, bestWorst, bestPass?,
//              otherWorst?, extraUsed? }
//            prevWorst/bestWorst/bestPass null alla passata 1. `bestWorst` è
//            il migliore visto incluso il punto di partenza, `bestPass` la
//            migliore passata; `otherWorst` l'offset dello stick migliore in
//            questa verifica (null se ignoto); `extraUsed` le passate già
//            aggiunte rispetto alla regola precedente.
//   params = { okMax, convergeEps, maxPasses } più i POLICY_DEFAULTS
// Ritorna { stop, reason, regressed, extra, prevWorst, bestWorst, bestPass,
// extraUsed }: il chiamante ripassa lo stato alla passata successiva.
// reason: 'target' | 'catastrophic' | 'converged' | 'floor-cap' (plateau
//         peggiore dell'inizio, ma lo stick buono è al pavimento e la passata
//         extra concessa è già stata spesa) | 'near-ceiling' (plateau entro
//         un passo di reticolo dal tetto: nessuna passata extra) | 'budget'
//         (passate finite) | 'continue'.
// `extra`: null, oppure perché si continua dove la regola precedente si
//         fermava: 'recovery' (plateau peggiore dell'inizio) o 'plateau'
//         (continuazione su plateau). `regressed` = la passata è peggiore
//         della precedente (si continua, se c'è budget).
export function decideAfterPass(state, params) {
  const p = withDefaults(params);
  const { pass, worst, beforeWorst = null, otherWorst = null } = state;
  let { prevWorst, bestWorst } = state;
  // `bestPass` va ripassato dal chiamante; se manca e non c'è un punto di
  // partenza, `bestWorst` è già la migliore passata (la regola precedente).
  let bestPass = state.bestPass !== undefined ? state.bestPass : (beforeWorst === null ? bestWorst : null);
  const extraUsed = state.extraUsed ?? 0;
  // Il riferimento parte dal punto di partenza, non dalla prima passata. Con
  // `null` una sequenza 2 → 2 partita da 0.555 risultava "convergente" (13
  // sessioni PG si sono fermate così, peggiori dell'inizio e con passate
  // residue; dopo una regressione il 33% delle passate successive recupera).
  // Ogni calibEnd sovrascrive il precedente e non si torna né a una passata né
  // all'inizio: `bestWorst` serve solo a riconoscere che il risultato attuale
  // è peggiore di uno già visto, e il punto di partenza è il primo.
  const seeded = p.seedBestWithBefore && beforeWorst !== null;
  if (bestWorst === null && seeded) bestWorst = beforeWorst;
  if (bestWorst === null || worst < bestWorst) bestWorst = worst;
  if (bestPass === null || worst < bestPass) bestPass = worst;
  const out = (stop, reason, more = {}) => ({
    stop, reason, regressed: false, extra: null, prevWorst, bestWorst, bestPass, extraUsed, ...more,
  });
  if (worst < p.okMax) return out(true, 'target');

  const gain = prevWorst === null ? Infinity : prevWorst - worst;
  prevWorst = worst;
  // Regressione, non convergenza. Il codice non può rileggere la calibrazione
  // dal controller: fermarsi qui congelerebbe il peggioramento. Con budget
  // residuo si riprova.
  const regressed = gain < 0;
  // Tetto fisico prima di tutto il resto: né "converso" né altre passate.
  // Non è un `break` su "non è migliorato": è implausibilità fisica.
  if (worst >= p.catastrophicPct) return out(true, 'catastrophic', { regressed });
  const lastPass = pass >= p.maxPasses;
  const atFloor = otherWorst !== null && otherWorst < p.okMax;
  // Vicino al tetto una passata in più può superarlo con un solo passo: le
  // passate che questa regola aggiunge (recupero, plateau) non si prendono.
  const nearCeiling = worst >= p.catastrophicPct - p.ceilingMargin;
  // Plateau vicino alla migliore passata: per la regola precedente era
  // convergenza. Un plateau raggiunto DOPO una regressione (5.0 → 5.4 → 5.35)
  // non lo era già prima, e continua senza limiti come allora.
  if (!regressed && gain < p.convergeEps && worst <= bestPass + p.convergeEps) {
    if (seeded && worst > beforeWorst + p.convergeEps) {
      // Plateau peggiore del punto di partenza (es. 0.555 → 2 → 2): non è
      // convergenza, si usa il budget per recuperare. Ma se lo stick buono è
      // al pavimento, una sola passata in più.
      if (lastPass) return out(true, 'budget', { regressed });
      if (nearCeiling) return out(true, 'near-ceiling', { regressed });
      if (atFloor && extraUsed >= p.extraAtFloorCap) return out(true, 'floor-cap', { regressed });
      return out(false, 'continue', { regressed, extra: 'recovery', extraUsed: extraUsed + 1 });
    }
    // Convergenza vera, salvo continuazione su plateau (0 di default).
    const allowed = atFloor ? Math.min(p.plateauExtraPasses, p.extraAtFloorCap) : p.plateauExtraPasses;
    if (extraUsed < allowed && !lastPass && !nearCeiling) {
      return out(false, 'continue', { regressed, extra: 'plateau', extraUsed: extraUsed + 1 });
    }
    return out(true, 'converged', { regressed });
  }
  return out(lastPass, lastPass ? 'budget' : 'continue', { regressed });
}

// Ultime due passate verificate identiche (valori arrotondati come in
// session.passes): il firmware manca il centro sempre nello stesso modo, e
// altre passate rapide non lo cambiano (81/157 transizioni reali si ripetono).
const DETERMINISTIC_EPS = 0.01;
function repeatsExactly(passes) {
  if (!Array.isArray(passes) || passes.length < 2) return false;
  const [a, b] = passes.slice(-2);
  return a !== null && b !== null && Math.abs(a - b) < DETERMINISTIC_EPS;
}

// Esito mostrato all'utente a fine sessione.
//   facts = { worst, beforeWorst, bestWorst, maxNoise, unstableEvents, passes? }
//   (`bestWorst` include il punto di partenza quando decideAfterPass lo semina;
//   `passes` sono i worst per passata, null per una passata non verificata)
// Ritorna 'unverified' | 'catastrophic' | 'worse-than-start' | 'lost-ground' |
//         'worn' | 'unstable' | 'residual-deterministic' | 'within-1-step' |
//         'residual' | 'centered'.
//
// Precedenza: catastrophic > worse-than-start > lost-ground > worn >
// residual-deterministic > within-1-step > centered. Gli avvisi di danno
// vengono prima delle spiegazioni: uno stick "consumato" che è peggiorato
// riceveva "limite hardware" (4 sessioni PG), cioè un messaggio che non gli
// diceva di aver perso terreno rispetto all'inizio.
// Due eccezioni, entrambe disgiunte dal resto:
// - `centered` (< okMax) è controllato per primo. Sotto okMax nessun esito di
//   danno è possibile (0.8 punti sopra il pavimento 0.555 superano okMax), e
//   un rumore alto con il centro raggiunto non è un limite hardware: resta
//   "centrato" come oggi.
// - `residual-deterministic` vale solo sopra un passo: un 1.24 che si ripete
//   è comunque "entro un passo, salvabile", e suggerirgli Guided sarebbe
//   rumore. Così i due esiti non si sovrappongono e l'ordine resta quello.
// `unstable` (movimento durante il campionamento) resta una spiegazione del
// residuo, subito dopo `worn` come nell'ordine precedente.
export function classifyOutcome(facts, params) {
  const p = withDefaults(params);
  const { worst, beforeWorst, bestWorst, maxNoise, unstableEvents, passes } = facts;
  if (worst === null) return 'unverified';
  if (worst < p.okMax) return 'centered';
  if (worst >= p.catastrophicPct) return 'catastrophic';
  if (beforeWorst !== null && worst - beforeWorst > p.regressionEps) return 'worse-than-start';
  if (bestWorst !== null && worst - bestWorst > p.regressionEps) return 'lost-ground';
  if (maxNoise !== null && maxNoise > p.noiseWorn) return 'worn';
  if (unstableEvents > 0) return 'unstable';
  if (worst > p.withinOneStepMax && repeatsExactly(passes)) return 'residual-deterministic';
  if (worst <= p.withinOneStepMax) return 'within-1-step';
  return 'residual';
}

// Regola PRIMA della passata 1 (WS1): se entrambi gli stick sono già sotto
// `okMax` (1.2 = entrambi al pavimento 0.555, 0 LSB di errore) non si invia
// alcun comando. Dati PG: 29 partenze sotto 1.2, nessuna è migliorata e 4 sono
// peggiorate. Le partenze a 1.24 (un passo) calibrano normalmente: 24/30
// arrivano sotto 1.2. Il replay (ops/sim/replay-sequences.mjs) applica la
// stessa funzione alle sequenze reali.
//   state = { beforeWorst }   params = { okMax }
// Ritorna { skip, reason } con reason 'already-centered' | null.
export function decideBeforeStart({ beforeWorst }, { okMax }) {
  const skip = Number.isFinite(beforeWorst) && beforeWorst < okMax;
  return { skip, reason: skip ? 'already-centered' : null };
}

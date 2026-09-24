'use strict';

// Regole di arresto ed esito della calibrazione rapida, come funzioni pure.
// Sono le regole in produzione, estratte senza modifiche: il simulatore e
// ops/sim/replay-sequences.mjs le applicano a sequenze di passate reali o
// sintetiche per confrontare varianti di `params` senza toccare un controller.

// Decisione dopo una passata VERIFICATA (worst non nullo).
//   state  = { pass, worst, beforeWorst, prevWorst, bestWorst } (prevWorst/bestWorst
//            null alla passata 1; beforeWorst oggi non è usato dalla regola)
//   params = { okMax, convergeEps, maxPasses }
// Ritorna { stop, reason, regressed, prevWorst, bestWorst } con lo stato aggiornato.
// reason: 'target' | 'converged' | 'budget' (passate finite) | 'continue'.
// `regressed` = la passata è peggiore della precedente (si continua, se c'è budget).
export function decideAfterPass({ pass, worst, prevWorst, bestWorst }, { okMax, convergeEps, maxPasses }) {
  // Ogni calibEnd è applicato subito e sovrascrive il precedente: `bestWorst`
  // serve solo a riconoscere la regressione, non si può tornare a quella passata.
  if (bestWorst === null || worst < bestWorst) bestWorst = worst;
  if (worst < okMax) return { stop: true, reason: 'target', regressed: false, prevWorst, bestWorst };

  const gain = prevWorst === null ? Infinity : prevWorst - worst;
  prevWorst = worst;
  // Regressione, non convergenza. Il codice non può rileggere la calibrazione
  // dal controller: fermarsi qui congelerebbe il peggioramento. Con budget
  // residuo si riprova.
  const regressed = gain < 0;
  if (!regressed && gain < convergeEps && worst <= bestWorst + convergeEps) {
    // Convergenza vera. La seconda condizione evita di dichiarare "converso"
    // un plateau raggiunto DOPO una regressione: senza, la sequenza
    // 5.0 → 5.4 → 5.35 uscirebbe qui lasciando inutilizzato il budget
    // residuo, cioè esattamente il recupero che si voleva tentare.
    return { stop: true, reason: 'converged', regressed, prevWorst, bestWorst };
  }
  const stop = pass >= maxPasses;
  return { stop, reason: stop ? 'budget' : 'continue', regressed, prevWorst, bestWorst };
}

// Esito mostrato all'utente a fine sessione. L'ordine è quello dei toast di
// oggi: prima gli esiti che descrivono lo stato raggiunto (centrato, limite
// hardware), poi gli avvisi di peggioramento. Nota: `worn` precede
// `worse-than-start`, quindi uno stick consumato che è peggiorato riceve il
// messaggio "limite hardware" (difetto noto, da correggere in quick-policy).
//   facts = { worst, beforeWorst, bestWorst, maxNoise, unstableEvents }
// Ritorna 'unverified' | 'centered' | 'worn' | 'worse-than-start' |
//         'lost-ground' | 'unstable' | 'residual'.
export function classifyOutcome({ worst, beforeWorst, bestWorst, maxNoise, unstableEvents }, { okMax, regressionEps, noiseWorn }) {
  if (worst === null) return 'unverified';
  const lostGround = bestWorst !== null && worst - bestWorst > regressionEps;
  const worseThanStart = beforeWorst !== null && worst - beforeWorst > regressionEps;
  const worn = maxNoise !== null && maxNoise > noiseWorn;
  if (worst < okMax) return 'centered';
  if (worn) return 'worn';
  if (worseThanStart) return 'worse-than-start';
  if (lostGround) return 'lost-ground';
  if (unstableEvents > 0) return 'unstable';
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

// Varianti di parametri per runQuick, come override di QUICK_DEFAULTS
// (js/calib/quick.js). Nessuna patch testuale: una variante è solo un oggetto.
// `baseline` è il comportamento in produzione e deve restare vuota.
export const VARIANTS = {
  baseline: {},
  // Regola di arresto PRECEDENTE (prima di quick-stopping-policy): `bestWorst`
  // parte dalla prima passata e nessun tetto fisico. Serve a confrontare
  // appaiato, con lo stesso codice e lo stesso seed, l'effetto del seme e del
  // tetto; e a riprodurre i golden pre-refactor.
  legacyStop: { seedBestWithBefore: false, catastrophicPct: Infinity },
  // Continuazione su plateau, valore candidato. Si accende in produzione solo
  // come passo separato del rollout e solo se reggono i gate del modello
  // (bootstrap a cluster, limite inferiore > 0 su tutti e tre i fit) e del
  // replay reale (esposizione "altro stick a 0.555" pubblicata, danno agli
  // stick perfetti non in aumento), con il tasso di plateau del modello
  // ricalibrato su 0.533 ±0.03.
  plateau1: { plateauExtraPasses: 1 },
};

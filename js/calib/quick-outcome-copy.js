// Testo del toast finale della calibrazione rapida, per ogni esito di
// classifyOutcome (js/calib/quick-policy.js). Modulo puro, senza DOM, così i
// test verificano il testo senza caricare app.js.
//
// Testo PROVVISORIO: il pannello dell'esito e il blocco di Write sono di WS5,
// che riscrive anche queste frasi. Qui vale una sola regola, che WS5 deve
// mantenere: a 15% o più (QUICK_CATASTROPHIC_PCT) nessun percorso suona come
// un successo. Il controller monta sempre la calibrazione dell'ultima passata,
// quindi un messaggio "complete" su uno stick fuori di 15% inviterebbe a
// scrivere in NVS una calibrazione rovinata.
//
// Il consiglio di spegnere il controller (C0-11) compare solo con la NVS
// confermata `locked`: finché H10 non passa è l'unica condizione in cui il
// piano lo ammette. Mai "scollega": dipende da H11, non verificato.
import { QUICK_CATASTROPHIC_PCT } from './quick-policy.js';

const pct = v => `${v.toFixed(1)}%`;

function catastrophicToast({ worst, beforeWorst, nvStatus }) {
  const start = beforeWorst === null || beforeWorst === undefined ? '' : ` (it started at ${pct(beforeWorst)})`;
  const next = nvStatus === 'locked'
    ? 'Turn the controller off (hold PS for 10 s), then try again with both sticks released, or use guided calibration.'
    : 'Try again with both sticks released, or use guided calibration.';
  return [`The last pass ended at ${pct(worst)}${start}: a stick was likely held or moved. Don’t write this calibration to memory. ${next}`, 12000];
}

// Ritorna [messaggio, durata ms] per toast(). `nvStatus` è lo stato NVS letto
// dal controller ('locked' | 'unlocked' | 'pending_reboot' | null).
export function quickOutcomeToast({ outcome, worst, beforeWorst = null, bestWorst = null, nvStatus = null }) {
  if (outcome === 'unverified' || worst === null || worst === undefined) {
    return ['Calibration applied, but the result could not be verified: run the drift test to check it.', 6000];
  }
  // Rete di sicurezza indipendente dalla precedenza: qualunque esito (anche uno
  // futuro o sconosciuto) con l'ultima passata a 15% o più riceve l'avviso.
  if (outcome === 'catastrophic' || worst >= QUICK_CATASTROPHIC_PCT) {
    return catastrophicToast({ worst, beforeWorst, nvStatus });
  }
  switch (outcome) {
    case 'centered':
      return ['Quick calibration complete.'];
    case 'within-1-step':
      return [`Quick calibration complete, residual offset ${pct(worst)}: within one calibration step of center.`, 6000];
    case 'worse-than-start':
      return [`The last pass ended worse than the starting point (${pct(worst)} against ${pct(beforeWorst)}). Don’t write it to memory; repeat the calibration keeping the controller still.`, 7000];
    case 'lost-ground':
      return [`Calibration complete at ${pct(worst)}, but an earlier pass had reached ${pct(bestWorst)}. Repeat it to try to get back there.`, 7000];
    case 'worn':
      return [`Calibration complete, residual offset ${pct(worst)}. The signal is noisy (worn sensor): this is likely the hardware limit.`, 6000];
    case 'unstable':
      return [`Calibration complete, residual offset ${pct(worst)}. Movement was detected during sampling: repeat on a stable surface.`, 6000];
    case 'residual-deterministic':
      return [`Calibration complete, residual offset ${pct(worst)}. Repeated passes land on the same value, so another quick pass is unlikely to help: try guided calibration.`, 7000];
    default:
      return [`Calibration complete, residual offset ${pct(worst)}. If it persists, try the guided one.`, 6000];
  }
}

// Riga di log coerente col toast: "complete" solo quando lo è davvero.
export function quickOutcomeLog({ outcome, worst }) {
  if (outcome === 'catastrophic' || (typeof worst === 'number' && worst >= QUICK_CATASTROPHIC_PCT)) {
    return `Quick calibration stopped: last pass at ${worst.toFixed(1)}%, the result must not be saved.`;
  }
  return 'Quick calibration complete.';
}

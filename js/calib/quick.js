'use strict';

// Calibrazione rapida del centro, senza DOM: la pagina (app.js) la avvia e ne
// mostra l'esito, il simulatore (ops/sim) la esegue contro un DualSense
// virtuale. È lo stesso codice in entrambi i casi, per costruzione.
//
// Calibra con campioni gated sulla stabilità, verifica, e ripete finché
// l'offset scende: si ferma da solo a soglia raggiunta o a convergenza
// (miglioramento sotto epsilon = pavimento del rumore).
//
// Ogni calibEnd() è applicato subito dal firmware e sovrascrive il precedente;
// il codice non rilegge mai la calibrazione dal controller, quindi una passata
// peggiorativa è irreversibile. Per questo il ciclo non si ferma su una
// regressione (userebbe il budget residuo per recuperare) e tiene `bestWorst`.

import { DRIFT_MOVE_SPREAD, DRIFT_OK_MAX, summarizeResult } from './measure.js';
import {
  QUICK_STABLE_MS,
  QUICK_STABLE_SPREAD,
  QUICK_STABLE_TIMEOUT,
  measureOffset as measureOffsetFrom,
  waitForStable as waitForStableFrom,
} from './sampling.js';
import { classifyOutcome, decideAfterPass } from './quick-policy.js';

export const QUICK_MAX_PASSES = 4;
export const QUICK_SAMPLES_PER_PASS = 12;
// Uno stick consumato oscilla da solo: il gate si adatta al rumore proprio
// del controller (stimato dalla misura baseline) e non scende mai sotto
// QUICK_STABLE_SPREAD né sale oltre QUICK_STABLE_SPREAD_MAX. Così il jitter
// automatico non blocca la calibrazione, ma l'escursione grande di una mano
// viene ancora respinta.
// Tetto = DRIFT_MOVE_SPREAD: un gate di stabilità più permissivo della soglia
// con cui l'app stessa dichiara "questo è movimento" sarebbe auto-contraddittorio
// (a 0.12 bastavano due allargamenti per superarla e far passare una mano).
export const QUICK_STABLE_SPREAD_MAX = DRIFT_MOVE_SPREAD;
// Sotto questo miglioramento tra passate l'offset residuo è al pavimento
// del rumore: ripetere non serve più.
export const QUICK_CONVERGE_EPS = 0.15;    // punti percentuali
// Soglia per dichiarare un PEGGIORAMENTO all'utente. Deve stare sopra un passo
// di quantizzazione (1 LSB = 0.784 punti): sotto, la differenza fra due misure
// è rumore di misura e avvisare produrrebbe solo falsi allarmi.
export const QUICK_REGRESSION_EPS = 0.8;
export const QUICK_NOISE_WORN = 1.5;       // noise p95 oltre cui il sensore è consumato
export { QUICK_STABLE_MS, QUICK_STABLE_SPREAD, QUICK_STABLE_TIMEOUT };

// Parametri di oggi. Una variante del simulatore è un override di questo
// oggetto, mai una patch al codice.
export const QUICK_DEFAULTS = Object.freeze({
  maxPasses: QUICK_MAX_PASSES,
  samplesPerPass: QUICK_SAMPLES_PER_PASS,
  okMax: DRIFT_OK_MAX,
  stableSpread: QUICK_STABLE_SPREAD,
  stableSpreadMax: QUICK_STABLE_SPREAD_MAX,
  stableMs: QUICK_STABLE_MS,
  stableTimeoutMs: QUICK_STABLE_TIMEOUT,
  convergeEps: QUICK_CONVERGE_EPS,
  regressionEps: QUICK_REGRESSION_EPS,
  noiseWorn: QUICK_NOISE_WORN,
  // Attesa iniziale col gate largo del test drift: serve solo a lasciar
  // staccare la mano, non a giudicare il jitter proprio dello stick.
  preflightSpread: DRIFT_MOVE_SPREAD,
  preflightTimeoutMs: 3000,
  baselineMs: 1000,
  verifyMs: 1500,
  // Gate adattivo: vedi il commento nel ciclo.
  gateNoiseFactor: 2.5,
  gateDecay: 1.25,
  gateWiden: 1.6,
  gateOffDelayMs: 100,
  sampleSettleMs: 60,
  endDelayMs: 150,
});

// Esiti: 'preflight' (nessun comando inviato), 'error' (eccezione; vedi
// `committed`), oppure uno degli esiti finali di classifyOutcome.
//
// deps:
//   controller  oggetto con calibBegin/calibSample/calibEnd (un DS5)
//   source      sorgente degli stick (vedi sampling.js)
//   clock       { sleep, setTimeout, clearTimeout }
//   isCurrent() false se il controller è stato scollegato o sostituito. Oggi è
//               consultato solo nel preflight, come prima dell'estrazione.
//   onProgress  riceve { phase, pass?, worst? } e { bar } per la UI
//   log         messaggi per il pannello log
//   params      override di QUICK_DEFAULTS
//   meta        { board, fw } per la sessione di telemetria
//   sampler     { waitForStable, measureOffset } già legati a source/clock:
//               solo per i test che vogliono sceneggiare le attese
//
// Non lancia: un errore HID diventa { outcome: 'error', error, committed }.
// `committed` è vero se la RAM del controller può essere cambiata (almeno un
// calibEnd riuscito, o una riparazione di calibBegin che ha committato).
export async function runQuick({
  controller,
  source,
  clock,
  isCurrent = () => true,
  onProgress = () => {},
  log = () => {},
  params = {},
  meta = {},
  sampler = null,
}) {
  const p = { ...QUICK_DEFAULTS, ...params };
  const waitForStable = sampler?.waitForStable ?? (opts => waitForStableFrom(source, clock, opts));
  const measureOffset = sampler?.measureOffset ?? ((ms, opts) => measureOffsetFrom(source, clock, ms, opts));
  // Vero dal primo calibEnd riuscito: da lì la RAM del controller contiene una
  // calibrazione nuova, e un errore in una passata successiva non la annulla.
  let committedAny = false;
  const session = {
    kind: 'quick',
    t: new Date().toISOString(),
    board: meta.board ?? null,
    fw: meta.fw ?? null,
    before: null,
    passes: [],
    after: null,
    unstableEvents: 0,
  };
  const blocked = () => {
    session.aborted = 'preflight';
    return { session, outcome: 'preflight', committed: false };
  };
  try {
    onProgress({ phase: 'preflight' });
    const settled = await waitForStable({ spread: p.preflightSpread, holdMs: p.stableMs, timeoutMs: p.preflightTimeoutMs, requireCentered: true });
    if (!settled || !isCurrent()) return blocked();
    const before = await measureOffset(p.baselineMs, { requireCentered: true });
    session.before = summarizeResult(before);
    session.settled = settled;
    // La baseline non può includere uno stick inclinato. Ricontrolla inoltre
    // una finestra fresca prima di qualsiasi comando: la mano può tornare
    // sullo stick durante la misura, o gli input report possono fermarsi.
    if (!before || !await waitForStable({ spread: p.preflightSpread, holdMs: p.stableMs, timeoutMs: p.preflightTimeoutMs, requireCentered: true }) || !isCurrent()) {
      return blocked();
    }

    // Gate adattivo: `noise` è il p95 (in %) della deviazione dalla mediana.
    // Il fattore 2.5 è tarato sul max delle escursioni dei quattro assi su una
    // finestra di ~60 campioni (rapporto reale 2.2 medio, 2.56 al p95): non è
    // il "2× per asse singolo" che verrebbe da intuire, e abbassarlo a 2 fa
    // collassare il gate se il controller riporta a 1000 Hz invece di 250.
    //
    // L'avvio richiede una baseline vicina al centro e un gate riuscito.
    // Questo gate adattivo gestisce il rumore durante le passate successive;
    // non può aggirare la protezione assoluta prima del primo calibBegin.
    let baseGate = p.stableSpread;
    if (before) {
      const noise = Math.max(before.left.noise, before.right.noise) / 100;
      baseGate = Math.min(p.stableSpreadMax, Math.max(p.stableSpread, noise * p.gateNoiseFactor));
      if (baseGate > p.stableSpread)
        log(`Noisy signal: stability gate widened to ±${(baseGate * 100).toFixed(1)}%.`);
    }
    // Punto di partenza, nella stessa scala delle passate. Oggi decideAfterPass
    // non lo usa (lo stato completo è passato comunque); classifyOutcome sì.
    const beforeWorst = Math.max(before.left.offset, before.right.offset);
    let gateSpread = baseGate;
    let gateMax = baseGate;
    let gateOff = false;
    let gateWidenings = 0;

    let worst = null;
    let prevWorst = null;
    let bestWorst = null;
    let result = null;
    for (let pass = 1; pass <= p.maxPasses; pass++) {
      // Il gate si restringe verso la baseline a ogni passata: un disturbo
      // isolato nella passata 1 non deve lasciare tutte le successive con un
      // gate permissivo. Il decadimento (1.25) è deliberatamente più debole
      // dell'allargamento (1.6): fossero uguali, ogni passata ripartirebbe
      // esattamente dal valore che ha già fallito e ri-pagherebbe per intero
      // un timeout da 5 s per campione.
      // `gateOff` invece resta: si attiva solo dopo ripetuti fallimenti a gate
      // massimo, e riaprirlo significherebbe pagare di nuovo quei timeout.
      gateSpread = Math.max(baseGate, gateSpread / p.gateDecay);
      const base = ((pass - 1) / p.maxPasses) * 100;
      onProgress({ phase: 'pass', pass });
      onProgress({ bar: base + 3 });

      await controller.calibBegin();
      for (let i = 0; i < p.samplesPerPass; i++) {
        if (!gateOff) {
          const stable = await waitForStable({ spread: gateSpread, holdMs: p.stableMs, timeoutMs: p.stableTimeoutMs });
          if (!stable) {
            // Segnale mai fermo entro il gate: campiona comunque (il firmware
            // media), traccia l'evento e allarga il gate una volta invece di
            // pagare il timeout su ogni campione successivo.
            session.unstableEvents += 1;
            if (gateSpread < p.stableSpreadMax) {
              gateSpread = Math.min(p.stableSpreadMax, gateSpread * p.gateWiden);
              gateMax = Math.max(gateMax, gateSpread);
              gateWidenings += 1;
              log(`Gate widened to ±${(gateSpread * 100).toFixed(1)}% (signal moving on its own).`);
            } else {
              gateOff = true;
              log('Signal never stable even at the widest gate: sampling without gating.');
            }
            onProgress({ phase: 'unstable', pass });
          }
        } else {
          await clock.sleep(p.gateOffDelayMs);
        }
        await controller.calibSample();
        await clock.sleep(p.sampleSettleMs);
        onProgress({ bar: base + 3 + ((i + 1) / p.samplesPerPass) * 16 });
      }
      await clock.sleep(p.endDelayMs);
      await controller.calibEnd();
      committedAny = true;

      onProgress({ phase: 'verify', pass });
      result = await measureOffset(p.verifyMs);
      onProgress({ bar: base + 100 / p.maxPasses });
      if (!result) {
        // La calibrazione di QUESTA passata è già stata applicata da calibEnd,
        // ma non è stata verificata: `worst` conteneva il residuo della passata
        // precedente, ormai sovrascritta. Tenerlo significherebbe mostrare
        // (e mandare in telemetria) un numero riferito a una calibrazione che
        // non è più sul controller.
        worst = null;
        session.passes.push(null);
        session.aborted = 'no-data';
        log(`Pass ${pass}: not enough samples to verify the result.`);
        break;
      }
      worst = Math.max(result.left.offset, result.right.offset);
      session.passes.push(+worst.toFixed(2));
      const decision = decideAfterPass({ pass, worst, beforeWorst, prevWorst, bestWorst }, p);
      ({ prevWorst, bestWorst } = decision);
      log(`Pass ${pass}: residual offset ${worst.toFixed(2)}%`);
      if (decision.reason === 'target') break;
      if (decision.regressed)
        log(`Pass ${pass} came out worse than the previous one: trying again instead of stopping.`);
      if (decision.reason === 'converged') {
        log('Converged: residual offset at the noise floor, further passes won’t help.');
        break;
      }
      if (pass < p.maxPasses) onProgress({ phase: 'next', pass, worst });
    }

    session.after = worst === null ? null : summarizeResult(result);
    session.best = bestWorst === null ? null : +bestWorst.toFixed(2);
    // `gate` è il valore finale, che con gateOff o dopo un decadimento non dice
    // quanto si è dovuto allargare: `gateMax` è il dato utile per il tuning.
    session.gate = +gateSpread.toFixed(3);
    session.gateMax = +gateMax.toFixed(3);
    session.gateBase = +baseGate.toFixed(3);
    session.gateWidenings = gateWidenings;
    session.gateOff = gateOff;

    // Il controller monta SEMPRE la calibrazione dell'ultima passata: non si può
    // tornare alla migliore. L'esito lo dice invece di annunciare come
    // risultato un numero che non è il migliore ottenuto.
    const maxNoise = result && worst !== null ? Math.max(result.left.noise, result.right.noise) : null;
    const outcome = classifyOutcome({ worst, beforeWorst, bestWorst, maxNoise, unstableEvents: session.unstableEvents }, p);
    return { session, outcome, committed: true, worst, beforeWorst, bestWorst };
  } catch (error) {
    // La RAM del controller è cambiata se una passata precedente ha già chiuso
    // con calibEnd (un errore alla passata 2 non la annulla), oppure se la
    // riparazione di calibBegin ha committato prima che la calibrazione partisse.
    session.aborted = 'error';
    session.err = String(error?.message || error).slice(0, 120);
    return { session, outcome: 'error', error, committed: committedAny || error?.committed === true };
  }
}

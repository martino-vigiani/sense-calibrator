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

import { DRIFT_MIN_STABLE, DRIFT_MOVE_SPREAD, DRIFT_OK_MAX, summarizeResult } from './measure.js';
import {
  QUICK_STABLE_MS,
  QUICK_STABLE_SPREAD,
  QUICK_STABLE_TIMEOUT,
  STICK_LSB,
  measureOffset as measureOffsetFrom,
  waitForStable as waitForStableFrom,
} from './sampling.js';
import { POLICY_DEFAULTS, classifyOutcome, decideAfterPass, decideBeforeStart } from './quick-policy.js';

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
  // Regola di arresto ed esito (js/calib/quick-policy.js): tetto fisico,
  // soglia "entro un passo", continuazione su plateau (0 = disattiva) e
  // `bestWorst` seminato con il punto di partenza.
  ...POLICY_DEFAULTS,
  // --- WS1 quick-safety ---
  // Tenuta prima di OGNI passata: la stessa guardia del preflight (stabile e
  // entro il raggio assoluto del 15%, nel frame calibrato perché nessuna
  // sessione è aperta). Fino a 8 s, poi nessun comando.
  holdTimeoutMs: 8000,
  // Dopo quanto senza tenuta la UI mostra "lascia gli stick" (solo messaggio).
  holdPromptMs: 1000,
  // Campioni in sessione: centro della finestra entro 4 LSB dal riferimento
  // preso dopo calibBegin (stesso frame, vedi sampling.js).
  refToleranceLsb: 4,
  // Il riferimento stesso deve avere entrambi gli stick entro il 50%: un
  // pollice sul bordo (60–100%) arrivato tra calibBegin e la prima finestra
  // stabile non diventa il "centro" della passata. È un limite di
  // plausibilità, non un confronto tra frame: si assume che nessuno stick a
  // riposo legga oltre il 50% nemmeno se a sessione aperta i report fossero
  // grezzi. Da confermare con H0; se H0 lo smentisce, ogni passata andrebbe in
  // stallo (sicuro, ma da correggere). Il raggio del 15% resta solo fuori
  // sessione, dove il frame è noto.
  refRadius: 0.5,
  // Stallo: meno di samplesPerPass campioni entro 15 s → prompt; dopo altri
  // 30 s (o Cancel) la passata è abbandonata SENZA calibEnd.
  stallMs: 15000,
  stallGraceMs: 30000,
  // Tentativi di verifica dopo calibEnd prima di dichiarare la passata non verificata.
  verifyAttempts: 2,
  // Una verifica è "stabile" se la sua frazione di campioni stabili arriva a
  // DRIFT_MIN_STABLE, oppure se il suo rumore (p95) non supera questa quota
  // di quello della baseline: uno stick consumato è rumoroso anche da fermo e
  // la sua frazione stabile oscilla molto (52% → 22% sullo stesso stick nel
  // simulatore), mentre una mano che si muove alza il rumore ben oltre.
  verifyNoiseRatio: 1.5,
  // Tetto di durata della sessione. Nessuna passata parte se non resta il
  // tempo per campionare fino al prompt di stallo e per verificare; lo stallo
  // abbandona la passata prima del tetto. Ordine di grandezza: p95 simulato ~24 s.
  maxSessionMs: 90000,
  // Tetto fisico (`catastrophicPct`): viene da POLICY_DEFAULTS qui sopra, un
  // solo valore per la regola d'arresto (quick-policy.js) e per la verifica
  // di questo ciclo. È il raggio della guardia (QUICK_CENTER_RADIUS) in
  // punti percentuali: un residuo verificato oltre non è un drift
  // correggibile da Quick e chiude il ciclo con 'catastrophic'.
  // Rumore della baseline oltre cui si chiede di lasciare gli stick. Solo un
  // messaggio: il gate adattivo NON cambia (evidenza n=13, troppo poca).
  noisyStartPct: 3,
});

// Esiti:
//   'preflight'        nessun comando inviato (preflight, baseline o tenuta
//                      prima della passata 1 falliti)
//   'already-centered' entrambi gli stick già sotto okMax: nessun comando
//                      (`force: true` lo scavalca)
//   'moved'            tenuta fallita prima di una passata successiva: la RAM
//                      ha la calibrazione dell'ultima passata (committed)
//   'stalled'          meno di samplesPerPass campioni in sessione entro il
//                      tempo concesso, o Cancel: sessione lasciata aperta,
//                      nessun calibEnd; `needsPowerCycle` (committed)
//   'disconnected'     controller scollegato o sostituito a metà
//   'catastrophic'     residuo verificato ≥ catastrophicPct
//   'error'            eccezione HID; vedi `committed`
//   oppure uno degli esiti finali di classifyOutcome.
//
// deps:
//   controller  oggetto con calibBegin/calibSample/calibEnd (un DS5): è
//               l'UNICO bersaglio dei comandi, catturato dal chiamante
//   source      sorgente degli stick (vedi sampling.js)
//   clock       { sleep, setTimeout, clearTimeout }
//   isCurrent() false se il controller è stato scollegato o sostituito:
//               controllato dopo OGNI await; il ciclo esce con 'disconnected'
//   isCancelled() true quando l'utente preme Cancel durante uno stallo
//   force       true per calibrare anche una partenza già centrata. Il
//               recupero opt-in dopo 'catastrophic' è
//               runQuick({ …, force: true, params: { maxPasses: 1 } }):
//               passa comunque dalla tenuta entro il 15%.
//   onProgress  riceve { phase, pass?, worst?, noise? } e { bar } per la UI.
//               Fasi: preflight, noisy, held, pass, unstable, stalled,
//               resumed, verify, next, committed (la RAM è appena cambiata:
//               un calibEnd riuscito o una riparazione di calibBegin)
//   log         messaggi per il pannello log
//   params      override di QUICK_DEFAULTS
//   meta        { board, fw } per la sessione di telemetria
//   sampler     { waitForStable, measureOffset } già legati a source/clock:
//               solo per i test che vogliono sceneggiare le attese
//   repairStaleSession  false quando la pagina sospetta una sessione lasciata
//               aperta da lei stessa (vedi DS5.calibBegin): un avvio rifiutato
//               diventa un errore con needsPowerCycle invece di una
//               riparazione che committerebbe il parziale
//
// Non lancia: un errore HID diventa { outcome: 'error', error, committed,
// needsPowerCycle? }. `committed` è vero se la RAM del controller può essere
// cambiata (almeno un calibEnd riuscito, una riparazione di calibBegin che ha
// committato, o una sessione lasciata aperta da uno stallo). `needsPowerCycle`
// è vero quando il ciclo esce con una sessione aperta (stallo, oppure errore o
// scollegamento fra calibBegin e calibEnd).
export async function runQuick({
  controller,
  source,
  clock,
  isCurrent = () => true,
  isCancelled = () => false,
  force = false,
  onProgress = () => {},
  log = () => {},
  params = {},
  meta = {},
  sampler = null,
  repairStaleSession = true,
}) {
  const p = { ...QUICK_DEFAULTS, ...params };
  const waitForStable = sampler?.waitForStable ?? (opts => waitForStableFrom(source, clock, opts));
  const measureOffset = sampler?.measureOffset ?? ((ms, opts) => measureOffsetFrom(source, clock, ms, opts));
  const now = () => source?.now?.() ?? 0;
  const sessionStart = now();
  // Tempo da tenere libero dopo il campionamento: calibEnd, due misure di
  // verifica e la tenuta fra le due.
  const reserveMs = p.endDelayMs + p.verifyAttempts * p.verifyMs + p.holdTimeoutMs;
  const samplingDeadline = sessionStart + p.maxSessionMs - reserveMs;
  // Vero dal primo calibEnd riuscito (o da una riparazione di calibBegin che ha
  // committato): da lì la RAM del controller contiene una calibrazione nuova, e
  // un errore in una passata successiva non la annulla.
  let committedAny = false;
  // Vero fra un calibBegin riuscito e il calibEnd riuscito della stessa
  // passata. Se il ciclo esce in questo intervallo (errore HID, scollegamento)
  // la sessione resta aperta nel firmware come dopo uno stallo: il prossimo
  // calibBegin sarebbe rifiutato e la riparazione in DS5.calibBegin
  // committerebbe il parziale con meno di samplesPerPass campioni. Quindi
  // `needsPowerCycle`, come per 'stalled'.
  let sessionOpen = false;
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
  // Dopo ogni await: se il controller non è più quello di partenza, nessun
  // altro comando. Prima il ciclo leggeva il `ds5` globale e, dopo un replug a
  // metà passata, completava la passata sul controller NUOVO senza preflight.
  const ensureCurrent = () => {
    if (!isCurrent()) throw Object.assign(new Error('Controller disconnected'), { disconnected: true });
  };
  const blocked = () => {
    session.aborted = 'preflight';
    return { session, outcome: 'preflight', committed: false };
  };
  // Tenuta prima di una passata. Il messaggio "lascia gli stick" parte da un
  // timer solo come UI: la decisione resta sugli input report.
  const holdBeforePass = async pass => {
    let prompt = null;
    if (clock?.setTimeout) {
      prompt = clock.setTimeout(() => {
        prompt = null;
        onProgress({ phase: 'held', pass });
      }, p.holdPromptMs);
    }
    try {
      return await waitForStable({ spread: p.preflightSpread, holdMs: p.stableMs, timeoutMs: p.holdTimeoutMs, requireCentered: true });
    } finally {
      if (prompt !== null) clock.clearTimeout(prompt);
    }
  };
  try {
    onProgress({ phase: 'preflight' });
    const settled = await waitForStable({ spread: p.preflightSpread, holdMs: p.stableMs, timeoutMs: p.preflightTimeoutMs, requireCentered: true });
    if (!settled || !isCurrent()) return blocked();
    const before = await measureOffset(p.baselineMs, { requireCentered: true });
    if (!before || !isCurrent()) return blocked();
    session.before = summarizeResult(before);
    session.settled = true;
    // Punto di partenza, nella stessa scala delle passate: decideAfterPass ci
    // semina `bestWorst` (un plateau peggiore dell'inizio non è convergenza),
    // classifyOutcome lo usa per "peggiore dell'inizio".
    const beforeWorst = Math.max(before.left.offset, before.right.offset);
    const beforeNoise = Math.max(before.left.noise, before.right.noise);
    const stableEnough = r => (r.stableFraction ?? 1) >= DRIFT_MIN_STABLE
      || Math.max(r.left.noise, r.right.noise) <= p.verifyNoiseRatio * beforeNoise;
    if (beforeNoise >= p.noisyStartPct) {
      // Solo un invito: il gate adattivo non cambia per questo.
      onProgress({ phase: 'noisy', noise: beforeNoise });
      log(`Noisy readings at rest (${beforeNoise.toFixed(1)}%): release the sticks and keep the controller still.`);
    }
    // Già centrato: nessun comando. Una passata è irreversibile e, partendo dal
    // pavimento, può solo restare uguale o peggiorare.
    const start = decideBeforeStart({ beforeWorst }, p);
    if (start.skip && !force) {
      session.aborted = 'already-centered';
      log('Both sticks are already centered at the measurement limit: nothing sent to the controller.');
      return { session, outcome: 'already-centered', committed: false, worst: null, beforeWorst, bestWorst: null };
    }

    // Gate adattivo: `noise` è il p95 (in %) della deviazione dalla mediana.
    // Il fattore 2.5 è tarato sul max delle escursioni dei quattro assi su una
    // finestra di ~60 campioni (rapporto reale 2.2 medio, 2.56 al p95): non è
    // il "2× per asse singolo" che verrebbe da intuire, e abbassarlo a 2 fa
    // collassare il gate se il controller riporta a 1000 Hz invece di 250.
    //
    // L'avvio richiede una baseline vicina al centro e un gate riuscito.
    // Questo gate adattivo gestisce il rumore durante le passate successive;
    // non può aggirare la protezione assoluta prima di ogni calibBegin.
    let baseGate = Math.min(p.stableSpreadMax, Math.max(p.stableSpread, beforeNoise / 100 * p.gateNoiseFactor));
    if (baseGate > p.stableSpread)
      log(`Noisy signal: stability gate widened to ±${(baseGate * 100).toFixed(1)}%.`);
    let gateSpread = baseGate;
    let gateMax = baseGate;
    let gateOff = false;
    let gateWidenings = 0;
    const tol = p.refToleranceLsb * STICK_LSB;

    let worst = null;
    let prevWorst = null;
    let bestWorst = null;
    let bestPass = null;
    let extraUsed = 0;
    let result = null;
    // Ultima misura VERIFICATA: è ciò che la RAM del controller monta se il
    // ciclo si interrompe prima della passata successiva.
    let lastVerified = null;
    let stop = null; // esito che interrompe il ciclo prima della classificazione
    for (let pass = 1; pass <= p.maxPasses; pass++) {
      // Il gate si restringe verso la baseline a ogni passata: un disturbo
      // isolato nella passata 1 non deve lasciare tutte le successive con un
      // gate permissivo. Il decadimento (1.25) è deliberatamente più debole
      // dell'allargamento (1.6): fossero uguali, ogni passata ripartirebbe
      // esattamente dal valore che ha già fallito e ri-pagherebbe per intero
      // un timeout da 5 s per campione.
      // `gateOff` invece resta: si attiva solo dopo ripetuti fallimenti a gate
      // massimo e da lì il gate resta al massimo, per non ripagare i timeout.
      // Non significa più "campiona senza gate": un calibSample dopo un
      // timeout è un campione cieco, e poteva registrare una mano ferma.
      gateSpread = gateOff ? p.stableSpreadMax : Math.max(baseGate, gateSpread / p.gateDecay);

      // (1) Tenuta prima di OGNI passata, nel frame che lo stick riporta ora
      // (calibrato: nessuna sessione aperta). Blocca il pattern [100,100]:
      // una mano ferma sul bordo ha spread 0 ma è fuori dal raggio del 15%.
      // Per la passata 1 è la seconda tenuta del preflight di sempre.
      const held = await holdBeforePass(pass);
      // Passata 1: nessun comando è ancora partito, quindi resta l'esito
      // 'preflight' di sempre anche se il controller è sparito nel frattempo.
      if (pass === 1 && (!held || !isCurrent())) return blocked();
      ensureCurrent();
      if (!held) {
        session.aborted = 'moved';
        log(`Pass ${pass} not started: the sticks were not released. Nothing was sent.`);
        stop = 'moved';
        break;
      }

      // Tetto di durata: una passata nuova parte solo se c'è il tempo di
      // campionare fino al prompt di stallo. Altrimenti il risultato è quello
      // dell'ultima passata, come a budget di passate esaurito.
      if (pass > 1 && now() + p.stallMs > samplingDeadline) {
        log(`Time limit reached: no pass ${pass}.`);
        break;
      }

      const base = ((pass - 1) / p.maxPasses) * 100;
      onProgress({ phase: 'pass', pass });
      onProgress({ bar: base + 3 });

      // DS5.calibBegin ripara una sessione rimasta aperta con un calibEnd, che
      // committa: la RAM è cambiata anche se questa passata poi fallisce.
      const begun = await controller.calibBegin({ repair: repairStaleSession });
      sessionOpen = true;
      if (begun?.committed) {
        committedAny = true;
        onProgress({ phase: 'committed', pass });
      }
      ensureCurrent();
      // (2) Campioni in sessione. Riferimento = la prima finestra stabile presa
      // DOPO calibBegin; ogni campione richiede stabilità E centro entro
      // refToleranceLsb dal riferimento. Entrambe le letture sono in sessione:
      // mai un confronto con un punto preso prima di calibBegin.
      // (3) Stallo: nessun campione dopo un timeout. Se i campioni non
      // arrivano, prompt e poi abbandono della passata senza calibEnd.
      let ref = null;
      let taken = 0;
      const passStart = now();
      let giveUpAt = null;
      let promptShown = false;
      let stalled = false;
      while (taken < p.samplesPerPass) {
        if (isCancelled()) { stalled = true; break; }
        const t = now();
        if (giveUpAt === null && t - passStart >= p.stallMs) {
          giveUpAt = Math.min(t + p.stallGraceMs, samplingDeadline);
          session.stallPrompts = (session.stallPrompts ?? 0) + 1;
          promptShown = true;
          onProgress({ phase: 'stalled', pass });
          log(`Pass ${pass}: the sticks are not settling. Let go of both sticks, or cancel.`);
        }
        if (giveUpAt !== null && t >= giveUpAt) { stalled = true; break; }
        const limit = giveUpAt ?? passStart + p.stallMs;
        const timeoutMs = Math.max(p.stableMs, Math.min(p.stableTimeoutMs, limit - t));
        const stable = await waitForStable({ spread: gateSpread, holdMs: p.stableMs, timeoutMs, near: ref, tol, maxRadius: p.refRadius, isCancelled });
        ensureCurrent();
        if (!stable) {
          if (isCancelled()) { stalled = true; break; }
          // Segnale mai fermo (o lontano dal riferimento) entro il gate: NESSUN
          // campione. Si traccia l'evento e si allarga il gate una volta invece
          // di pagare il timeout su ogni campione successivo; mai oltre
          // DRIFT_MOVE_SPREAD.
          session.unstableEvents += 1;
          if (gateSpread < p.stableSpreadMax) {
            gateSpread = Math.min(p.stableSpreadMax, gateSpread * p.gateWiden);
            gateMax = Math.max(gateMax, gateSpread);
            gateWidenings += 1;
            log(`Gate widened to ±${(gateSpread * 100).toFixed(1)}% (signal moving on its own).`);
          } else if (!gateOff) {
            gateOff = true;
            log('Signal never stable even at the widest gate: waiting at the widest gate.');
          }
          onProgress({ phase: 'unstable', pass });
          // Dopo una ripresa, un nuovo blocco rimostra il prompt (e Cancel).
          if (giveUpAt !== null && !promptShown) {
            promptShown = true;
            onProgress({ phase: 'stalled', pass });
          }
          continue;
        }
        if (ref === null && typeof stable === 'object') ref = stable.center;
        if (promptShown) {
          promptShown = false;
          onProgress({ phase: 'resumed', pass });
        }
        await controller.calibSample();
        ensureCurrent();
        taken += 1;
        await clock.sleep(p.sampleSettleMs);
        ensureCurrent();
        onProgress({ bar: base + 3 + (taken / p.samplesPerPass) * 16 });
      }
      if (stalled) {
        // Un parziale sconosciuto non si committa mai: niente calibEnd con
        // meno di samplesPerPass campioni. La sessione resta aperta nel
        // firmware, quindi il controller va spento e riacceso prima di
        // qualunque altro comando.
        session.passes.push(null);
        session.aborted = 'stalled';
        // "Nulla è stato scritto" vale solo per QUESTA passata: un calibEnd di
        // una passata precedente (o la riparazione di calibBegin) ha già
        // cambiato la RAM, e il testo non deve dire il contrario.
        const earlier = committedAny
          ? 'this pass was not committed, but an earlier calibration step is active and unsaved'
          : 'nothing was committed';
        log(`Pass ${pass} abandoned after ${taken} of ${p.samplesPerPass} samples: ${earlier}. Turn the controller off before trying again.`);
        return { session, outcome: 'stalled', committed: true, needsPowerCycle: true, worst: null, beforeWorst, bestWorst, pass, committedBefore: committedAny };
      }
      await clock.sleep(p.endDelayMs);
      ensureCurrent();
      await controller.calibEnd();
      sessionOpen = false;
      committedAny = true;
      // Subito, non a fine ciclo: se la passata successiva si interrompe
      // (scollegamento, errore) la pagina deve già sapere che la RAM è cambiata.
      onProgress({ phase: 'committed', pass });
      ensureCurrent();

      // (4) Verifica nel frame calibrato (la sessione è chiusa): una misura
      // stabile e sotto il tetto. Se la prima non lo è (mano in movimento, o
      // ferma lontano dal centro), si attende la stessa tenuta entro il 15%
      // della fase (1) e si rimisura. Solo se lo stick resta oltre il tetto per
      // tutta l'attesa E la rimisura è stabile, il residuo è la calibrazione:
      // (5) 'catastrophic'. Una mano ferma sul bordo per più di holdTimeoutMs
      // durante la verifica viene quindi presa per una calibrazione rovinata:
      // l'errore è dalla parte sicura ("non salvare").
      onProgress({ phase: 'verify', pass });
      result = null;
      let implausible = null;
      for (let attempt = 1; attempt <= p.verifyAttempts && !result; attempt++) {
        let released = true;
        if (attempt > 1) {
          released = !!await holdBeforePass(pass);
          ensureCurrent();
        }
        const r = await measureOffset(p.verifyMs);
        ensureCurrent();
        if (r && !stableEnough(r))
          log(`Pass ${pass}: verification unsettled (noise ${Math.max(r.left.noise, r.right.noise).toFixed(1)}%, at rest ${beforeNoise.toFixed(1)}%).`);
        if (!r || !stableEnough(r)) continue;
        if (Math.max(r.left.offset, r.right.offset) < p.catastrophicPct) result = r;
        else if (!released) implausible = r;
      }
      onProgress({ bar: base + 100 / p.maxPasses });
      if (!result && implausible) {
        // (5) Tetto: fine del ciclo. Nessuna passata automatica di recupero:
        // il recupero è opt-in (force + maxPasses 1) e passa dalla tenuta (1).
        result = implausible;
        worst = Math.max(result.left.offset, result.right.offset);
        lastVerified = result;
        session.passes.push(+worst.toFixed(2));
        log(`Pass ${pass}: residual offset ${worst.toFixed(2)}%, beyond what Quick calibration can correct.`);
        stop = 'catastrophic';
        break;
      }
      if (!result) {
        // La calibrazione di QUESTA passata è già stata applicata da calibEnd,
        // ma non è stata verificata: non entra in bestWorst, non può
        // convergere, e la passata successiva parte solo dopo la tenuta (1).
        // `worst` torna null: il residuo precedente si riferisce a una
        // calibrazione che non è più sul controller.
        worst = null;
        prevWorst = null;
        lastVerified = null;
        session.passes.push(null);
        session.verifyFailures = (session.verifyFailures ?? 0) + 1;
        log(`Pass ${pass}: not enough stable samples to verify the result.`);
        if (pass < p.maxPasses) onProgress({ phase: 'next', pass, worst: null });
        continue;
      }
      worst = Math.max(result.left.offset, result.right.offset);
      lastVerified = result;
      session.passes.push(+worst.toFixed(2));
      // `otherWorst`: lo stick migliore. Se è già al pavimento, le passate
      // oltre la regola precedente sono limitate (rischiano di rovinarlo).
      const otherWorst = Math.min(result.left.offset, result.right.offset);
      const decision = decideAfterPass({ pass, worst, beforeWorst, prevWorst, bestWorst, bestPass, otherWorst, extraUsed }, p);
      ({ prevWorst, bestWorst, bestPass, extraUsed } = decision);
      log(`Pass ${pass}: residual offset ${worst.toFixed(2)}%`);
      if (decision.reason === 'target') break;
      if (decision.reason === 'catastrophic') {
        log(`Pass ${pass}: residual offset ${worst.toFixed(1)}% is not a released stick: stopping, no further passes.`);
        break;
      }
      if (decision.extra === 'recovery')
        log(`Pass ${pass} is worse than the starting point: one more pass to try to recover.`);
      if (decision.extra === 'plateau')
        log(`Pass ${pass} repeated the previous result: one more pass (plateau continuation).`);
      if (decision.regressed)
        log(`Pass ${pass} came out worse than the previous one: trying again instead of stopping.`);
      if (decision.reason === 'converged') {
        log('Converged: residual offset at the noise floor, further passes won’t help.');
        break;
      }
      if (decision.reason === 'floor-cap') {
        log('Still worse than the starting point, but the other stick is centered: stopping to avoid disturbing it.');
        break;
      }
      if (pass < p.maxPasses) onProgress({ phase: 'next', pass, worst });
    }

    // Se il ciclo si è fermato per una tenuta fallita, la RAM monta la
    // calibrazione dell'ultima passata verificata: quello è il risultato.
    if (stop === 'moved') {
      result = lastVerified;
      worst = lastVerified ? Math.max(lastVerified.left.offset, lastVerified.right.offset) : null;
    }
    session.after = worst === null ? null : summarizeResult(result);
    // `best` resta la migliore passata VERIFICATA, come nei dati già raccolti:
    // `bestWorst` ora parte dal punto di partenza, che sta già in `before`.
    const verified = session.passes.filter(v => v !== null);
    session.best = verified.length ? Math.min(...verified) : null;
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
    const outcome = stop ?? classifyOutcome({ worst, beforeWorst, bestWorst, maxNoise, unstableEvents: session.unstableEvents, passes: session.passes }, p);
    return { session, outcome, committed: true, worst, beforeWorst, bestWorst };
  } catch (error) {
    // La RAM del controller è cambiata se una passata precedente ha già chiuso
    // con calibEnd (un errore alla passata 2 non la annulla), oppure se la
    // riparazione di calibBegin ha committato prima che la calibrazione partisse.
    const committed = committedAny || error?.committed === true;
    // Sessione lasciata aperta (errore fra calibBegin e calibEnd, compreso un
    // calibEnd fallito): come uno stallo, il controller va spento prima di
    // qualunque altro comando. `committed` resta quello vero: aprire una
    // sessione non cambia la RAM.
    // Un avvio rifiutato senza riparazione (`openSession`, vedi
    // repairStaleSession) lascia la sessione di prima aperta: stesso blocco.
    const extra = sessionOpen || error?.openSession === true ? { needsPowerCycle: true } : {};
    // Un controller scollegato (o sostituito) non è un errore dell'algoritmo:
    // l'errore HID del cavo staccato arriva spesso prima dell'evento
    // `disconnect`, quindi si guarda anche isCurrent().
    if (error?.disconnected || !isCurrent()) {
      session.aborted = 'disconnected';
      return { session, outcome: 'disconnected', error, committed, ...extra };
    }
    session.aborted = 'error';
    session.err = String(error?.message || error).slice(0, 120);
    return { session, outcome: 'error', error, committed, ...extra };
  }
}

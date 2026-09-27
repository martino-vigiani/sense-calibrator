'use strict';

// Campionamento degli stick guidato dagli input report HID, con sorgente e
// orologio iniettati: nella pagina sono gli input report e i timer del browser,
// nel simulatore un DualSense virtuale e un orologio virtuale.
//
//   source = { subscribe(fn) → unsubscribe, sticks, now() }
//     `subscribe` notifica ogni nuovo input report; `sticks` è l'ultimo valore
//     letto ({ lx, ly, rx, ry }); `now()` è il tempo in ms (performance.now).
//     `reportTime` opzionale è il timestamp dell'ultimo evento HID.
//   clock = { sleep(ms), setTimeout(fn, ms), clearTimeout(id) }
//
// Mai campionare su un timer: i timer della pagina sono throttlati nelle tab in
// background, e un intervallo fisso sotto-campiona i ~250 Hz del controller
// duplicando campioni identici. I timer qui servono solo come guardie di
// timeout e come durata della finestra di misura.

import { analyzeDrift, extractStableSamples } from './measure.js';
import { createQuickCenterHold, sticksWithinQuickCenter } from '../quick-center-guard.js';

// Gating di stabilità: ogni calibSample viene inviato solo quando il segnale
// è rimasto entro QUICK_STABLE_SPREAD per QUICK_STABLE_MS. Così un tocco,
// una vibrazione o un cavo mosso non contaminano la media del firmware.
export const QUICK_STABLE_SPREAD = 0.035;  // più severo di DRIFT_MOVE_SPREAD
export const QUICK_STABLE_MS = 300;
export const QUICK_STABLE_TIMEOUT = 5000;

// 1 LSB del byte di report in unità normalizzate ([-1, 1]).
export const STICK_LSB = 1 / 127.5;
export const MAX_REPORT_GAP_MS = 100;
export const MAX_MEASURE_GAP_RETRIES = 2;
const sampleTime = source => Number.isFinite(source.reportTime) ? source.reportTime : source.now();

// Attende che tutti gli assi restino entro `spread` per `holdMs` consecutivi.
// Ritorna false se il segnale non si stabilizza entro `timeoutMs` (o se
// `isCancelled()` diventa vero); altrimenti un oggetto truthy `{ center }`, la
// media per asse della finestra accettata (non il punto medio min/max: su uno
// stick rumoroso quello oscilla di qualche LSB da una finestra all'altra).
// Guidato dagli input report HID, non da un timer: il gating resta preciso
// anche con i timer della pagina throttlati.
//
// `near` + `tol`: la finestra vale solo se il suo centro dista al più `tol`
// (per asse) da `near`. Serve al campionamento DENTRO una sessione di
// calibrazione: il riferimento è la prima finestra stabile presa dopo
// calibBegin, quindi il confronto avviene sempre nello stesso frame, qualunque
// cosa riportino gli input report a sessione aperta (H0, non ancora misurato).
// La sola stabilità non basta: una mano ferma sul bordo ha spread 0.
//
// `nearRadius`: come `near` + `tol`, ma radiale per stick (distanza euclidea
// del centro della finestra da `near`, stick sinistro e destro separati). Lo
// usa l'uscita esplicita del wizard (wizard-gate.js), dove il limite è largo e
// un limite per asse lascerebbe passare in diagonale √2 volte tanto.
//
// `maxRadius`: il centro della finestra, per stick, deve stare entro questo
// raggio. Non è un confronto tra frame: è un limite di plausibilità assoluto,
// largo abbastanza (vedi QUICK_DEFAULTS.refRadius) da contenere qualunque
// posizione di riposo in qualunque frame, e serve solo a non prendere come
// riferimento in sessione un pollice premuto sul bordo.
export function waitForStable(source, clock, { spread = QUICK_STABLE_SPREAD, holdMs = QUICK_STABLE_MS, timeoutMs = QUICK_STABLE_TIMEOUT, requireCentered = false, near = null, tol = 4 * STICK_LSB, nearRadius = null, maxRadius = null, isCancelled = null } = {}) {
  return new Promise(resolve => {
    const start = source.now();
    const win = [];
    let continuousStart = null;
    const centerHold = requireCentered ? createQuickCenterHold() : null;
    let unsubscribe = null;
    const done = ok => {
      unsubscribe();
      clock.clearTimeout(guard);
      resolve(ok);
    };
    const onSample = () => {
      if (isCancelled?.()) return done(false);
      const now = sampleTime(source);
      const sticks = source.sticks;
      // Un report vecchio non prolunga la tenuta: la finestra riparte dopo un
      // buco, anche quando il valore prima e dopo il buco è identico.
      if (win.length && now - win.at(-1).t > MAX_REPORT_GAP_MS) {
        win.length = 0;
        continuousStart = null;
      }
      if (continuousStart === null) continuousStart = now;
      const centered = centerHold ? centerHold(sticks, now) : true;
      win.push({ ...sticks, t: now });
      while (win.length && win[0].t < now - holdMs) win.shift();
      if (win.length >= 10) {
        let maxSpread = 0;
        const center = {};
        for (const a of ['lx', 'ly', 'rx', 'ry']) {
          let min = Infinity, max = -Infinity, sum = 0;
          for (const s of win) {
            if (s[a] < min) min = s[a];
            if (s[a] > max) max = s[a];
            sum += s[a];
          }
          maxSpread = Math.max(maxSpread, max - min);
          center[a] = sum / win.length;
        }
        const nearRef = !near || ['lx', 'ly', 'rx', 'ry'].every(a => Math.abs(center[a] - near[a]) <= tol);
        const withinRadius = !near || nearRadius === null
          || (Math.hypot(center.lx - near.lx, center.ly - near.ly) <= nearRadius
            && Math.hypot(center.rx - near.rx, center.ry - near.ry) <= nearRadius);
        const plausible = maxRadius === null
          || (Math.hypot(center.lx, center.ly) <= maxRadius && Math.hypot(center.rx, center.ry) <= maxRadius);
        if (centered && nearRef && withinRadius && plausible && maxSpread <= spread) {
          if (now - continuousStart >= holdMs) return done({ center });
        }
      }
      if (now - start >= timeoutMs) done(false);
    };
    unsubscribe = source.subscribe(onSample);
    // guardia per il caso "nessun input report" (controller muto)
    const guard = clock.setTimeout(() => done(false), timeoutMs + 250);
  });
}

// Misura dell'offset residuo (pre/post calibrazione), con lo stesso
// filtro di stabilità del test drift.
// Campiona sugli input report HID, non su un timer: un setInterval viene
// throttlato quando la tab va in background (la verifica restava senza dati
// e la passata di convergenza si interrompeva), e a 8 ms sotto-campionava i
// ~250 Hz del controller duplicando campioni identici — il che falsava sia la
// frazione di stabilità sia la durata reale di DRIFT_WINDOW.
//
// Il risultato porta `stableFraction` (frazione di campioni stabili, stesso
// criterio del test drift): la verifica di una passata la confronta con quella
// della baseline per distinguere una mano in movimento da uno stick che è
// rumoroso di suo.
export async function measureOffset(source, clock, ms = 1500, { requireCentered = false } = {}) {
  // Un singolo buco invalida solo la finestra corrente. Ogni tentativo ha
  // una durata e una sottoscrizione proprie: dopo il timeout non si legge né
  // si campiona più nulla. Il numero di nuove finestre è limitato.
  for (let attempt = 0; attempt <= MAX_MEASURE_GAP_RETRIES; attempt++) {
    const samples = [];
    const start = source.now();
    let firstReport = null;
    let lastReport = null;
    let stayedCentered = true;
    let gap = false;
    const onSample = () => {
      const now = sampleTime(source);
      if (lastReport !== null && now - lastReport > MAX_REPORT_GAP_MS) {
        gap = true;
        samples.length = 0;
        firstReport = null;
      }
      if (firstReport === null) firstReport = now;
      lastReport = now;
      const sticks = source.sticks;
      if (requireCentered && !sticksWithinQuickCenter(sticks)) stayedCentered = false;
      samples.push({ ...sticks });
    };
    const unsubscribe = source.subscribe(onSample);
    try {
      await clock.sleep(ms);
    } finally {
      unsubscribe();
    }
    if (gap) {
      if (attempt < MAX_MEASURE_GAP_RETRIES) continue;
      return null;
    }
    // I 40 report minimi da soli non provano la durata nominale della misura.
    if (samples.length < 40 || !stayedCentered || firstReport === null
      || lastReport - firstReport < ms - MAX_REPORT_GAP_MS
      || source.now() - lastReport > MAX_REPORT_GAP_MS
      || firstReport - start > MAX_REPORT_GAP_MS) return null;
    const { stable, fraction } = extractStableSamples(samples);
    const result = analyzeDrift(stable.length > 40 ? stable : samples);
    result.stableFraction = fraction;
    const all = analyzeDrift(samples);
    result.rawNoise = Math.max(all.left.noise, all.right.noise);
    return result;
  }
  return null;
}

// Sorgente minima basata su un Set di listener: la usano la pagina (alimentata
// da onInputReport) e il simulatore. `push` aggiorna gli stick e notifica.
export function createStickSource(now) {
  const listeners = new Set();
  const source = {
    sticks: { lx: 0, ly: 0, rx: 0, ry: 0 },
    reportTime: null,
    now,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    push(sticks, timestamp = now()) {
      source.sticks = sticks;
      source.reportTime = timestamp;
      for (const fn of listeners) fn();
    },
    get listenerCount() { return listeners.size; },
  };
  return source;
}

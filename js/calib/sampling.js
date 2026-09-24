'use strict';

// Campionamento degli stick guidato dagli input report HID, con sorgente e
// orologio iniettati: nella pagina sono gli input report e i timer del browser,
// nel simulatore un DualSense virtuale e un orologio virtuale.
//
//   source = { subscribe(fn) → unsubscribe, sticks, now() }
//     `subscribe` notifica ogni nuovo input report; `sticks` è l'ultimo valore
//     letto ({ lx, ly, rx, ry }); `now()` è il tempo in ms (performance.now).
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

// Attende che tutti gli assi restino entro `spread` per `holdMs` consecutivi.
// Ritorna false se il segnale non si stabilizza entro `timeoutMs`.
// Guidato dagli input report HID, non da un timer: il gating resta preciso
// anche con i timer della pagina throttlati.
export function waitForStable(source, clock, { spread = QUICK_STABLE_SPREAD, holdMs = QUICK_STABLE_MS, timeoutMs = QUICK_STABLE_TIMEOUT, requireCentered = false } = {}) {
  return new Promise(resolve => {
    const start = source.now();
    const win = [];
    const centerHold = requireCentered ? createQuickCenterHold() : null;
    let unsubscribe = null;
    const done = ok => {
      unsubscribe();
      clock.clearTimeout(guard);
      resolve(ok);
    };
    const onSample = () => {
      const now = source.now();
      const sticks = source.sticks;
      const centered = centerHold ? centerHold(sticks, now) : true;
      win.push({ ...sticks, t: now });
      while (win.length && win[0].t < now - holdMs) win.shift();
      if (win.length >= 10 && now - win[0].t >= holdMs * 0.8) {
        let maxSpread = 0;
        for (const a of ['lx', 'ly', 'rx', 'ry']) {
          let min = Infinity, max = -Infinity;
          for (const s of win) {
            if (s[a] < min) min = s[a];
            if (s[a] > max) max = s[a];
          }
          maxSpread = Math.max(maxSpread, max - min);
        }
        if (centered && maxSpread <= spread) return done(true);
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
export async function measureOffset(source, clock, ms = 1500, { requireCentered = false } = {}) {
  const samples = [];
  let stayedCentered = true;
  const onSample = () => {
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
  if (samples.length < 40 || !stayedCentered) return null;
  const { stable } = extractStableSamples(samples);
  return analyzeDrift(stable.length > 40 ? stable : samples);
}

// Sorgente minima basata su un Set di listener: la usano la pagina (alimentata
// da onInputReport) e il simulatore. `push` aggiorna gli stick e notifica.
export function createStickSource(now) {
  const listeners = new Set();
  const source = {
    sticks: { lx: 0, ly: 0, rx: 0, ry: 0 },
    now,
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    push(sticks) {
      source.sticks = sticks;
      for (const fn of listeners) fn();
    },
    get listenerCount() { return listeners.size; },
  };
  return source;
}

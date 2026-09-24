'use strict';

// Misura del drift: funzioni pure, senza DOM, timer né HID. Le usano la pagina
// (test drift, calibrazioni), il simulatore in ops/sim e i test.

import { CENTERED_MAX, MILD_MAX, formatOffset, tierFor } from './lattice.js';

// Soglie verdetto drift (% di deflessione massima a riposo). I valori vivono in
// lattice.js, dove sono anche i confini di GRID_TABLE: un solo numero per il
// verdetto, la regola di arresto e le etichette.
export const DRIFT_OK_MAX = CENTERED_MAX;
export const DRIFT_MILD_MAX = MILD_MAX;
export const DRIFT_TEST_MS = 3000;
export const DRIFT_SETTLE_SAMPLES = 60; // ~250 ms iniziali scartati (assestamento)
// Il drift è un offset (anche grande) ma stabile: per distinguerlo dal tocco
// dell'utente si guarda l'escursione del segnale in una finestra breve,
// mai il valore assoluto.
export const DRIFT_WINDOW = 30;        // campioni per finestra di stabilità (~120 ms)
export const DRIFT_MOVE_SPREAD = 0.08; // escursione oltre cui è movimento, non drift
export const DRIFT_MIN_STABLE = 0.4;   // frazione minima di campioni stabili
export const DRIFT_MAX_RETRIES = 2;

const AXES = ['lx', 'ly', 'rx', 'ry'];

// Input report 0x01 via USB: i primi quattro byte sono LX, LY, RX, RY.
// Il centro nominale è 127.5, quindi i byte 127/128 valgono ±0.0039 e nessuna
// misura può scendere sotto 0.555% (il pavimento del reticolo a 8 bit).
// Ritorna null per report che non portano gli stick.
export function parseSticks(reportId, data) {
  if (reportId !== 0x01 || data.byteLength < 4) return null;
  const n = v => (v - 127.5) / 127.5;
  return {
    lx: n(data.getUint8(0)),
    ly: n(data.getUint8(1)),
    rx: n(data.getUint8(2)),
    ry: n(data.getUint8(3)),
  };
}

export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Classifica ogni campione come stabile o in movimento guardando l'escursione
// (max-min per asse) nella finestra dei DRIFT_WINDOW campioni precedenti.
// Un drift fermo, anche enorme, è stabile; una mano sullo stick no.
export function extractStableSamples(samples) {
  const stable = [];
  for (let i = DRIFT_WINDOW; i < samples.length; i++) {
    let spread = 0;
    for (const a of AXES) {
      let min = Infinity, max = -Infinity;
      for (let j = i - DRIFT_WINDOW; j <= i; j++) {
        const v = samples[j][a];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      spread = Math.max(spread, max - min);
    }
    if (spread <= DRIFT_MOVE_SPREAD) stable.push(samples[i]);
  }
  const denom = samples.length - DRIFT_WINDOW;
  return { stable, fraction: denom > 0 ? stable.length / denom : 0 };
}

// Mediana per asse invece della media: un singolo sobbalzo o vibrazione
// del tavolo non sposta il risultato.
export function analyzeDrift(samples) {
  const med = key => median(samples.map(s => s[key]));
  const mlx = med('lx'), mly = med('ly'), mrx = med('rx'), mry = med('ry');
  const devs = (xk, yk, mx, my) => samples
    .map(s => Math.hypot(s[xk] - mx, s[yk] - my))
    .sort((a, b) => a - b);
  const p95 = arr => arr[Math.floor(arr.length * 0.95)];
  return {
    left: { offset: Math.hypot(mlx, mly) * 100, noise: p95(devs('lx', 'ly', mlx, mly)) * 100, x: mlx, y: mly },
    right: { offset: Math.hypot(mrx, mry) * 100, noise: p95(devs('rx', 'ry', mrx, mry)) * 100, x: mrx, y: mry },
  };
}

// Verdetto di uno stick attraverso GRID_TABLE: etichetta e classe vengono
// dalla tabella, la cifra da formatOffset. `tier` è l'id del livello, per chi
// deve scegliere una raccomandazione. Pinned e Moving non mostrano la
// percentuale: su un asse incollato o un segnale in movimento il numero
// sarebbe una misura falsa.
export function verdictFor(stick) {
  const tier = tierFor(stick);
  if (!tier) return { cls: 'v-bad', label: 'No reading', tier: null };
  const label = tier.showsOffset === false ? tier.badge : `${tier.badge} · ${formatOffset(stick.offset)}`;
  return { cls: tier.cls, label, tier: tier.id };
}

export function summarizeResult(r) {
  if (!r) return null;
  const f = v => +v.toFixed(3);
  return {
    off: [f(r.left.offset), f(r.right.offset)],
    noise: [f(r.left.noise), f(r.right.noise)],
    // Direzione del drift per asse. `off` è hypot(x, y), da cui x e y non sono
    // ricostruibili: senza questi, l'asimmetria per asse — la firma dell'usura
    // meccanica di un potenziometro — sarebbe persa per sempre.
    xy: [[f(r.left.x * 100), f(r.left.y * 100)], [f(r.right.x * 100), f(r.right.y * 100)]],
  };
}

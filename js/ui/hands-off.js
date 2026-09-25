'use strict';

// Misuratore di movimento per i modali Quick e Guided (e per il minigioco
// di WS8): verde, ambra o rosso a seconda di quanto si muovono gli stick
// negli ultimi HANDS_OFF_WINDOW_MS. Non sa se una mano tiene lo stick fermo:
// per questo la pagina può imporre il livello `held` (vedi HANDS_OFF_LABELS).
//
// Il nucleo è puro: riceve i campioni dagli input report HID (mai da timer o
// rAF, vedi CLAUDE.md) con il loro timestamp, e decide il livello. Il
// renderer è minimo e separato, così il test può guidare il nucleo con tocchi
// sceneggiati senza DOM.
//
// Le soglie sono quelle che l'algoritmo usa già, non numeri nuovi:
// - verde fino a QUICK_STABLE_SPREAD (0.035): il campionatore della rapida
//   accetta questa finestra come "ferma";
// - ambra fino a DRIFT_MOVE_SPREAD (0.08): ancora sotto la soglia oltre cui
//   la pagina dichiara "una mano sullo stick";
// - rosso oltre: movimento.
// Guarda solo lo spread, non la distanza dal centro: durante una sessione il
// frame dei report non è noto (H0), e una tenuta ferma sul bordo la segnala
// già il messaggio "Hold detected" di WS1.
import { DRIFT_MOVE_SPREAD } from '../calib/measure.js';
import { QUICK_STABLE_SPREAD } from '../calib/sampling.js';

export const HANDS_OFF_WINDOW_MS = 250;
export const HANDS_OFF_GREEN_MAX = QUICK_STABLE_SPREAD;
export const HANDS_OFF_AMBER_MAX = DRIFT_MOVE_SPREAD;
// Il rosso resta acceso almeno così dopo l'ultimo campione in movimento: un
// tocco breve lampeggerebbe per un solo frame, invisibile.
export const HANDS_OFF_RED_HOLD_MS = 600;
// Senza report da così tanto il livello è sconosciuto (controller muto).
export const HANDS_OFF_STALE_MS = 500;
// Campioni minimi nella finestra per giudicare (≈ 40 ms a 250 Hz).
export const HANDS_OFF_MIN_SAMPLES = 10;

const AXES = ['lx', 'ly', 'rx', 'ry'];

export function createHandsOffMeter({
  windowMs = HANDS_OFF_WINDOW_MS,
  greenMax = HANDS_OFF_GREEN_MAX,
  amberMax = HANDS_OFF_AMBER_MAX,
  redHoldMs = HANDS_OFF_RED_HOLD_MS,
  staleMs = HANDS_OFF_STALE_MS,
  minSamples = HANDS_OFF_MIN_SAMPLES,
} = {}) {
  let samples = [];
  let redUntil = -Infinity;
  let lastT = -Infinity;
  let spread = 0;

  const classify = t => {
    if (t < redUntil) return 'red';
    if (samples.length < minSamples) return 'unknown';
    if (spread > amberMax) return 'red';
    return spread > greenMax ? 'amber' : 'green';
  };

  return {
    // Un campione { lx, ly, rx, ry } (normalizzati -1..1) al tempo `t` (ms).
    // Ritorna il livello: 'unknown' | 'green' | 'amber' | 'red'.
    push(sticks, t) {
      lastT = t;
      samples.push({ t, lx: sticks.lx, ly: sticks.ly, rx: sticks.rx, ry: sticks.ry });
      const from = t - windowMs;
      let drop = 0;
      while (drop < samples.length && samples[drop].t < from) drop++;
      if (drop) samples = samples.slice(drop);
      spread = 0;
      for (const a of AXES) {
        let min = Infinity, max = -Infinity;
        for (const s of samples) {
          if (s[a] < min) min = s[a];
          if (s[a] > max) max = s[a];
        }
        if (max - min > spread) spread = max - min;
      }
      if (samples.length >= minSamples && spread > amberMax) redUntil = t + redHoldMs;
      return classify(t);
    },
    // Livello a un istante senza nuovi campioni (es. per rilevare il silenzio).
    level(t) {
      if (t - lastT > staleMs) return 'unknown';
      return classify(t);
    },
    get spread() { return spread; },
    reset() {
      samples = [];
      redUntil = -Infinity;
      lastT = -Infinity;
      spread = 0;
    },
  };
}

// Testo per livello. Il misuratore vede SOLO il movimento: un pollice che
// tiene lo stick fermo ha spread 0 ed è "verde". Quindi i testi descrivono il
// movimento ("Not moving"), mai "mani lontane" o "a riposo", che
// rassicurerebbero proprio durante l'abuso che il misuratore deve segnalare.
// Il livello `held` non viene dal misuratore: lo impone la pagina quando SA
// già di una tenuta (fasi held/stalled/unstable della rapida, preflight
// fallito, stick ancora sull'angolo o timeout del gate nel wizard). Due
// varianti: in Quick gli stick non vanno mai toccati; nel wizard si muovono di
// proposito, quindi il misuratore dice solo se si sono fermati.
export const HANDS_OFF_HELD = 'Stick held: let go';
export const HANDS_OFF_LABELS = Object.freeze({
  quick: Object.freeze({
    unknown: 'Waiting for the controller…',
    green: 'Not moving',
    amber: 'Moving a little: keep still',
    red: 'Moving: let go of the sticks',
    held: HANDS_OFF_HELD,
  }),
  guided: Object.freeze({
    unknown: 'Waiting for the controller…',
    green: 'Not moving',
    amber: 'Moving a little…',
    red: 'Moving',
    held: HANDS_OFF_HELD,
  }),
});

// Renderer minimo: `data-level` per il colore (CSS), testo per chi non vede il
// colore. Tocca il DOM solo quando il livello cambia.
export function renderHandsOff(el, level, labels = HANDS_OFF_LABELS.quick) {
  if (!el || el.dataset.level === level) return false;
  el.dataset.level = level;
  el.textContent = labels[level] ?? labels.unknown;
  return true;
}

'use strict';

// Copertura della calibrazione range: funzioni pure, senza DOM, timer né HID.
// La pagina le alimenta dagli input report HID (onInputReport) e rAF si limita
// a disegnare; i test e ops/sim le alimentano con traiettorie sintetiche.
//
// Perché dagli input report e non da rAF: a 60 Hz una rotazione veloce
// (0.3 s/giro) produce 18 campioni per giro, un settore sì e uno no su 36, e
// la copertura restava inchiodata a 0.50 anche con la corsa completa; in una
// tab in background rAF si ferma del tutto. In più ogni coppia di campioni
// consecutivi vicini (≤30°) riempie i settori attraversati con il raggio
// minimo della corda tra i due (stima prudente: non dichiara mai una corsa più
// lunga di quella vista), così la copertura non dipende dalla frequenza dei
// campioni.
//
// Unità: coordinate normalizzate [-1, 1] come `sticks` (y positivo = giù).

export const RANGE_DEFAULTS = Object.freeze({
  bins: 36,
  // Soglia assoluta minima di un settore "raggiunto" (0.75 · 0.8, come prima).
  okRadius: 0.6,
  // Un settore conta se arriva a questa frazione del massimo osservato.
  relThreshold: 0.88,
  // Quattro estremi cardinali non provano che sia stato percorso il bordo.
  minCoverage: 0.9,
  // Sotto questo raggio massimo lo stick non si è mosso: copertura 0, e
  // nessuna chiusura (nemmeno "Finish anyway") è ammessa.
  minExtent: 0.5,
  // Ogni direzione deve arrivare a questa frazione dell'escursione massima
  // dello stesso stick (prima 0.7: un lato corto del 30% passava per "raggiunto").
  dirFraction: 0.9,
  // Giri completi richiesti in totale, e corsa minima nel verso opposto
  // (in giri) perché il cambio di verso conti: l'istruzione a schermo chiede
  // "2 giri in un verso e 2 nell'altro", il gate ne pretende una parte.
  minTurns: 2,
  minReverseTurns: 0.5,
  // Il conteggio dei giri considera solo i campioni oltre questo raggio: al
  // centro l'angolo è rumore puro.
  trackRadius: 0.5,
  // Isteresi angolare: il verso cambia solo dopo 30° nel verso opposto, così
  // il rumore di uno stick fermo sul bordo non accumula giri né inversioni.
  hysteresis: Math.PI / 6,
  // Salto angolare oltre cui due campioni non sono contigui (buco nei report,
  // passaggio per il centro): si riancora senza contare la corsa.
  maxStep: (3 * Math.PI) / 4,
  // Riempimento dei settori tra due campioni: solo su archi brevi, dove il
  // tragitto reale non può aver tagliato l'angolo più di quanto dica la corda.
  fillMaxStep: Math.PI / 6,
  // Dopo quanto il gate incompleto offre "Finish anyway".
  unlockMs: 15000,
});

const TAU = 2 * Math.PI;
const wrap = a => {
  let d = (a + Math.PI) % TAU;
  if (d < 0) d += TAU;
  return d - Math.PI;
};

// Settore di un angolo atan2 (−π..π). Stessa convenzione del disegno in app.js.
function binOf(angle, bins) {
  return Math.floor(((angle + Math.PI) / TAU) * bins) % bins;
}

export function createStickRange(params = {}) {
  const p = { ...RANGE_DEFAULTS, ...params };
  return {
    p,
    bins: new Array(p.bins).fill(0),
    min: { x: 0, y: 0 },
    max: { x: 0, y: 0 },
    last: null,       // ultimo campione { angle, r }
    // conteggio giri con isteresi
    theta: null,      // angolo "srotolato" dell'ultimo campione valido
    dir: 0,           // +1 antiorario (angolo crescente), −1 orario, 0 ignoto
    extreme: null,    // angolo estremo raggiunto nel verso corrente
    anchor: null,     // punto di partenza quando il verso è ancora ignoto
    travel: { pos: 0, neg: 0 },
    reversals: 0,
  };
}

// Aggiorna lo stato di uno stick con un campione (x, y).
export function pushStick(s, x, y) {
  const { p } = s;
  if (x < s.min.x) s.min.x = x;
  if (x > s.max.x) s.max.x = x;
  if (y < s.min.y) s.min.y = y;
  if (y > s.max.y) s.max.y = y;

  const r = Math.hypot(x, y);
  const angle = Math.atan2(y, x);
  const bin = binOf(angle, p.bins);
  if (r > s.bins[bin]) s.bins[bin] = r;
  // Riempie i settori tra il campione precedente e questo (arco più corto),
  // con il punto della corda più vicino al centro: min(r1, r2)·cos(Δ/2).
  if (s.last && s.last.r > 0 && r > 0) {
    const delta = wrap(angle - s.last.angle);
    if (Math.abs(delta) <= p.fillMaxStep) {
      const rr = Math.min(r, s.last.r) * Math.cos(delta / 2);
      const from = binOf(s.last.angle, p.bins);
      const steps = Math.abs(binOf(angle, p.bins) - from);
      const n = Math.min(p.bins, Math.min(steps, p.bins - steps));
      const sign = delta >= 0 ? 1 : -1;
      for (let k = 1; k < n; k++) {
        const b = (((from + sign * k) % p.bins) + p.bins) % p.bins;
        if (rr > s.bins[b]) s.bins[b] = rr;
      }
    }
  }
  s.last = { angle, r };
  trackTurns(s, angle, r);
}

function trackTurns(s, angle, r) {
  const { p } = s;
  if (r < p.trackRadius) { s.theta = null; return; }
  if (s.theta === null) {
    // (ri)ingresso sul bordo: si riancora senza contare la corsa del salto
    s.theta = angle;
    if (s.dir === 0) s.anchor = angle; else s.extreme = angle;
    return;
  }
  const delta = wrap(angle - s.theta);
  if (Math.abs(delta) > p.maxStep) {
    s.theta = angle;
    if (s.dir === 0) s.anchor = angle; else s.extreme = angle;
    return;
  }
  const theta = s.theta + delta;
  s.theta = theta;
  if (s.dir === 0) {
    const moved = theta - s.anchor;
    if (Math.abs(moved) >= p.hysteresis) {
      s.dir = moved > 0 ? 1 : -1;
      s.travel[s.dir > 0 ? 'pos' : 'neg'] += Math.abs(moved);
      s.extreme = theta;
    }
    return;
  }
  const ahead = (theta - s.extreme) * s.dir;
  if (ahead > 0) {
    s.travel[s.dir > 0 ? 'pos' : 'neg'] += ahead;
    s.extreme = theta;
  } else if (-ahead >= p.hysteresis) {
    // inversione confermata: la corsa di ritorno conta nel verso nuovo
    s.dir = -s.dir;
    s.reversals += 1;
    s.travel[s.dir > 0 ? 'pos' : 'neg'] += -ahead;
    s.extreme = theta;
  }
}

// Massimo raggio visto, limitato a 1: con un range memorizzato troppo stretto
// gli assi saturano a ±1 e le diagonali arrivano fino a √2; senza il limite il
// massimo gonfiato alzava la soglia e i settori cardinali non contavano mai
// (copertura 0.33 con un range 1.4× troppo stretto).
export function stickCoverage(s) {
  const globalMax = Math.max(...s.bins);
  if (globalMax < s.p.minExtent) return 0;
  const g = Math.min(1, globalMax);
  const thr = Math.max(s.p.okRadius, g * s.p.relThreshold);
  return s.bins.filter(v => v >= thr).length / s.p.bins;
}

// Escursione per direzione (valori positivi) e massima dello stick.
export function stickExtents(s) {
  const dirs = { left: -s.min.x, right: s.max.x, up: -s.min.y, down: s.max.y };
  const maxAbs = Math.max(...Object.values(dirs));
  return { dirs, maxAbs };
}

export function stickStatus(s) {
  const { p } = s;
  const { dirs, maxAbs } = stickExtents(s);
  const moved = maxAbs >= p.minExtent;
  const need = Math.max(p.minExtent, maxAbs * p.dirFraction);
  const missingDirs = Object.entries(dirs).filter(([, v]) => !moved || v < need).map(([k]) => k);
  // Sotto minExtent in una direzione il range memorizzato sarebbe degenere:
  // nemmeno "Finish anyway" lo accetta.
  const shortDirs = Object.entries(dirs).filter(([, v]) => v < p.minExtent).map(([k]) => k);
  const turns = (s.travel.pos + s.travel.neg) / TAU;
  const reverseTurns = Math.min(s.travel.pos, s.travel.neg) / TAU;
  const reversed = s.reversals > 0 && reverseTurns >= p.minReverseTurns;
  const enoughTurns = turns >= p.minTurns;
  const coverage = stickCoverage(s);
  return {
    coverage,
    dirs,
    maxAbs,
    missingDirs,
    shortDirs,
    turns,
    reverseTurns,
    reversed,
    enoughTurns,
    complete: moved && missingDirs.length === 0 && enoughTurns && reversed && coverage >= p.minCoverage,
  };
}

// Tracker dei due stick per una sessione range.
export function createRangeTracker(params = {}) {
  const left = createStickRange(params);
  const right = createStickRange(params);
  return {
    left,
    right,
    params: left.p,
    push(sticks) {
      pushStick(left, sticks.lx, sticks.ly);
      pushStick(right, sticks.rx, sticks.ry);
    },
  };
}

const DIR_NAMES = { left: 'left', right: 'right', up: 'up', down: 'down' };

// Stato complessivo per la UI e per la decisione di chiusura.
//   complete     → "Done" (range valido)
//   canFinish    → "Finish anyway" ammesso (dopo unlockMs, e solo se ogni
//                  direzione di ogni stick supera minExtent)
//   missing      → elenco leggibile di ciò che manca ("L left", "R: 1 more turn"),
//                  a traguardi: cambia solo quando una direzione è raggiunta,
//                  un giro intero è completato o il verso è stato invertito
export function rangeStatus(tracker, elapsedMs = 0) {
  const L = stickStatus(tracker.left);
  const R = stickStatus(tracker.right);
  const complete = L.complete && R.complete;
  const missing = [];
  const missingDirs = [];
  for (const [tag, st] of [['L', L], ['R', R]]) {
    if (st.coverage < tracker.params.minCoverage) missing.push(`${tag}: cover more of the edge`);
    for (const d of st.missingDirs) missingDirs.push(`${tag} ${DIR_NAMES[d]}`);
  }
  missing.push(...missingDirs);
  for (const [tag, st] of [['L', L], ['R', R]]) {
    if (!st.enoughTurns) {
      // Giri interi, non decimi: il testo finisce in #range-hint (role=status)
      // e cambia solo quando un giro è completato. Con i decimi cambiava a ogni
      // tick da 120 ms mentre si ruota, e il lettore di schermo accodava decine
      // di conteggi già superati.
      const left = Math.max(1, Math.ceil(tracker.params.minTurns - st.turns - 1e-9));
      missing.push(`${tag}: ${left} more ${left > 1 ? 'turns' : 'turn'}`);
    }
    if (!st.reversed) missing.push(`${tag}: turn the other way too`);
  }
  const degenerate = L.shortDirs.length > 0 || R.shortDirs.length > 0;
  const unlocked = elapsedMs >= tracker.params.unlockMs;
  return {
    left: L,
    right: R,
    coverage: Math.min(L.coverage, R.coverage),
    complete,
    missing,
    missingDirs,
    degenerate,
    canFinish: complete || (unlocked && !degenerate),
    finishAnyway: !complete && unlocked && !degenerate,
  };
}

// Verifica dopo rangeEnd: errore di circolarità RMS sui settori, con il nuovo
// range già applicato. Per ogni settore il raggio massimo raggiunto; l'errore
// è la distanza da 1.0 (il bordo del nuovo range). Un DualSense sano sta
// intorno al 7–10%: il cancello fisico non è un cerchio perfetto.
// null finché qualche settore non è stato raggiunto (raggio < minExtent).
export function circularityRms(s) {
  if (s.bins.some(v => v < s.p.minExtent)) return null;
  const mean = s.bins.reduce((a, v) => a + (v - 1) ** 2, 0) / s.bins.length;
  return Math.sqrt(mean) * 100;
}

export const CIRCULARITY_NORMAL = Object.freeze({ min: 7, max: 10 });

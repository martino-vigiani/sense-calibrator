'use strict';

// Il reticolo a 8 bit degli stick e la tabella unica dei livelli.
//
// Ogni asse arriva come byte 0..255 con centro nominale 127.5, che non è
// rappresentabile: il miglior stick possibile legge 127 o 128 su entrambi gli
// assi, cioè hypot(0.5, 0.5)/127.5 = 0.555%. Un asse spostato di un solo LSB
// legge 1.240%. Tutte le misure reali (telemetria, test drift, passate) cadono
// su questo reticolo: una soglia come DRIFT_OK_MAX=1.2 non è "quasi centrato",
// è "0 LSB di errore".
//
// GRID_TABLE è l'unica fonte di verità per etichette, classi di esito,
// punteggio Center del minigioco e chiave di raccomandazione. Chi mostra un
// offset (badge del test drift, pannello esito, minigioco) passa da qui, così
// la regola di arresto, l'etichetta e il punteggio non possono divergere.
// Nessun DOM, nessun HID: lo importano pagina, simulatore e test.

// Questo modulo non importa nulla: measure.js prende da qui DRIFT_OK_MAX e
// DRIFT_MILD_MAX (CENTERED_MAX e MILD_MAX), così le soglie del verdetto e i confini della tabella sono
// lo stesso numero e non può nascere un import circolare.

// Confine del livello "centrato" = KPI v1 e bersaglio di arresto della rapida.
export const CENTERED_MAX = 1.2;
// Confine tra drift lieve e marcato.
export const MILD_MAX = 3.5;

// Un passo del reticolo per asse, in punti percentuali (1/127.5).
export const LSB_PCT = 100 / 127.5;
// Pavimento: entrambi gli assi a mezzo LSB dal centro (byte 127/128).
export const FLOOR_PCT = Math.hypot(0.5, 0.5) * LSB_PCT;
// Primo gradino: un asse a 1 LSB oltre il pavimento, l'altro al pavimento.
export const ONE_STEP_PCT = Math.hypot(1.5, 0.5) * LSB_PCT;
// Tetto del livello "entro 1 passo". Sta nel vuoto tra 1.240 e il gradino
// successivo (1.664), quindi è robusto all'arrotondamento a 3 decimali della
// telemetria; il KPI v1 (<1.2) resta separato e invariato.
export const WITHIN_ONE_STEP_MAX = 1.25;
// Oltre questo offset la calibrazione rapida non è un rimedio plausibile:
// coincide con il raggio di preflight (quick-center-guard, 15%).
export const GUIDED_ONLY_MIN = 15;
// Tolleranza della decodifica: la telemetria arrotonda a 3 decimali.
export const DECODE_TOLERANCE = 0.0006;

// Soglie dei livelli sovrapposti all'offset.
// Pinned: un asse incollato al bordo (mediana ≥0.99) con rumore sotto 1 LSB.
// Non è drift: è un potenziometro o un contatto guasto, o la calibrazione di
// range persa; un numero percentuale qui sarebbe fuorviante.
export const PINNED_AXIS_MIN = 0.99;
export const PINNED_NOISE_MAX = LSB_PCT;

// Punteggio Center del minigioco: ancore sul reticolo, interpolate
// linearmente tra loro (0.555→100, 1.24→90, poi 3.5→60 e 8→0).
export const CENTER_SCORE_ANCHORS = Object.freeze([
  Object.freeze([FLOOR_PCT, 100]),
  Object.freeze([ONE_STEP_PCT, 90]),
  Object.freeze([MILD_MAX, 60]),
  Object.freeze([8, 0]),
]);

// Livelli per offset, in ordine crescente. `max` è il limite superiore,
// `inclusive` dice se il limite appartiene al livello. `outcome` è la classe
// di esito condivisa con quick-policy (WS2) e con il pannello esito (WS5);
// `recommendation` è una chiave, il testo lo sceglie la UI.
// `centered` resta strettamente <CENTERED_MAX: è il KPI v1 e il bersaglio di
// arresto, e non va alzato (vedi piano §3). "Entro 1 passo" è solo un'etichetta
// e una seconda metrica.
export const GRID_TABLE = Object.freeze([
  Object.freeze({
    id: 'centered',
    max: CENTERED_MAX,
    inclusive: false,
    label: 'Centered (measurement limit)',
    badge: 'Centered',
    cls: 'v-ok',
    outcome: 'centered',
    centerScore: 100,
    recommendation: null,
  }),
  Object.freeze({
    id: 'within-1-step',
    max: WITHIN_ONE_STEP_MAX,
    inclusive: true,
    label: 'Within 1 step (fine to save)',
    badge: 'Within 1 step',
    cls: 'v-ok',
    outcome: 'within-1-step',
    centerScore: 90,
    recommendation: null,
  }),
  // Mild resta strettamente <MILD_MAX come il verdetto di oggi; sul
  // reticolo il limite cade tra 3.373 e 3.551, quindi < o ≤ non cambia nulla.
  Object.freeze({
    id: 'mild',
    max: MILD_MAX,
    inclusive: false,
    label: 'Mild drift',
    badge: 'Mild drift',
    cls: 'v-mild',
    outcome: 'residual',
    centerScore: null,
    recommendation: 'quick',
  }),
  Object.freeze({
    id: 'marked',
    max: GUIDED_ONLY_MIN,
    inclusive: false,
    label: 'Marked drift',
    badge: 'Marked drift',
    cls: 'v-bad',
    outcome: 'residual',
    centerScore: null,
    recommendation: 'quick-then-guided',
  }),
  // ≥15%: fuori dal raggio in cui la rapida può partire; a fine sessione è il
  // tetto catastrofico di WS1.
  Object.freeze({
    id: 'guided-only',
    max: Infinity,
    inclusive: true,
    label: 'Guided only',
    badge: 'Severe drift',
    cls: 'v-bad',
    outcome: 'catastrophic',
    centerScore: 0,
    recommendation: 'guided',
  }),
]);

// Livelli che scavalcano l'offset. Moving prima di Pinned: se il segnale si
// muove non ha senso nemmeno dire che è incollato.
export const TIER_OVERRIDES = Object.freeze({
  moving: Object.freeze({
    id: 'moving',
    label: 'Moving (no stable reading)',
    badge: 'Moving',
    cls: 'v-bad',
    outcome: 'unstable',
    centerScore: null,
    recommendation: 'worn-sensor',
    showsOffset: false,
  }),
  pinned: Object.freeze({
    id: 'pinned',
    label: 'Pinned at the edge',
    badge: 'Pinned',
    cls: 'v-bad',
    outcome: 'pinned',
    centerScore: 0,
    recommendation: 'range-then-guided',
    showsOffset: false,
  }),
});

const inTier = (row, off) => (row.inclusive ? off <= row.max : off < row.max);

// Livello del solo offset (%), senza sovrapposizioni. Un valore non finito o
// negativo non è una misura: null.
export function tierForOffset(off) {
  if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) return null;
  return GRID_TABLE.find(row => inTier(row, off));
}

// Livello di uno stick misurato: { offset, noise?, x?, y?, unstable? }, con
// x/y normalizzati (-1..1) come in analyzeDrift e noise in %.
export function tierFor(stick) {
  if (!stick) return null;
  if (stick.unstable === true) return TIER_OVERRIDES.moving;
  if (isPinned(stick)) return TIER_OVERRIDES.pinned;
  return tierForOffset(stick.offset);
}

export function isPinned({ x, y, noise } = {}) {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof noise !== 'number') return false;
  return Math.max(Math.abs(x), Math.abs(y)) >= PINNED_AXIS_MIN && noise < PINNED_NOISE_MAX;
}

export function isWithinOneStep(off) {
  return typeof off === 'number' && Number.isFinite(off) && off <= WITHIN_ONE_STEP_MAX;
}

// Passi di un singolo asse oltre il pavimento: 0 per i byte 127/128, 1 per
// 126/129, e così via. `v` è il valore normalizzato (-1..1) di parseSticks o
// analyzeDrift. Una mediana a mezzo byte (possibile solo con un numero pari di
// campioni divisi a metà) conta come pavimento.
export function stepsFromAxis(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.round(Math.abs(v) * 127.5 - 0.5));
}

// Scompone un offset radiale (%) nei passi per asse: off = hypot(a+0.5, b+0.5)
// · LSB_PCT con a ≥ b ≥ 0 interi. Ritorna { a, b, ambiguous, candidates,
// error } o null se il valore non cade sul reticolo (dati sintetici, mediane a
// mezzo byte). Alcuni raggi hanno più scomposizioni (es. 5²+5² = 7²+1²): si
// preferisce quella su un solo asse, perché dopo una calibrazione il residuo
// reale sta sempre su un asse (F5), e si marca `ambiguous`.
export function decodeOff(off, tolerance = DECODE_TOLERANCE) {
  if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) return null;
  // In unità di mezzo LSB: u = 2a+1, v = 2b+1 dispari, hypot(u, v) = off·2.55.
  // hypot(u, v) ≥ u: oltre uMax nessuna coppia può rientrare nella tolleranza.
  const uMax = ((off + tolerance) / LSB_PCT) * 2;
  const candidates = [];
  let error = Infinity;
  for (let u = 1; u <= 255 && u <= uMax; u += 2) {
    for (let v = 1; v <= u; v += 2) {
      const e = Math.abs(Math.hypot(u, v) / 2 * LSB_PCT - off);
      if (e <= tolerance) {
        candidates.push({ a: (u - 1) / 2, b: (v - 1) / 2 });
        error = Math.min(error, e);
      }
    }
  }
  if (candidates.length === 0) return null;
  const preferred = candidates.find(c => c.b === 0) ?? candidates[0];
  return {
    a: preferred.a,
    b: preferred.b,
    ambiguous: candidates.length > 1,
    candidates,
    error,
  };
}

// Classe di forma per i conteggi del report: 'single-axis' (pavimento incluso),
// 'two-axis', 'ambiguous' (esiste sia una lettura su un asse sia su due) o
// 'off-lattice'.
export function axisShape(off) {
  const d = decodeOff(off);
  if (!d) return 'off-lattice';
  const single = d.candidates.some(c => c.b === 0);
  const both = d.candidates.some(c => c.b > 0);
  if (single && both) return 'ambiguous';
  return single ? 'single-axis' : 'two-axis';
}

// Un solo formattatore per ogni superficie: "0.6% · at floor",
// "1.2% · 1 step", "2.0% · 2 steps", "1.7% · 1+1 steps". Oltre il livello
// Marked e fuori reticolo mostra solo la percentuale: contare i passi a 40%
// non aiuta nessuno.
export function formatOffset(off) {
  if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) return '—';
  const pct = `${off.toFixed(1)}%`;
  if (off >= GUIDED_ONLY_MIN) return pct;
  const d = decodeOff(off);
  if (!d) return pct;
  if (d.a === 0 && d.b === 0) return `${pct} · at floor`;
  if (d.b === 0) return `${pct} · ${d.a} ${d.a === 1 ? 'step' : 'steps'}`;
  return `${pct} · ${d.a}+${d.b} steps`;
}

// Punteggio Center (0..100) per l'offset di uno stick: 100 al pavimento, 90 a
// un passo, poi lineare verso 60 a MILD_MAX e 0 a 8%.
export function centerScoreFor(off) {
  if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) return null;
  const A = CENTER_SCORE_ANCHORS;
  if (off <= A[0][0]) return A[0][1];
  for (let i = 1; i < A.length; i++) {
    const [x1, y1] = A[i];
    if (off <= x1) {
      const [x0, y0] = A[i - 1];
      return Math.round(y0 + (y1 - y0) * (off - x0) / (x1 - x0));
    }
  }
  return A[A.length - 1][1];
}

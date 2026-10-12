'use strict';

// Gate del wizard guidato (centro a 4 angoli): regole pure più un'attesa
// guidata dagli input report, senza DOM né HID. La pagina decide cosa mostrare
// e quando inviare calibSample; qui si decide SE un campione è ammesso.
//
// Prima il wizard campionava 150 ms dopo il click, senza alcun controllo: un
// pollice ancora sullo stick (una mano sul controller, l'altra sul mouse)
// finiva nella media del firmware. È il percorso degli offset oltre il 15%,
// cioè dei casi più difficili, e aveva meno protezione di Quick.
//
// Regole per ogni campione:
//   1. l'angolo richiesto è stato raggiunto: dall'ultimo campione, in almeno
//      un report ciascuno stick ha toccato cornerDot verso l'angolo con
//      entrambi gli assi oltre cornerAxisMin;
//   2. gli stick sono fermi (spread ≤ gate per holdMs, entro timeoutMs) E il
//      centro della finestra è entro max(4 LSB, 3·rumore) dal punto di riposo
//      di riferimento;
//   3. su timeout non si campiona MAI. Nessun rilassamento automatico: dopo
//      `escapeAfter` timeout la pagina offre un'uscita esplicita (con
//      conferma, registrata in locale) che allarga il controllo di posizione
//      a un raggio fisso di `escapeLsb` dal riferimento (per stick) e porta
//      il gate di spread a DRIFT_MOVE_SPREAD, senza superarlo.
//
// L'uscita serve a uno stick che striscia (qualche decina di LSB dopo ogni
// angolo), non a togliere ogni protezione: senza limite di posizione un
// pollice fermo sull'angolo veniva campionato e portava lo stick oltre il 15%.
// Il raggio dell'uscita contiene lo strisciamento osservato (~20 LSB) e resta
// ben sotto un angolo o un pollice appoggiato (oltre ~19% della corsa); non
// cresce con i timeout e non si allarga da solo.
//
// Frame del riferimento: il punto di riposo è la prima finestra stabile presa
// DOPO calibBegin, come in Quick (WS1). Il piano indicava `wizard.before.xy`,
// ma quella misura è presa prima di calibBegin, nel frame calibrato, mentre i
// campioni sono letti a sessione aperta (frame non ancora misurato, H0). Per
// uno stick oltre il 15% — il pubblico del wizard — i due frame possono
// differire ben oltre 4 LSB e ogni campione andrebbe in timeout. Il
// riferimento resta fisso per tutta la procedura e non si allarga mai da solo.

import { DRIFT_MIN_STABLE, DRIFT_MOVE_SPREAD } from './measure.js';
import { QUICK_STABLE_SPREAD, STICK_LSB, waitForStable } from './sampling.js';
import { CENTERED_MAX, FLOOR_PCT, formatOffset } from './lattice.js';

export const WIZARD_DEFAULTS = Object.freeze({
  spread: QUICK_STABLE_SPREAD,
  // Uscita esplicita: gate largo quanto la soglia del "movimento", mai oltre.
  escapeSpread: DRIFT_MOVE_SPREAD,
  // Uscita esplicita: raggio fisso (LSB, per stick) dal riferimento in
  // sessione. 24 LSB ≈ 18.8% della corsa: largo per uno stick che striscia
  // (~20 LSB), stretto per un pollice sull'angolo o sul bordo.
  escapeLsb: 24,
  holdMs: 300,
  timeoutMs: 5000,
  tolLsb: 4,
  noiseMult: 3,
  // Tetto della tolleranza (per asse, unità normalizzate): DRIFT_MOVE_SPREAD,
  // cioè 8% ≈ 10.2 LSB. Il controllo di posizione non accetta mai uno
  // spostamento più grande di quello che l'app stessa chiama "movimento"; in
  // diagonale (per asse, quindi √2 · 8% ≈ 11.3%) resta sotto il raggio
  // dell'uscita (escapeLsb, 18.8%), così l'uscita resta sempre il controllo
  // più largo. Senza tetto un tocco nella misura di partenza portava la
  // tolleranza a ~81 LSB e un pollice fermo al 57% dal riferimento passava.
  maxTol: DRIFT_MOVE_SPREAD,
  // Misura di partenza disturbata (rifiutata PRIMA di calibBegin): rumore p95
  // radiale oltre metà di DRIFT_MOVE_SPREAD (4%: attorno alla mediana, un
  // segnale largo quanto la soglia del movimento; è anche lo 0 della
  // Stability del test di precisione), o frazione stabile sotto
  // DRIFT_MIN_STABLE (la regola con cui il test drift dice "in movimento").
  // L'attesa prima della misura chiede già una finestra entro
  // QUICK_STABLE_SPREAD, quindi uno stick che la supera non viene escluso da
  // questa soglia: la supera solo un tocco nel secondo di misura.
  beforeMaxNoise: (DRIFT_MOVE_SPREAD * 100) / 2,
  beforeMinStable: DRIFT_MIN_STABLE,
  // Il riferimento in sessione deve avere entrambi gli stick entro il 50%
  // (plausibilità, come QUICK_DEFAULTS.refRadius): un pollice sul bordo non
  // diventa il "centro".
  refRadius: 0.5,
  // Proiezione minima verso l'angolo (frazione della corsa) per dire che
  // l'utente ci è arrivato.
  cornerDot: 0.6,
  // Minimo per asse verso l'angolo. La sola proiezione diagonale accettava uno
  // stick spinto su un asse soltanto (X=−0,85, Y=0 "raggiunge" l'angolo in alto
  // a sinistra): quell'asse non veniva mai esercitato, e la telemetria v2 mostra
  // Guided che lascia fuori pavimento assi che prima erano buoni. Con un gate
  // circolare l'angolo pieno vale ~0,71 per asse; 0,35 chiede un movimento
  // vero su entrambi senza pretendere precisione dall'utente.
  cornerAxisMin: 0.35,
  // Timeout (sull'intera procedura) prima di offrire l'uscita esplicita.
  escapeAfter: 2,
  // Variazione (punti %) oltre cui il confronto prima/dopo parla di
  // peggioramento: la stessa scala di "worse than start" della rapida.
  worseEps: 0.8,
});

export const wizardParams = params => ({ ...WIZARD_DEFAULTS, ...params });

// Tolleranza (per asse, unità normalizzate) del punto di riposo: max(4 LSB,
// 3·rumore), mai oltre `maxTol`. Il rumore è il p95 radiale in punti % della
// misura di partenza, il più alto dei due stick (waitForStable accetta una sola
// tolleranza). Il rumore non dipende dal frame, quindi usarlo qui non
// confronta frame diversi. Il tetto vale anche se la misura di partenza non è
// stata controllata con `checkBefore`: è la seconda linea di difesa.
export function restTolerance(before, params = {}) {
  const p = wizardParams(params);
  const noisePct = Math.max(0, ...(before?.noise ?? []).filter(Number.isFinite));
  return Math.min(p.maxTol, Math.max(p.tolLsb * STICK_LSB, (p.noiseMult * noisePct) / 100));
}

// La misura di partenza (measureOffset, prima di calibBegin) è pulita?
// Accetta il risultato grezzo ({ left: { noise }, right: { noise },
// stableFraction }) o quello di summarizeResult ({ noise: [l, r] }, senza
// frazione stabile). → { ok: true } | { ok: false, reason }
//   'no-data'  nessuna misura (troppi pochi report)
//   'moving'   frazione stabile sotto beforeMinStable
//   'noisy'    rumore oltre beforeMaxNoise su almeno uno stick
// Un rifiuto qui non ha mandato nulla al controller: la pagina chiede di
// lasciare gli stick e di ripartire.
export function checkBefore(result, params = {}) {
  const p = wizardParams(params);
  if (!result) return { ok: false, reason: 'no-data' };
  const noise = Array.isArray(result.noise) ? result.noise : [result.left?.noise, result.right?.noise];
  if (noise.length < 2 || !noise.every(Number.isFinite)) return { ok: false, reason: 'no-data' };
  if (Number.isFinite(result.stableFraction) && result.stableFraction < p.beforeMinStable) return { ok: false, reason: 'moving' };
  if (Math.max(...noise) > p.beforeMaxNoise) return { ok: false, reason: 'noisy' };
  return { ok: true };
}

// Proiezione di ciascuno stick sulla direzione dell'angolo (tx, ty qualsiasi,
// normalizzati qui). 1 = corsa piena verso l'angolo.
export function cornerProjection(sticks, corner) {
  const n = Math.hypot(corner.tx, corner.ty) || 1;
  const ux = corner.tx / n, uy = corner.ty / n;
  return {
    left: sticks.lx * ux + sticks.ly * uy,
    right: sticks.rx * ux + sticks.ry * uy,
  };
}

// Componenti di ciascuno stick lungo gli assi dell'angolo (segno dell'angolo
// applicato): 1 = asse a fondo corsa nella direzione giusta.
export function cornerAxes(sticks, corner) {
  const sx = Math.sign(corner.tx) || 1, sy = Math.sign(corner.ty) || 1;
  return {
    left: { x: sticks.lx * sx, y: sticks.ly * sy },
    right: { x: sticks.rx * sx, y: sticks.ry * sy },
  };
}

// Traccia, dall'ultimo reset, il massimo della proiezione e il massimo di
// ciascun asse verso l'angolo (alimentato dagli input report, non da rAF: un
// passaggio rapido all'angolo tra due frame non va perso). Un angolo è
// raggiunto quando, in un singolo report, la proiezione supera `cornerDot` E
// entrambi gli assi superano `cornerAxisMin`: i massimi separati non bastano,
// perché X a fondo e poi Y a fondo in due momenti non sono un angolo.
export function createCornerTracker(corner, params = {}) {
  const p = wizardParams(params);
  const fresh = () => ({ left: -Infinity, right: -Infinity });
  const t = {
    corner,
    best: fresh(),
    reached: { left: false, right: false },
    // Il meglio visto per asse, per dire all'utente QUALE asse manca.
    bestAxis: { left: { x: -Infinity, y: -Infinity }, right: { x: -Infinity, y: -Infinity } },
    push(sticks) {
      const proj = cornerProjection(sticks, t.corner);
      const axes = cornerAxes(sticks, t.corner);
      for (const side of ['left', 'right']) {
        if (proj[side] > t.best[side]) t.best[side] = proj[side];
        const a = axes[side];
        if (a.x > t.bestAxis[side].x) t.bestAxis[side].x = a.x;
        if (a.y > t.bestAxis[side].y) t.bestAxis[side].y = a.y;
        if (proj[side] >= p.cornerDot && a.x >= p.cornerAxisMin && a.y >= p.cornerAxisMin) t.reached[side] = true;
      }
    },
    reset(nextCorner = t.corner) {
      t.corner = nextCorner;
      t.best = fresh();
      t.reached = { left: false, right: false };
      t.bestAxis = { left: { x: -Infinity, y: -Infinity }, right: { x: -Infinity, y: -Infinity } };
    },
    // Stick che non hanno ancora raggiunto l'angolo: [] = entrambi ok.
    missing() {
      return ['left', 'right'].filter(side => !t.reached[side]);
    },
    // Per ogni stick mancante, l'asse (o gli assi) rimasti corti: 'x', 'y' o
    // entrambi. Serve solo al testo per l'utente.
    missingAxes() {
      return t.missing().map(side => {
        const b = t.bestAxis[side];
        const axes = [];
        if (!(b.x >= p.cornerAxisMin)) axes.push('x');
        if (!(b.y >= p.cornerAxisMin)) axes.push('y');
        return { side, axes };
      });
    },
  };
  return t;
}

// Opzioni di waitForStable per un campione. Con l'uscita esplicita (escaped)
// il controllo di posizione non cade: diventa un raggio fisso di escapeLsb dal
// riferimento (mai meno della tolleranza normale), e il gate sale a
// escapeSpread. Serve comunque una finestra stabile: mai un campione su timeout.
export function sampleGateOptions({ ref, tol, escaped = false, params = {}, isCancelled = null } = {}) {
  const p = wizardParams(params);
  // Il tetto vale anche per una `tol` passata a mano: nessun chiamante può
  // allargare il controllo normale oltre maxTol, né l'uscita oltre escapeLsb.
  const capped = Math.min(p.maxTol, Number.isFinite(tol) ? tol : p.tolLsb * STICK_LSB);
  const escapeRadius = Math.max(p.escapeLsb * STICK_LSB, capped);
  return {
    spread: escaped ? p.escapeSpread : p.spread,
    holdMs: p.holdMs,
    timeoutMs: p.timeoutMs,
    near: ref,
    tol: escaped ? escapeRadius : capped,
    nearRadius: escaped ? escapeRadius : null,
    isCancelled,
  };
}

// Diagnosi di un'attesa scaduta, SOLO per il testo mostrato all'utente: non
// decide mai un campione e non allarga nulla. Telemetria v2 (27 set–12 ott):
// il 25% delle sessioni Guided finiva `disconnected`, e 33 su 81 al passo 0
// con uno stick oltre il 37% (31 con un asse a fondo scala): il riferimento in
// sessione chiede entrambi gli stick entro refRadius, quindi Continue (e
// l'uscita, che non tocca quel limite) non potevano mai riuscire, e l'unica
// uscita era staccare il cavo. Dire PERCHÉ l'attesa è scaduta permette alla
// pagina di non proporre un'uscita inutile e di indicare Stop.
//
// `watchRestWindow` osserva gli stessi input report dell'attesa e tiene gli
// ultimi holdMs; `stop()` restituisce { center, spread, n } o null (meno di 10
// report: nessun dato).
export function watchRestWindow(source, holdMs = WIZARD_DEFAULTS.holdMs) {
  const win = [];
  const unsubscribe = source.subscribe(() => {
    const t = Number.isFinite(source.reportTime) ? source.reportTime : source.now();
    win.push({ ...source.sticks, t });
    while (win.length && win[0].t < t - holdMs) win.shift();
  });
  return {
    stop() {
      unsubscribe();
      return summarizeRestWindow(win);
    },
  };
}

export function summarizeRestWindow(win) {
  if (!Array.isArray(win) || win.length < 10) return null;
  const center = {};
  let spread = 0;
  for (const a of ['lx', 'ly', 'rx', 'ry']) {
    let min = Infinity, max = -Infinity, sum = 0;
    for (const s of win) {
      if (s[a] < min) min = s[a];
      if (s[a] > max) max = s[a];
      sum += s[a];
    }
    spread = Math.max(spread, max - min);
    center[a] = sum / win.length;
  }
  return { center, spread, n: win.length };
}

// → { why: 'no-data' | 'moving' | 'far', radius: [l, r], dist: [l, r] | null,
//     far: ['left'|'right'] }
//   radius: distanza (unità normalizzate) del centro della finestra dal
//           centro del frame in sessione, per stick;
//   dist:   distanza dal riferimento `ref`, per stick (null senza `ref`);
//   far:    gli stick fuori dal limite che l'attesa applicava (maxRadius per
//           il riferimento; la tolleranza o nearRadius per un campione).
// 'moving' quando la finestra supera lo spread del gate: uno stick toccato o
// che non si ferma. 'far' quando è ferma ma fuori dal limite: un pollice
// fermo sullo stick e uno stick bloccato al bordo si vedono uguali, e il testo
// della pagina lo dice.
export function diagnoseRestTimeout(summary, { spread, ref = null, tol = null, nearRadius = null, maxRadius = null } = {}) {
  if (!summary) return { why: 'no-data', radius: null, dist: null, far: [] };
  const c = summary.center;
  const radius = [Math.hypot(c.lx, c.ly), Math.hypot(c.rx, c.ry)];
  const dist = ref ? [Math.hypot(c.lx - ref.lx, c.ly - ref.ly), Math.hypot(c.rx - ref.rx, c.ry - ref.ry)] : null;
  const keys = [['lx', 'ly'], ['rx', 'ry']];
  const far = ['left', 'right'].filter((side, i) => {
    if (maxRadius !== null && radius[i] > maxRadius) return true;
    if (!ref) return false;
    if (nearRadius !== null) return dist[i] > nearRadius;
    return tol !== null && keys[i].some(a => Math.abs(c[a] - ref[a]) > tol);
  });
  if (Number.isFinite(spread) && summary.spread > spread) return { why: 'moving', radius, dist, far };
  return { why: far.length ? 'far' : 'moving', radius, dist, far };
}

// Attesa del riferimento in sessione (subito dopo calibBegin): finestra
// stabile con entrambi gli stick entro refRadius. Ritorna il centro o null.
// Con l'uscita esplicita il gate di spread è escapeSpread, ma il riferimento
// serve comunque: è il centro del raggio dell'uscita.
export async function captureRestReference(source, clock, opts = {}) {
  return (await captureRestReferenceDetailed(source, clock, opts)).center;
}

// Come captureRestReference, con la diagnosi del timeout:
// → { center } | { center: null, diagnosis }
export async function captureRestReferenceDetailed(source, clock, { escaped = false, params = {}, isCancelled = null } = {}) {
  const p = wizardParams(params);
  const spread = escaped ? p.escapeSpread : p.spread;
  const probe = watchRestWindow(source, p.holdMs);
  let stable, summary;
  try {
    stable = await waitForStable(source, clock, {
      spread, holdMs: p.holdMs, timeoutMs: p.timeoutMs, maxRadius: p.refRadius, isCancelled,
    });
  } finally {
    summary = probe.stop();
  }
  if (stable && typeof stable === 'object') return { center: stable.center };
  return { center: null, diagnosis: diagnoseRestTimeout(summary, { spread, maxRadius: p.refRadius }) };
}

// Decide se il campione di questo passo può partire.
//   → { ok: true, center }            campione ammesso
//   → { ok: false, reason: 'corner', missing: ['left'|'right'] }
//                                      l'angolo non è stato raggiunto: nessuna attesa
//   → { ok: false, reason: 'timeout', diagnosis? } stick non fermi o lontani
//                                      dal riposo (diagnosis: diagnoseRestTimeout,
//                                      solo per il testo)
//   → { ok: false, reason: 'cancelled' }
// Senza riferimento non si campiona mai (nemmeno con l'uscita): il controllo
// di posizione non ha un centro.
export async function gateWizardSample(source, clock, { tracker, ref, tol, escaped = false, params = {}, isCancelled = null } = {}) {
  const p = wizardParams(params);
  if (!ref) return { ok: false, reason: 'timeout' };
  if (tracker) {
    const missing = tracker.missing();
    if (missing.length) return { ok: false, reason: 'corner', missing, axes: tracker.missingAxes?.() ?? [] };
  }
  const opts = sampleGateOptions({ ref, tol, escaped, params, isCancelled });
  const probe = watchRestWindow(source, opts.holdMs);
  let stable, summary;
  try {
    stable = await waitForStable(source, clock, opts);
  } finally {
    summary = probe.stop();
  }
  if (isCancelled?.()) return { ok: false, reason: 'cancelled' };
  if (!stable) {
    return { ok: false, reason: 'timeout',
      diagnosis: diagnoseRestTimeout(summary, { spread: opts.spread, ref, tol: opts.tol, nearRadius: opts.nearRadius }) };
  }
  return { ok: true, center: stable.center };
}

// Confronto prima/dopo per stick (entrambe le misure nel frame calibrato: la
// prima prima di calibBegin, la seconda dopo calibEnd). Alimenta il pannello
// dell'esito (WS5) e il messaggio finale del wizard.
export function wizardComparison(before, after, params = {}) {
  const p = wizardParams(params);
  const b = before?.off ?? null;
  const a = after?.off ?? null;
  const sticks = ['Left', 'Right'].map((name, i) => {
    const bo = Array.isArray(b) && Number.isFinite(b[i]) ? b[i] : null;
    const ao = Array.isArray(a) && Number.isFinite(a[i]) ? a[i] : null;
    return {
      name,
      before: bo,
      after: ao,
      beforeLabel: bo === null ? '—' : formatOffset(bo),
      afterLabel: ao === null ? '—' : formatOffset(ao),
      delta: bo !== null && ao !== null ? ao - bo : null,
    };
  });
  const worst = xs => (xs.every(v => v !== null) ? Math.max(...xs) : null);
  const beforeWorst = worst(sticks.map(s => s.before));
  const afterWorst = worst(sticks.map(s => s.after));
  const measured = beforeWorst !== null && afterWorst !== null;
  return {
    sticks,
    beforeWorst,
    afterWorst,
    measured,
    worse: measured && afterWorst - beforeWorst > p.worseEps,
    stickWorse: sticks.filter(s => s.after !== null && s.after > FLOOR_PCT + 0.01 && s.delta > p.worseEps),
    centered: afterWorst !== null && afterWorst < CENTERED_MAX,
    axisWorse: axisWorsening(before, after, params),
  };
}

// Assi che si sono allontanati dal centro di più di `worseEps` punti, anche
// quando il raggio dello stick migliora: X da 3% a 0,6% e Y da 0,6% a 2,8%
// danno un raggio quasi uguale e nasconderebbero un asse peggiorato.
// → [{ stick: 'Left'|'Right', axis: 'X'|'Y', before, after }] (valori in %).
export function axisWorsening(before, after, params = {}) {
  const p = wizardParams(params);
  const b = before?.xy, a = after?.xy;
  if (!Array.isArray(b) || !Array.isArray(a)) return [];
  const out = [];
  ['Left', 'Right'].forEach((stick, i) => {
    ['X', 'Y'].forEach((axis, j) => {
      const bv = b[i]?.[j], av = a[i]?.[j];
      if (!Number.isFinite(bv) || !Number.isFinite(av)) return;
      // La mediana di un asse può essere 0 fra i byte 127 e 128: un asse
      // ancora entro il pavimento del reticolo non è peggiorato davvero.
      if (Math.abs(av) > FLOOR_PCT + 0.01 && Math.abs(av) - Math.abs(bv) > p.worseEps)
        out.push({ stick, axis, before: bv, after: av });
    });
  });
  return out;
}

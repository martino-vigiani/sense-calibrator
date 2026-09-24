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
//   1. l'angolo richiesto è stato raggiunto: dall'ultimo campione, la
//      proiezione di ciascuno stick verso l'angolo ha toccato cornerDot;
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

import { DRIFT_MOVE_SPREAD } from './measure.js';
import { QUICK_STABLE_SPREAD, STICK_LSB, waitForStable } from './sampling.js';
import { CENTERED_MAX, formatOffset } from './lattice.js';

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
  // Il riferimento in sessione deve avere entrambi gli stick entro il 50%
  // (plausibilità, come QUICK_DEFAULTS.refRadius): un pollice sul bordo non
  // diventa il "centro".
  refRadius: 0.5,
  // Proiezione minima verso l'angolo (frazione della corsa) per dire che
  // l'utente ci è arrivato.
  cornerDot: 0.6,
  // Timeout (sull'intera procedura) prima di offrire l'uscita esplicita.
  escapeAfter: 2,
  // Variazione (punti %) oltre cui il confronto prima/dopo parla di
  // peggioramento: la stessa scala di "worse than start" della rapida.
  worseEps: 0.8,
});

export const wizardParams = params => ({ ...WIZARD_DEFAULTS, ...params });

// Tolleranza (per asse, unità normalizzate) del punto di riposo: max(4 LSB,
// 3·rumore). Il rumore è il p95 radiale in punti % della misura di partenza,
// il più alto dei due stick (waitForStable accetta una sola tolleranza). Il
// rumore non dipende dal frame, quindi usarlo qui non confronta frame diversi.
export function restTolerance(before, params = {}) {
  const p = wizardParams(params);
  const noisePct = Math.max(0, ...(before?.noise ?? []).filter(Number.isFinite));
  return Math.max(p.tolLsb * STICK_LSB, (p.noiseMult * noisePct) / 100);
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

// Traccia il massimo della proiezione dall'ultimo reset (alimentato dagli
// input report, non da rAF: un passaggio rapido all'angolo tra due frame
// non va perso).
export function createCornerTracker(corner) {
  const t = {
    corner,
    best: { left: -Infinity, right: -Infinity },
    push(sticks) {
      const p = cornerProjection(sticks, t.corner);
      if (p.left > t.best.left) t.best.left = p.left;
      if (p.right > t.best.right) t.best.right = p.right;
    },
    reset(nextCorner = t.corner) {
      t.corner = nextCorner;
      t.best = { left: -Infinity, right: -Infinity };
    },
    // Stick che non hanno ancora raggiunto l'angolo: [] = entrambi ok.
    missing(minDot = WIZARD_DEFAULTS.cornerDot) {
      const out = [];
      if (!(t.best.left >= minDot)) out.push('left');
      if (!(t.best.right >= minDot)) out.push('right');
      return out;
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
  const escapeRadius = Math.max(p.escapeLsb * STICK_LSB, tol ?? 0);
  return {
    spread: escaped ? p.escapeSpread : p.spread,
    holdMs: p.holdMs,
    timeoutMs: p.timeoutMs,
    near: ref,
    tol: escaped ? escapeRadius : tol,
    nearRadius: escaped ? escapeRadius : null,
    isCancelled,
  };
}

// Attesa del riferimento in sessione (subito dopo calibBegin): finestra
// stabile con entrambi gli stick entro refRadius. Ritorna il centro o null.
// Con l'uscita esplicita il gate di spread è escapeSpread, ma il riferimento
// serve comunque: è il centro del raggio dell'uscita.
export async function captureRestReference(source, clock, { escaped = false, params = {}, isCancelled = null } = {}) {
  const p = wizardParams(params);
  const stable = await waitForStable(source, clock, {
    spread: escaped ? p.escapeSpread : p.spread, holdMs: p.holdMs, timeoutMs: p.timeoutMs, maxRadius: p.refRadius, isCancelled,
  });
  return stable && typeof stable === 'object' ? stable.center : null;
}

// Decide se il campione di questo passo può partire.
//   → { ok: true, center }            campione ammesso
//   → { ok: false, reason: 'corner', missing: ['left'|'right'] }
//                                      l'angolo non è stato raggiunto: nessuna attesa
//   → { ok: false, reason: 'timeout' } stick non fermi o lontani dal riposo
//   → { ok: false, reason: 'cancelled' }
// Senza riferimento non si campiona mai (nemmeno con l'uscita): il controllo
// di posizione non ha un centro.
export async function gateWizardSample(source, clock, { tracker, ref, tol, escaped = false, params = {}, isCancelled = null } = {}) {
  const p = wizardParams(params);
  if (!ref) return { ok: false, reason: 'timeout' };
  if (tracker) {
    const missing = tracker.missing(p.cornerDot);
    if (missing.length) return { ok: false, reason: 'corner', missing };
  }
  const stable = await waitForStable(source, clock, sampleGateOptions({ ref, tol, escaped, params, isCancelled }));
  if (isCancelled?.()) return { ok: false, reason: 'cancelled' };
  if (!stable) return { ok: false, reason: 'timeout' };
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
    centered: afterWorst !== null && afterWorst < CENTERED_MAX,
  };
}

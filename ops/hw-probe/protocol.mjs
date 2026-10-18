'use strict';

// Il protocollo R1 (docs/hw-probe-protocol.md) come codice senza DOM: la pagina
// ops/hw-probe/index.html lo guida con i pulsanti, i test lo fanno girare contro
// il firmware finto di ops/sim/fake-dualsense.mjs sull'orologio virtuale.
//
// Ogni risultato ottenuto contro il finto è "model-verified": dice che il probe
// registra e valuta correttamente le ipotesi del modello, non che il DualSense
// si comporti così. Solo la sessione di Martino su un controller di riserva
// risponde alle domande.
//
// Campionamento: sempre guidato dagli input report HID (waitForStable e la
// finestra di misura sono gli stessi di js/calib/sampling.js). I timer servono
// solo come durata della finestra e come guardia.

import { reportTimeOf, waitForStable } from '../../js/calib/sampling.js';
import { createLandingDetector } from '../../js/calib/landing.js';
import {
  CENTER_AXES, CENTER_INDEXES, MODULE_FIELDS, RANGE_INDEXES,
  centersOf, diffValues, readModuleCal, sameValues, writeModuleCal,
} from './module-cal.mjs';
import {
  MAX_CENTER_DELTA, POSSIBLY_PERMANENT_STEPS, checkFixWrite, checkWriteValues, createArming, arm, fixFitRefusal, isArmed, writeRefusal,
} from './safety.mjs';

// /2: i passi R1-X (docs/hw-probe-bdm040.md) e le medie delle finestre di ogni
// campione nelle passate.
export const PROBE_SCHEMA = 'sense-hw-probe/2';

export const PROBE_DEFAULTS = {
  measureMs: 1500,       // finestra di misura dell'uscita (report 0x01)
  holdTimeoutMs: 15000,  // mani ferme prima di ogni comando
  sampleTimeoutMs: 5000, // attesa di una finestra stabile per ogni calibSample
  settleMs: 150,         // come quick.js tra l'ultimo campione e calibEnd
  writeSettleMs: 100,    // dopo [12,1], prima di rileggere o misurare
  readRepeats: 3,        // H-a
  slopeStep: 64,         // H-e, unità a 16 bit per gradino
  slopeMaxOut: 8,        // H-e, LSB: oltre, niente gradini più ampi su quell'asse
  abReps: 3,             // A/B, ripetizioni per braccio
  abSamples: [12, 4],    // A/B, campioni per passata nei due bracci
  // R1-X (docs/hw-probe-bdm040.md)
  idleMs: 300000,        // X-idle, mani lontane per 5 minuti
  releaseFlicks: 3,      // X-release, rilasci per direzione
  flickTimeoutMs: 10000, // attesa di un punto fermo e poi dell'arrivo, per ogni rilascio
  xPasses: 5,            // X-pass
  fixWaitMs: 60000,      // X-fix, attesa a stick fermo prima della seconda misura
  fixFlicks: 8,          // X-fix, rilasci dopo la correzione
};

const LSB = 127.5;
// 15% di deflessione in LSB: il tetto di Quick (catastrofico) e del guard.
export const CEILING_LSB = 0.15 * LSB;

// Le 8 direzioni di X-release, nel frame del report (y positivo = giù).
// L'opposta di una direzione è quella 4 posti più avanti.
const D = Math.SQRT1_2;
export const RELEASE_DIRECTIONS = [
  { name: 'right', v: [1, 0] }, { name: 'down-right', v: [D, D] }, { name: 'down', v: [0, 1] }, { name: 'down-left', v: [-D, D] },
  { name: 'left', v: [-1, 0] }, { name: 'up-left', v: [-D, -D] }, { name: 'up', v: [0, -1] }, { name: 'up-right', v: [D, -D] },
];

// Uscita a riposo in LSB rispetto a 127.5 (lo zero ideale non rappresentabile),
// media per asse sulla finestra: la media di molti report recupera un po' di
// risoluzione sotto l'LSB quando il rumore fa oscillare il byte.
export function measureOutput(source, clock, ms) {
  const xs = { lx: [], ly: [], rx: [], ry: [] };
  const unsubscribe = source.subscribe(() => {
    for (const a of CENTER_AXES) xs[a].push(source.sticks[a] * 127.5);
  });
  return clock.sleep(ms).then(() => {
    unsubscribe();
    const n = xs.lx.length;
    if (n < 40) return null;
    const mean = {}, sd = {};
    for (const a of CENTER_AXES) {
      const m = xs[a].reduce((s, v) => s + v, 0) / n;
      mean[a] = round4(m);
      sd[a] = round4(Math.sqrt(xs[a].reduce((s, v) => s + (v - m) ** 2, 0) / n));
    }
    return { n, mean, sd };
  });
}

const round4 = v => Math.round(v * 1e4) / 1e4;
const round2 = v => Math.round(v * 100) / 100;
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const toLsb = c => Object.fromEntries(CENTER_AXES.map(a => [a, round2(c[a] * LSB)]));
const outDelta = (a, b) => (a && b ? Object.fromEntries(CENTER_AXES.map(k => [k, round4(b.mean[k] - a.mean[k])])) : null);

class StepAbort extends Error {
  constructor(reason, data = {}) { super(reason); this.name = 'StepAbort'; this.data = data; }
}

// hostname: location.hostname nella pagina.
// clock: { sleep, setTimeout, clearTimeout } (il browser o l'orologio virtuale).
// confirm(step, text) → Promise<boolean>: conferma esplicita per ogni passo che
//   scrive. Nessuna conferma = nessuna scrittura.
// prompt({ step, direction, index, n, total, text } | null): mostra a chi tiene
//   il controller in che direzione spingere lo stick sinistro e lasciarlo
//   (X-release, X-fix); null toglie l'indicazione. I test lo usano per muovere
//   lo stick del finto.
export function createProbe({ hostname, clock, confirm, prompt = async () => {}, log = () => {}, now = () => Date.now(), params = {} }) {
  const P = { ...PROBE_DEFAULTS, ...params };
  const record = {
    schema: PROBE_SCHEMA,
    startedAt: new Date(now()).toISOString(),
    controller: null,
    connections: [],
    baseline: null,
    preCycle: null,
    steps: [],
  };
  // Stato per connessione, fuori dal record: l'identità (seriale) resta in
  // memoria e non entra mai nel JSON esportato.
  //
  // L'identità della prima connessione si fissa una volta sola e non si
  // riassegna mai: se la prima connessione non ha un seriale, nessuna
  // connessione successiva può diventare "la prima" al suo posto.
  let conn = null;
  // La connessione precedente, per X-replug (stessa identità, RAM uguale?).
  let prev = null;
  let firstIdentity = null;
  // Identità della connessione che ha scritto record.baseline (può non essere
  // la prima, se la prima si è fermata al preflight).
  let baselineIdentity = null;
  let preCycleIdentity = null;

  function attach({ ds5, source, info = {}, identity = null }) {
    const id = record.connections.length + 1;
    prev = conn;
    conn = { id, ds5, source, identity: knownIdentity(identity) ? identity : null, arming: createArming(id), nv: null, baseline: null, baselineOut: null, snapshots: [], lastOut: null, needsPowerCycle: false };
    if (id === 1) firstIdentity = conn.identity;
    record.controller ??= { board: info.board ?? null, fwversion: info.fwversion ?? null, buildDate: info.buildDate ?? null };
    // true/false solo quando entrambi i seriali sono noti; null = sconosciuto.
    const sameController = id === 1 ? true : sameIdentity(conn.identity, firstIdentity);
    record.connections.push({ id, at: new Date(now()).toISOString(), sameController, nv: null });
    log(`Connection ${id}: disarmed. Run the preflight read first.`);
    return id;
  }

  function armWith(opts) {
    if (!conn) return false;
    return arm(conn.arming, opts);
  }

  const armed = () => !!conn && isArmed(conn.arming, conn.id);

  // centered: false solo per X-fix, che misura proprio un'uscita che può stare
  // oltre il 15% (fino ai 24 LSB della sua regola): resta la finestra ferma.
  function hold(what, { centered = true } = {}) {
    return waitForStable(conn.source, clock, { requireCentered: centered, timeoutMs: P.holdTimeoutMs }).then(ok => {
      if (!ok) throw new StepAbort(`hands-off hold failed before ${what}: release both sticks and retry`);
      return ok;
    });
  }

  async function read(what) {
    const r = await readModuleCal(conn.ds5);
    if (!r) throw new StepAbort(`[12,2] reply failed validation (${what})`);
    conn.snapshots.push(r.values);
    return r;
  }

  // L'ultima uscita misurata resta sulla connessione: X-replug la confronta.
  async function measure() {
    const c = conn;
    const out = await measureOutput(c.source, clock, P.measureMs);
    if (out) c.lastOut = out;
    return out;
  }

  // La baseline del diario appartiene a questo controller? Sì se l'ha letta
  // questa stessa connessione, oppure se entrambi i seriali sono noti e
  // uguali. Un seriale mancante non prova nulla: senza prova si usa solo ciò
  // che questa connessione ha letto, così il probe non scrive mai su un
  // controller i bordi del range di un altro.
  function baselineIsThisController() {
    if (!record.baseline) return false;
    if (record.baseline.connection === conn.id) return true;
    return sameIdentity(conn.identity, baselineIdentity) === true;
  }

  // Valori ammessi per [12,1]: letture di questa connessione, più la baseline
  // del diario solo se è provato che viene da questo controller (restauro dopo
  // una riconnessione).
  function allowedSnapshots() {
    const snaps = [...conn.snapshots];
    if (baselineIsThisController()) snaps.push(record.baseline.values);
    return snaps;
  }

  // ask: false solo per ricontrollare (NVS, armamento, sessione) fra le
  // passate di un passo già confermato.
  async function guardWrite(step, { ask = true } = {}) {
    // Lo stato NVS si rilegge adesso: quello della connessione può essere vecchio.
    const nv = await conn.ds5.queryNvStatus();
    const reasons = writeRefusal({
      step, hostname, arming: conn.arming, connectionId: conn.id, nv: { status: nv.status },
      baseline: conn.baseline, poisoned: !!conn.ds5.poisoned, needsPowerCycle: conn.needsPowerCycle,
    });
    if (reasons.length) throw new StepAbort(`refused: ${reasons.join('; ')}`, { refused: true, nv: nv.status });
    if (!ask) return;
    const permanent = POSSIBLY_PERMANENT_STEPS.has(step);
    const text = permanent
      ? `${step} may change the spare controller PERMANENTLY. Continue only on a spare DualSense.`
      : `${step} writes to the spare controller's calibration in RAM (NVS stays locked). Continue?`;
    if (!(await confirm(step, text))) throw new StepAbort('not confirmed', { refused: true });
  }

  async function write(values) {
    const check = checkWriteValues(values, allowedSnapshots());
    if (!check.ok) throw new StepAbort(`refused write: ${check.reason}`, { refused: true });
    await writeModuleCal(conn.ds5, values);
    await clock.sleep(P.writeSettleMs);
  }

  // Una passata di calibrazione del centro con `n` campioni, con gli stessi
  // invarianti di quick.js: tenuta centrata prima di calibBegin, ogni campione
  // solo dopo una finestra stabile vicina al riferimento in sessione, mai un
  // calibSample dopo un timeout, mai un calibEnd su una passata incompleta
  // (la sessione resta aperta e il controller va spento).
  //
  // Qualsiasi errore da calibBegin (incluso) fino a calibEnd risolto (incluso),
  // timeout o errore HID qualunque, lascia una sessione 0x82 aperta o in uno
  // stato sconosciuto: il percorso di riparazione di calibBegin in js/ds5.js
  // può aver già chiuso o riaperto qualcosa. Da lì in poi ogni comando
  // scriverebbe dentro quella sessione (e un calibBegin successivo potrebbe
  // committare la passata parziale), quindi la connessione si segna da
  // spegnere e guardWrite rifiuta tutto.
  async function inOpenSession(body) {
    try {
      return await body();
    } catch (error) {
      conn.needsPowerCycle = true;
      throw error;
    }
  }

  // Il riferimento in sessione e la media della finestra stabile che ha
  // preceduto ogni calibSample (LSB, frame dei report durante la sessione)
  // restano nel risultato: X-pass li confronta con l'uscita prima della
  // sessione (X4) e fra loro (lo stick era fermo dove il firmware campionava?).
  async function pass(n) {
    await hold('calibBegin');
    const sampleMeans = [];
    return inOpenSession(async () => {
      const begin = await conn.ds5.calibBegin();
      const ref = await waitForStable(conn.source, clock, { maxRadius: 0.5, timeoutMs: P.sampleTimeoutMs });
      if (!ref) throw new StepAbort('no stable reference after calibBegin: session left open, power-cycle the controller', { stalled: true });
      const reference = toLsb(ref.center);
      for (let i = 0; i < n; i++) {
        const ok = await waitForStable(conn.source, clock, { near: ref.center, timeoutMs: P.sampleTimeoutMs });
        if (!ok) throw new StepAbort(`sample ${i + 1}/${n} never stable: session left open, power-cycle the controller`, { stalled: true, samples: i, reference, sampleMeans });
        sampleMeans.push(toLsb(ok.center));
        await conn.ds5.calibSample();
      }
      await clock.sleep(P.settleMs);
      await conn.ds5.calibEnd();
      return { samples: n, repairCommitted: begin?.committed === true, reference, sampleMeans };
    });
  }

  // --- aiuti R1-X ------------------------------------------------------------

  // H-e riuscita su QUESTA connessione (la scala di un'altra connessione non
  // vale: X-pass e X-fix la rifiutano).
  const heHere = () => [...record.steps].reverse().find(s => s.id === 'H-e' && s.ok && s.connection === conn.id) ?? null;

  // u per asse: unità a 16 bit per LSB di spostamento del CENTRO, cioè
  // −unitsPerLsb di H-e (che è per LSB di uscita: +u sul centro sposta
  // l'uscita di −1 LSB). Con questo segno idealΔ = uscita × u, come nel doc.
  function slopesFrom(he) {
    const u = {};
    for (const a of CENTER_AXES) {
      const f = he?.perAxis?.[a];
      u[a] = Number.isFinite(f?.unitsPerLsb) && f.unitsPerLsb !== 0 ? -f.unitsPerLsb : null;
    }
    return u;
  }

  // Attende un report dopo cui `test()` è vero, al massimo `timeoutMs`.
  // Guidato dai report; il timer è solo la guardia.
  function untilReport(test, timeoutMs) {
    return new Promise(resolve => {
      let settled = false;
      const finish = ok => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clock.clearTimeout(guard);
        resolve(ok);
      };
      const unsubscribe = conn.source.subscribe(() => { if (test()) finish(true); });
      const guard = clock.setTimeout(() => finish(false), timeoutMs);
      if (test()) finish(true);
    });
  }

  // Rilasci guidati dello stick sinistro: per ogni voce del piano attende un
  // punto fermo (senza, il rilevatore non riconosce un rilascio), mostra la
  // direzione e attende l'arrivo. Un timeout registra null e passa oltre.
  async function flicks(step, plan) {
    const detector = createLandingDetector();
    const landings = [];
    const unsubscribe = conn.source.subscribe(() => {
      for (const l of detector.push(conn.source.sticks, reportTimeOf(conn.source))) if (l.stick === 'left') landings.push(l);
    });
    const out = [];
    try {
      for (const [k, item] of plan.entries()) {
        const row = { direction: item.direction.name, index: item.index, landing: null };
        out.push(row);
        if (!(await untilReport(() => detector.phase('left') === 'rest', P.flickTimeoutMs))) { row.missed = 'no-rest'; continue; }
        const seen = landings.length;
        await prompt({
          step, direction: item.direction.name, index: item.index, n: k + 1, total: plan.length,
          text: `${step}: flick the LEFT stick ${item.direction.name.toUpperCase()} and let go (${k + 1}/${plan.length}). Leave the right stick alone.`,
        });
        if (!(await untilReport(() => landings.length > seen, P.flickTimeoutMs))) { row.missed = 'no-landing'; continue; }
        const l = landings[seen];
        row.landing = { axes: l.landAxes, peak: l.peak, settleMs: l.settleMs };
      }
    } finally {
      unsubscribe();
      await prompt(null);
    }
    return out;
  }

  const landingMedian = rows => {
    const got = rows.filter(r => r.landing);
    return got.length ? [round2(median(got.map(r => r.landing.axes[0]))), round2(median(got.map(r => r.landing.axes[1])))] : null;
  };

  // Una passata X-pass misurata: Δ dei centri, Δ ideale, errore di cattura E.
  function analyzePass(i, before, after, outBefore, outAfter, p, u) {
    const delta = {}, idealDelta = {}, E = {}, sampleVsRef = {}, inSessionVsPre = {};
    CENTER_AXES.forEach((a, k) => {
      const idx = CENTER_INDEXES[k];
      delta[a] = after[idx] - before[idx];
      idealDelta[a] = u[a] ? round2(outBefore.mean[a] * u[a]) : null;
      E[a] = u[a] ? round2((delta[a] - outBefore.mean[a] * u[a]) / u[a]) : null;
      sampleVsRef[a] = round2(Math.max(0, ...p.sampleMeans.map(m => Math.abs(m[a] - p.reference[a]))));
      inSessionVsPre[a] = round2(p.sampleMeans.reduce((s, m) => s + m[a], 0) / p.sampleMeans.length - outBefore.mean[a]);
    });
    const o = outAfter.mean;
    return {
      pass: i, before, after, diff: diffValues(before, after),
      outBefore: outBefore.mean, outAfter: o, delta, idealDelta, E,
      reference: p.reference, sampleMeans: p.sampleMeans, sampleVsRef, inSessionVsPre,
      repairCommitted: p.repairCommitted,
      ceiling: Math.hypot(o.lx, o.ly) >= CEILING_LSB || Math.hypot(o.rx, o.ry) >= CEILING_LSB,
    };
  }

  // --- passi ---------------------------------------------------------------

  const steps = {
    // Prima di tutto: stato NVS e [12,2]. Senza NVS `locked` il probe si
    // ferma qui (niente baseline = nessuna scrittura possibile).
    async preflight() {
      const nv = await conn.ds5.queryNvStatus();
      conn.nv = nv.status;
      record.connections[conn.id - 1].nv = nv.status;
      const r = await readModuleCal(conn.ds5);
      const out = await measure();
      const data = { nv: nv.status, nvRaw: nv.raw ?? null, read: r ? { values: r.values, p2: r.p2 } : null, out };
      if (!r) throw new StepAbort('[12,2] reply failed validation: this controller does not answer the read, stop here', data);
      conn.snapshots.push(r.values);
      if (nv.status !== 'locked') throw new StepAbort(`NVS is ${nv.status}, not locked: abort, nothing will be written`, data);
      conn.baseline = { values: r.values, p2: r.p2 };
      conn.baselineOut = out;
      if (!record.baseline) {
        record.baseline = { values: r.values, p2: r.p2, out, connection: conn.id };
        baselineIdentity = conn.identity;
      }
      return data;
    },

    // H-a: la lettura è stabile a riposo?
    async 'H-a'() {
      const reads = [];
      for (let i = 0; i < P.readRepeats; i++) {
        const r = await readModuleCal(conn.ds5);
        reads.push(r ? { values: r.values, p2: r.p2 } : null);
        if (r) conn.snapshots.push(r.values);
        await clock.sleep(200);
      }
      const valid = reads.every(Boolean);
      return { reads, allValid: valid, identical: valid && reads.every(r => sameValues(r.values, reads[0].values)) };
    },

    // H-b: una passata Quick (12 campioni), poi rilettura. 0x82 scrive gli
    // stessi campi che [12,2] legge? Tocca solo i centri?
    async 'H-b'({ samples = 12 } = {}) {
      await guardWrite('H-b');
      const before = await read('before H-b');
      const outBefore = await measure();
      const p = await pass(samples);
      const after = await read('after H-b');
      const outAfter = await measure();
      const diff = diffValues(before.values, after.values);
      return {
        ...p, before: before.values, after: after.values, diff, outBefore, outAfter, outDelta: outDelta(outBefore, outAfter),
        centersChanged: CENTER_INDEXES.some(i => before.values[i] !== after.values[i]),
        rangeChanged: RANGE_INDEXES.some(i => before.values[i] !== after.values[i]),
      };
    },

    // H-c: riscrive una lettura (di default la baseline della connessione) e
    // rilegge. Il restauro è esatto e l'uscita torna dov'era?
    async 'H-c'({ target } = {}) {
      await guardWrite('H-c');
      const values = target ?? conn.baseline.values;
      const before = await read('before H-c');
      await write(values);
      const after = await read('after H-c');
      await hold('the H-c measurement');
      const out = await measure();
      const reference = sameValues(values, conn.baseline.values) ? conn.baselineOut : null;
      return {
        target: values, before: before.values, after: after.values, exact: sameValues(values, after.values),
        diff: diffValues(values, after.values), out, outVsBaseline: outDelta(reference, out),
      };
    },

    // H-d: calibEnd con 0 campioni (il percorso di riparazione di calibBegin).
    async 'H-d'() {
      await guardWrite('H-d');
      const before = await read('before H-d');
      const outBefore = await measure();
      await hold('calibBegin');
      const begin = await inOpenSession(async () => {
        const b = await conn.ds5.calibBegin();
        await clock.sleep(P.settleMs);
        await conn.ds5.calibEnd();
        return b;
      });
      const after = await read('after H-d');
      const outAfter = await measure();
      const diff = diffValues(before.values, after.values);
      return {
        repairCommitted: begin?.committed === true, before: before.values, after: after.values, diff,
        behaviour: Object.keys(diff).length === 0 ? 'unchanged' : 'changed', outBefore, outAfter, outDelta: outDelta(outBefore, outAfter),
      };
    },

    // H-e: pendenza uscita/valore. Gradini ±s e ±2s su ogni centro a partire
    // dalla lettura corrente, sempre riportata al valore di partenza alla fine.
    async 'H-e'({ step = P.slopeStep, axes = CENTER_AXES } = {}) {
      await guardWrite('H-e');
      const base = await read('before H-e');
      await hold('the H-e baseline');
      const out0 = await measure();
      const perAxis = {};
      let restored = null;
      try {
        for (const axis of axes) {
          const idx = CENTER_INDEXES[CENTER_AXES.indexOf(axis)];
          const points = [];
          let blocked = false;
          for (const d of [step, -step, 2 * step, -2 * step]) {
            if (Math.abs(d) > MAX_CENTER_DELTA || blocked && Math.abs(d) > step) continue;
            const v = base.values[idx] + d;
            if (v < 0 || v > 0xffff) continue;
            const values = [...base.values];
            values[idx] = v;
            await write(values);
            const out = await measure();
            if (!out) throw new StepAbort('no input reports during H-e');
            const dOut = outDelta(out0, out);
            points.push({ delta: d, out: dOut[axis], cross: Object.fromEntries(CENTER_AXES.filter(a => a !== axis).map(a => [a, dOut[a]])) });
            if (Math.abs(dOut[axis]) > P.slopeMaxOut) blocked = true;
          }
          perAxis[axis] = { points, ...fitSlope(points) };
        }
      } finally {
        // Sempre di nuovo al punto di partenza, anche dopo un errore.
        if (!conn.ds5.poisoned) {
          await writeModuleCal(conn.ds5, base.values);
          await clock.sleep(P.writeSettleMs);
          const back = await readModuleCal(conn.ds5);
          restored = !!back && sameValues(back.values, base.values);
        }
      }
      return { step, base: base.values, out0, perAxis, restored };
    },

    // A/B del numero di campioni: passate alternate (12, 4, 12, 4, …) con
    // rilettura dei centri dopo ognuna, poi ritorno alla lettura iniziale.
    async AB({ reps = P.abReps, arms = P.abSamples } = {}) {
      await guardWrite('AB');
      const base = await read('before A/B');
      const runs = [];
      let restored = null;
      try {
        for (let r = 0; r < reps; r++) {
          for (const n of arms) {
            await pass(n);
            const after = await read(`after A/B pass (${n})`);
            await hold('the A/B measurement');
            const out = await measure();
            runs.push({ samples: n, centers: centersOf(after.values), out: out?.mean ?? null });
          }
        }
      } finally {
        if (!conn.ds5.poisoned && !conn.needsPowerCycle) {
          await writeModuleCal(conn.ds5, base.values);
          await clock.sleep(P.writeSettleMs);
          const back = await readModuleCal(conn.ds5);
          restored = !!back && sameValues(back.values, base.values);
        }
      }
      return { reps, arms, base: base.values, runs, summary: summarizeAB(runs, arms), restored };
    },

    // Ripristino manuale: la baseline del diario solo se è provato che è di
    // questo controller, altrimenti quella di questa connessione.
    async restore() {
      await guardWrite('restore');
      const target = baselineIsThisController() ? record.baseline.values : conn.baseline.values;
      await write(target);
      const after = await read('after restore');
      return { target, after: after.values, exact: sameValues(target, after.values) };
    },

    // H-f, parte 1 (sola lettura): fotografia prima dello spegnimento.
    async 'H-f-prepare'() {
      const r = await read('before power-cycle');
      const out = await measure();
      record.preCycle = { values: r.values, out, connection: conn.id };
      preCycleIdentity = conn.identity;
      return { values: r.values, out, differsFromBaseline: !!record.baseline && !sameValues(r.values, record.baseline.values) };
    },

    // H-f, parte 2 (sola lettura), su una NUOVA connessione dopo lo
    // spegnimento: la RAM è tornata alla baseline (cioè alla NVS)?
    async 'H-f-check'() {
      if (!record.preCycle) throw new StepAbort('run H-f-prepare before the power-cycle');
      if (conn.id === record.preCycle.connection) throw new StepAbort('power the controller off (hold PS 10 s) and reconnect first');
      // Serve la prova che baseline, fotografia e lettura vengano dallo stesso
      // controller: senza seriali noti e uguali il verdetto H-f non vale.
      const vsPre = sameIdentity(conn.identity, preCycleIdentity);
      const vsBase = sameIdentity(conn.identity, baselineIdentity);
      if (vsPre === false || vsBase === false) throw new StepAbort('a different controller is connected');
      if (vsPre !== true || vsBase !== true) throw new StepAbort('serial unavailable, cannot confirm same controller', { sameController: null });
      const r = await read('after power-cycle');
      const out = await measure();
      return {
        values: r.values, out,
        revertedToBaseline: sameValues(r.values, record.baseline.values),
        unchangedFromPreCycle: sameValues(r.values, record.preCycle.values),
        preCycleDiffered: !sameValues(record.preCycle.values, record.baseline.values),
      };
    },

    // --- R1-X (docs/hw-probe-bdm040.md) --------------------------------------

    // X-idle (sola lettura): mani lontane per `ms`. Per secondo mediana e
    // escursione di ogni asse in LSB; deriva = mediana dell'ultimo minuto meno
    // quella del primo (con una corsa corta, il primo e l'ultimo quinto).
    async 'X-idle'({ ms = P.idleMs } = {}) {
      const t0 = conn.source.now();
      const raw = [];
      const unsubscribe = conn.source.subscribe(() => {
        const s = conn.source.sticks;
        raw.push({ t: reportTimeOf(conn.source) - t0, lx: s.lx * LSB, ly: s.ly * LSB, rx: s.rx * LSB, ry: s.ry * LSB });
      });
      try {
        await clock.sleep(ms);
      } finally {
        unsubscribe();
      }
      if (raw.length < 40) throw new StepAbort('no input reports during X-idle');
      const bySecond = new Map();
      for (const r of raw) {
        const k = Math.floor(r.t / 1000);
        if (!bySecond.has(k)) bySecond.set(k, []);
        bySecond.get(k).push(r);
      }
      const perSecond = [...bySecond.entries()].sort((a, b) => a[0] - b[0]).map(([s, rs]) => ({
        s, n: rs.length,
        median: Object.fromEntries(CENTER_AXES.map(a => [a, round2(median(rs.map(r => r[a])))])),
        spread: Object.fromEntries(CENTER_AXES.map(a => [a, round2(Math.max(...rs.map(r => r[a])) - Math.min(...rs.map(r => r[a])))])),
      }));
      const windowMs = Math.min(60000, ms / 5);
      const first = raw.filter(r => r.t < windowMs);
      const last = raw.filter(r => r.t >= ms - windowMs);
      if (!first.length || !last.length) throw new StepAbort('X-idle: no reports in the first or last window');
      const drift = Object.fromEntries(CENTER_AXES.map(a => [a, round2(median(last.map(r => r[a])) - median(first.map(r => r[a])))]));
      const maxSpread = Object.fromEntries(CENTER_AXES.map(a => [a, Math.max(...perSecond.map(r => r.spread[a]))]));
      return { ms, windowMs, reports: raw.length, perSecond, drift, driftLx: drift.lx, maxSpread };
    },

    // X-release (sola lettura): `flicksPer` rilasci dello stick sinistro in
    // ognuna delle 8 direzioni. Mediana dell'arrivo per direzione e differenza
    // su LX fra direzioni opposte.
    async 'X-release'({ flicksPer = P.releaseFlicks } = {}) {
      const plan = [];
      for (const direction of RELEASE_DIRECTIONS) for (let index = 0; index < flicksPer; index++) plan.push({ direction, index });
      const rows = await flicks('X-release', plan);
      const byDirection = RELEASE_DIRECTIONS.map(d => {
        const mine = rows.filter(r => r.direction === d.name);
        return { direction: d.name, landed: mine.filter(r => r.landing).length, median: landingMedian(mine) };
      });
      const opposite = [];
      for (let i = 0; i < 4; i++) {
        const a = byDirection[i], b = byDirection[i + 4];
        opposite.push({ pair: [a.direction, b.direction], lxDiff: a.median && b.median ? round2(Math.abs(a.median[0] - b.median[0])) : null });
      }
      const diffs = opposite.map(o => o.lxDiff).filter(Number.isFinite);
      return {
        flicksPer, flicks: rows, byDirection, opposite,
        maxOppositeLxDiff: diffs.length ? Math.max(...diffs) : null,
        missed: rows.filter(r => !r.landing).length,
      };
    },

    // X-pass: `passes` passate come H-b, ognuna dalla stessa baseline
    // (restaurata con [12,1] e riletta dopo ogni passata). Errore di cattura
    // E = (Δ − idealΔ) / u in LSB per asse. Una passata che lascia un'uscita
    // ≥15% ferma il passo (dopo il restauro): si spegne il controller.
    async 'X-pass'({ passes = P.xPasses, samples = 12 } = {}) {
      const he = heHere();
      const u = slopesFrom(he);
      if (!he || !u.lx) throw new StepAbort('run H-e on this connection first: X-pass needs its slope (u) on LX', { refused: true });
      await guardWrite('X-pass');
      const target = baselineIsThisController() ? record.baseline.values : conn.baseline.values;
      const runs = [];
      const summary = () => ({ u, heAt: he.at, target, passes: runs });
      try {
        for (let i = 1; i <= passes; i++) {
          if (i > 1) await guardWrite('X-pass', { ask: false });
          const before = await read(`before X-pass ${i}`);
          await hold('the X-pass measurement');
          const outBefore = await measure();
          if (!outBefore) throw new StepAbort(`no input reports before X-pass ${i}`);
          const p = await pass(samples);
          const after = await read(`after X-pass ${i}`);
          const outAfter = await measure();
          if (!outAfter) throw new StepAbort(`no input reports after X-pass ${i}: the restore did not run, power-cycle the controller`);
          const row = analyzePass(i, before.values, after.values, outBefore, outAfter, p, u);
          runs.push(row);
          await write(target);
          const back = await read(`restore after X-pass ${i}`);
          row.restoredExact = sameValues(back.values, target);
          if (!row.restoredExact) throw new StepAbort(`the restore after X-pass ${i} did not read back exactly: stop and power-cycle the controller`);
          if (row.ceiling) return { ...summary(), stoppedAtCeiling: i };
        }
      } catch (error) {
        error.partial = summary();
        throw error;
      }
      return { ...summary(), stoppedAtCeiling: null };
    },

    // X-fix: da una lettura fresca scrive il centro sinistro ideale
    // (LX + uscita × u; LY solo se |uscita| ≥ 1 LSB), con la regola
    // checkFixWrite. Poi rilettura, uscita subito, dopo `fixWaitMs` e la
    // mediana degli arrivi di `count` rilasci. Lascia la RAM corretta: X-replug
    // e lo spegnimento finale la riportano alla baseline.
    async 'X-fix'({ count = P.fixFlicks } = {}) {
      const he = heHere();
      const u = slopesFrom(he);
      if (!he || !u.lx) throw new StepAbort('run H-e on this connection first: X-fix needs its slope (u) on LX', { refused: true });
      await guardWrite('X-fix');
      const snap = await read('before X-fix');
      await hold('the X-fix measurement', { centered: false });
      const out = await measure();
      if (!out) throw new StepAbort('no input reports before X-fix');
      const values = [...snap.values];
      const correction = { lx: Math.round(out.mean.lx * u.lx), ly: 0 };
      values[8] += correction.lx;
      let lySkipped = null;
      if (Math.abs(out.mean.ly) < 1) lySkipped = 'LY output under 1 LSB';
      else if (fixFitRefusal(he.perAxis.ly, 'LY')) lySkipped = fixFitRefusal(he.perAxis.ly, 'LY');
      else {
        correction.ly = Math.round(out.mean.ly * u.ly);
        values[9] += correction.ly;
      }
      const data = { u: { lx: u.lx, ly: u.ly }, from: snap.values, outBefore: out.mean, correction, lySkipped, target: values };
      const check = checkFixWrite({
        step: 'X-fix', values, snapshot: snap.values, snapshots: conn.snapshots,
        he: { connection: he.connection, perAxis: he.perAxis }, connectionId: conn.id,
      });
      if (!check.ok) throw new StepAbort(`refused write: ${check.reason}`, { refused: true, ...data });
      await writeModuleCal(conn.ds5, values);
      await clock.sleep(P.writeSettleMs);
      const back = await read('after X-fix');
      const outNow = await measure();
      await clock.sleep(P.fixWaitMs);
      const outLater = await measure();
      const plan = Array.from({ length: count }, (_, i) => ({ direction: RELEASE_DIRECTIONS[i % RELEASE_DIRECTIONS.length], index: 0 }));
      const rows = await flicks('X-fix', plan);
      return {
        ...data, after: back.values, exact: sameValues(values, back.values), diff: diffValues(values, back.values),
        outNow: outNow?.mean ?? null, outLater: outLater?.mean ?? null, waitMs: P.fixWaitMs,
        flicks: rows, landingMedian: landingMedian(rows), landed: rows.filter(r => r.landing).length,
      };
    },

    // X-replug (sola lettura), su una NUOVA connessione dopo aver staccato e
    // riattaccato il cavo SENZA spegnere: [12,2] e uscita uguali all'ultima
    // lettura della connessione precedente? Risponde a H11 per la RAM. Serve
    // la prova che sia lo stesso controller (seriali noti e uguali).
    async 'X-replug'() {
      if (!prev) throw new StepAbort('unplug the USB cable, plug it back in (no power-off), Connect and run the preflight first');
      const same = sameIdentity(conn.identity, prev.identity);
      if (same === false) throw new StepAbort('a different controller is connected');
      if (same !== true) throw new StepAbort('serial unavailable, cannot confirm same controller', { sameController: null });
      const previous = prev.snapshots.at(-1);
      if (!previous) throw new StepAbort('the previous connection has no [12,2] read to compare with');
      if (!(await confirm('X-replug', 'X-replug: confirm that you only unplugged the USB cable and plugged it back in, without turning the controller off.')))
        throw new StepAbort('not confirmed: after a power-off this answers H-f, not H11', { refused: true });
      const r = await read('after replug');
      const out = await measure();
      return {
        previousConnection: prev.id, values: r.values, previous,
        identicalToPrevious: sameValues(r.values, previous), diff: diffValues(previous, r.values),
        out: out?.mean ?? null, outVsPrevious: outDelta(prev.lastOut, out),
        previousDiffersFromBaseline: record.baseline ? !sameValues(previous, record.baseline.values) : null,
        matchesBaseline: record.baseline ? sameValues(r.values, record.baseline.values) : null,
      };
    },
  };

  async function run(id, opts = {}) {
    if (!conn) throw new Error('no controller attached');
    if (!steps[id]) throw new Error(`unknown step ${id}`);
    const entry = { id, connection: conn.id, at: new Date(now()).toISOString(), ok: false };
    try {
      if (id !== 'preflight' && !conn.baseline && !id.startsWith('H-f')) throw new StepAbort('run the preflight read first (NVS locked, valid [12,2])');
      Object.assign(entry, await steps[id](opts));
      entry.ok = true;
    } catch (error) {
      entry.error = error.message;
      // Ciò che un passo a più fasi aveva già misurato prima di fermarsi.
      if (error.partial) Object.assign(entry, error.partial);
      if (error instanceof StepAbort) Object.assign(entry, error.data);
      else {
        entry.hidError = true;
        if (error.committed) entry.committed = true;
      }
      if (conn.ds5.poisoned) entry.poisoned = true;
    }
    if (conn.needsPowerCycle) entry.needsPowerCycle = true;
    record.steps.push(entry);
    log(`${id}: ${entry.ok ? 'done' : `stopped (${entry.error})`}`);
    return entry;
  }

  return {
    record,
    attach,
    armWith,
    armed,
    run,
    get connectionId() { return conn?.id ?? null; },
    get needsPowerCycle() { return !!conn?.needsPowerCycle; },
    evaluate: () => evaluate(record),
    exportJson: () => JSON.stringify({ ...record, evaluation: evaluate(record) }, null, 2),
  };
}

// Un seriale conta solo se è una stringa non vuota.
const knownIdentity = v => typeof v === 'string' && v.length > 0;
// true = stesso controller provato; false = controller diversi provati;
// null = almeno un seriale manca, non si può dire.
function sameIdentity(a, b) {
  if (!knownIdentity(a) || !knownIdentity(b)) return null;
  return a === b;
}

// Minimi quadrati per l'origine: Δuscita (LSB) = k · Δvalore. `unitsPerLsb` è
// 1/k col segno: quante unità a 16 bit spostano l'uscita di un LSB.
export function fitSlope(points) {
  if (points.length < 2) return { lsbPerUnit: null, unitsPerLsb: null, r2: null };
  const sxy = points.reduce((s, p) => s + p.delta * p.out, 0);
  const sxx = points.reduce((s, p) => s + p.delta ** 2, 0);
  const k = sxy / sxx;
  const ssRes = points.reduce((s, p) => s + (p.out - k * p.delta) ** 2, 0);
  const ssTot = points.reduce((s, p) => s + p.out ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  return {
    lsbPerUnit: Number(k.toPrecision(6)),
    unitsPerLsb: k !== 0 ? Math.round((1 / k) * 100) / 100 : null,
    r2: r2 === null ? null : round4(r2),
  };
}

function summarizeAB(runs, arms) {
  const out = {};
  for (const n of arms) {
    const rs = runs.filter(r => r.samples === n);
    const axes = {};
    for (const a of CENTER_AXES) {
      const vs = rs.map(r => r.centers[a]);
      const m = vs.reduce((s, v) => s + v, 0) / (vs.length || 1);
      const os = rs.map(r => r.out?.[a]).filter(Number.isFinite);
      axes[a] = {
        centerMean: round4(m),
        centerSd: round4(Math.sqrt(vs.reduce((s, v) => s + (v - m) ** 2, 0) / (vs.length || 1))),
        outMeanAbs: os.length ? round4(os.reduce((s, v) => s + Math.abs(v), 0) / os.length) : null,
      };
    }
    out[n] = { passes: rs.length, axes };
  }
  return out;
}

// Criteri di go/no-go (docs/hw-probe-protocol.md, "Decision rules"). Il
// verdetto finale lo scrive Martino nel documento: questa è una lettura
// meccanica del diario, utile per non dimenticare un criterio.
export function evaluate(record) {
  const last = id => [...record.steps].reverse().find(s => s.id === id && s.ok) ?? null;
  const reasons = [];
  const verdict = {};

  const pre = last('preflight');
  const locked = record.connections.length > 0 && record.connections.every(c => c.nv === 'locked' || c.nv === null);
  const poisoned = record.steps.some(s => s.poisoned);
  if (!pre) reasons.push('preflight: no valid [12,2] read with NVS locked');
  if (!locked) reasons.push('NVS was not locked on every connection');
  if (poisoned) reasons.push('a command timed out: results after it are not trustworthy');

  // H-a
  const ha = last('H-a');
  verdict.readStable = !ha ? 'missing' : ha.identical ? 'pass' : 'fail';
  if (ha && !ha.allValid) reasons.push('H-a: some [12,2] replies failed validation');
  if (ha && ha.allValid && !ha.identical) reasons.push('H-a: reads at rest differ');

  // H-b: la lettura segue la calibrazione 0x82?
  const hb = last('H-b');
  if (!hb) verdict.tracksCalib = 'missing';
  else {
    const outMoved = hb.outDelta && Object.values(hb.outDelta).some(d => Math.abs(d) >= 1);
    if (hb.rangeChanged) { verdict.tracksCalib = 'fail'; reasons.push('H-b: a center pass changed range fields (LL…RB)'); }
    else if (outMoved && !hb.centersChanged) { verdict.tracksCalib = 'fail'; reasons.push('H-b: output moved ≥1 LSB but no center value changed'); }
    else if (!hb.centersChanged) { verdict.tracksCalib = 'inconclusive'; reasons.push('H-b: the pass changed nothing: repeat on a stick with a visible offset'); }
    else verdict.tracksCalib = 'pass';
  }

  // H-c: restauro esatto e uscita di nuovo alla baseline (entro 1 LSB).
  const hc = last('H-c');
  if (!hc) verdict.restoreExact = 'missing';
  else if (!hc.exact) { verdict.restoreExact = 'fail'; reasons.push('H-c: the read after the write-back differs from what was written'); }
  else if (hc.outVsBaseline && Object.values(hc.outVsBaseline).some(d => Math.abs(d) > 1)) {
    verdict.restoreExact = 'fail'; reasons.push('H-c: values restored but the output did not return within 1 LSB of the baseline');
  } else if (!hc.outVsBaseline) { verdict.restoreExact = 'inconclusive'; reasons.push('H-c: no baseline output to compare with'); }
  else verdict.restoreExact = 'pass';

  // H-f: con NVS bloccata, lo spegnimento riporta la baseline?
  const hf = last('H-f-check');
  if (!hf) verdict.revertsOnPowerCycle = 'missing';
  else if (!hf.preCycleDiffered) { verdict.revertsOnPowerCycle = 'inconclusive'; reasons.push('H-f: RAM equalled the baseline before the power-cycle: run H-b (no restore) before H-f-prepare'); }
  else if (hf.revertedToBaseline) verdict.revertsOnPowerCycle = 'pass';
  else { verdict.revertsOnPowerCycle = 'fail'; reasons.push('H-f: the calibration survived a power-cycle with NVS locked'); }

  // H-d: solo descrittivo, informa il percorso di riparazione di calibBegin.
  const hd = last('H-d');
  verdict.zeroSampleEnd = hd ? hd.behaviour : 'missing';

  // H-e: la scala per un'eventuale correzione sotto l'LSB (ricerca, non prodotto).
  const he = last('H-e');
  if (!he) verdict.slope = 'missing';
  else {
    const fits = Object.values(he.perAxis).filter(f => f.unitsPerLsb !== null);
    const signs = new Set(fits.map(f => Math.sign(f.unitsPerLsb)));
    const good = fits.length > 0 && fits.every(f => f.r2 !== null && f.r2 >= 0.9 && Math.abs(f.unitsPerLsb) >= 2) && signs.size === 1;
    verdict.slope = good ? 'pass' : 'fail';
    if (!good) reasons.push('H-e: slope missing, noisy (R² < 0.9), under 2 units per LSB or with mixed signs');
    if (he.restored === false) reasons.push('H-e: the final write-back did not read back exactly');
  }

  // A/B: il campione da 4 non peggiora dispersione né residuo?
  const ab = last('AB');
  if (!ab) verdict.fourSamples = 'missing';
  else {
    const [big, small] = ab.arms;
    const A = ab.summary[big]?.axes, B = ab.summary[small]?.axes;
    const ok = A && B && CENTER_AXES.every(a => B[a].centerSd <= 1.5 * A[a].centerSd + 1
      && (B[a].outMeanAbs ?? Infinity) <= (A[a].outMeanAbs ?? 0) + 0.5);
    verdict.fourSamples = ab.reps < 5 ? 'inconclusive' : ok ? 'pass' : 'fail';
    if (ab.reps < 5) reasons.push('A/B: fewer than 5 passes per arm, too few to decide');
    else if (!ok) reasons.push('A/B: 4 samples scatter more or leave a larger residual than 12');
  }

  const r1x = evaluateR1X(record, last);

  const core = ['readStable', 'tracksCalib', 'restoreExact', 'revertsOnPowerCycle'];
  const readback = !pre || !locked || poisoned || core.some(k => verdict[k] === 'fail') ? 'no-go'
    : core.every(k => verdict[k] === 'pass') ? 'go' : 'incomplete';
  return {
    label: 'hardware result only when produced on a real spare DualSense; against the simulator it is model-verified',
    readbackRestore: readback,
    subLsbNudge: readback === 'go' && verdict.slope === 'pass' ? 'go (research)' : verdict.slope === 'missing' ? 'incomplete' : 'no-go',
    sampleCut: verdict.fourSamples === 'pass' ? 'candidate (needs the simulator gates too)' : 'keep 12',
    verdict,
    reasons,
    r1x,
    ranSteps: [...new Set(record.steps.map(s => s.id))],
    fields: MODULE_FIELDS,
  };
}

// Regole di R1-X (docs/hw-probe-bdm040.md, "Decision rules"). Come evaluate:
// una lettura meccanica del diario, il verdetto lo scrive Martino. Ogni voce è
// 'incomplete' finché manca un passo che la regola richiede.
export function evaluateR1X(record, last) {
  const reasons = [];
  const idle = last('X-idle');
  const release = last('X-release');
  const xp = last('X-pass');
  const fix = last('X-fix');
  const replug = last('X-replug');
  // La H-e usata da X-pass (stessa connessione), altrimenti l'ultima riuscita.
  const he = (xp && [...record.steps].reverse().find(s => s.id === 'H-e' && s.ok && s.connection === xp.connection)) || last('H-e');

  // X1: errore di cattura su LX.
  let x1;
  const passes = xp?.passes ?? [];
  if (!xp) { x1 = 'incomplete'; reasons.push('X1: X-pass missing'); }
  else if (!idle) { x1 = 'incomplete'; reasons.push('X1: X-idle missing (the rule needs left X still within 1 LSB)'); }
  else if (passes.some(p => ['ly', 'rx', 'ry'].some(a => p.E[a] === null))) {
    x1 = 'incomplete'; reasons.push('X1: H-e gave no slope on LY, RX or RY, so their E cannot be checked');
  } else {
    const big = passes.filter(p => Math.abs(p.E.lx) >= 4);
    const signs = new Set(big.map(p => Math.sign(p.E.lx)));
    const strong = big.filter(p => Math.abs(p.outAfter.lx + p.E.lx) <= 1);
    const conds = {
      idleStill: Math.abs(idle.driftLx) <= 1,
      threeSameSign: strong.length >= 3 && signs.size === 1,
      othersClean: passes.every(p => ['ly', 'rx', 'ry'].every(a => Math.abs(p.E[a]) <= 1)),
      sampledWhereStill: passes.every(p => CENTER_AXES.every(a => p.sampleVsRef[a] <= 1)),
    };
    if (!conds.idleStill) reasons.push(`X1: left X drifted ${idle.driftLx} LSB in X-idle (more than 1)`);
    if (!conds.threeSameSign) reasons.push(`X1: ${strong.length} of ${passes.length} passes with |E| ≥ 4 LSB on LX and the output after within 1 LSB of −E${signs.size > 1 ? ', with mixed signs' : ''}`);
    if (!conds.othersClean) reasons.push('X1: |E| above 1 LSB on LY or the right stick');
    if (!conds.sampledWhereStill) reasons.push('X1: a sample window mean is more than 1 LSB from the in-session reference');
    if (Object.values(conds).every(Boolean)) x1 = 'confirmed';
    else if (xp.stoppedAtCeiling && !conds.threeSameSign) {
      x1 = 'inconclusive'; reasons.push(`X1: X-pass stopped at the 15% ceiling after pass ${xp.stoppedAtCeiling}`);
    } else x1 = 'not-confirmed';
  }

  // Fix works: X-fix rilegge esatto e l'uscita LX resta entro 1 LSB da 0.
  let fixWorks;
  if (!fix) { fixWorks = 'incomplete'; reasons.push('Fix: X-fix missing'); }
  else if (!fix.outNow || !fix.outLater || !fix.landingMedian) { fixWorks = 'incomplete'; reasons.push('Fix: an X-fix measurement or the landings are missing'); }
  else {
    const ok = fix.exact && Math.abs(fix.outNow.lx) <= 1 && Math.abs(fix.outLater.lx) <= 1 && Math.abs(fix.landingMedian[0]) <= 1;
    fixWorks = ok ? 'yes' : 'no';
    if (!fix.exact) reasons.push('Fix: the read after the X-fix write differs from what was written');
    else if (!ok) reasons.push(`Fix: left X not within 1 LSB of 0 (now ${fix.outNow.lx}, later ${fix.outLater.lx}, landings ${fix.landingMedian[0]})`);
  }

  // X2: mappatura non lineare o bordi asimmetrici (H-e su LX, bordi letti).
  let x2;
  const lxFit = he?.perAxis?.lx;
  if (!lxFit || lxFit.unitsPerLsb === null) { x2 = 'incomplete'; reasons.push('X2: no H-e fit on LX'); }
  else {
    const side = sign => fitSlope(lxFit.points.filter(pt => Math.sign(pt.delta) === sign)).lsbPerUnit;
    const pos = lxFit.points.some(pt => pt.delta > 0) ? side(1) : null;
    const neg = lxFit.points.some(pt => pt.delta < 0) ? side(-1) : null;
    const slopeAsym = pos !== null && neg !== null && Math.max(Math.abs(pos), Math.abs(neg)) > 0
      ? Math.abs(pos - neg) / Math.max(Math.abs(pos), Math.abs(neg)) : null;
    const v = record.baseline?.values;
    const up = v ? v[4] - v[8] : null, down = v ? v[8] - v[0] : null;
    const edgeAsym = v && Math.max(Math.abs(up), Math.abs(down)) > 0 ? Math.abs(up - down) / Math.max(Math.abs(up), Math.abs(down)) : null;
    const hits = [];
    if (lxFit.r2 === null || lxFit.r2 < 0.9) hits.push(`H-e LX R² ${lxFit.r2} < 0.9`);
    if (slopeAsym !== null && slopeAsym > 0.25) hits.push(`+/− slopes differ by ${Math.round(slopeAsym * 100)}%`);
    if (edgeAsym !== null && edgeAsym > 0.1) hits.push(`(LR − LX) and (LX − LL) differ by ${Math.round(edgeAsym * 100)}%`);
    x2 = hits.length ? 'yes' : slopeAsym === null || edgeAsym === null ? 'incomplete' : 'no';
    for (const h of hits) reasons.push(`X2: ${h}`);
    if (!hits.length && x2 === 'incomplete') reasons.push('X2: H-e lacks points on one side of LX, or no baseline read');
  }

  // X3: lo stick si muove da solo, o l'arrivo dipende dalla direzione.
  const idleMoves = idle ? Math.abs(idle.driftLx) > 2 : null;
  const releaseDepends = release && release.maxOppositeLxDiff !== null ? release.maxOppositeLxDiff > 2 : null;
  const x3 = idleMoves || releaseDepends ? 'yes' : idleMoves === false && releaseDepends === false ? 'no' : 'incomplete';
  if (idleMoves) reasons.push(`X3: left X drifted ${idle.driftLx} LSB in X-idle (more than 2)`);
  if (releaseDepends) reasons.push(`X3: landing medians on left X differ by ${release.maxOppositeLxDiff} LSB between opposite directions`);
  if (x3 === 'incomplete') reasons.push('X3: X-idle or X-release missing');

  // X4 (= H0 su questo controller): le medie in sessione contro l'uscita prima.
  let x4;
  if (!passes.length) { x4 = 'incomplete'; reasons.push('X4: no X-pass'); }
  else {
    const worst = Math.max(...passes.map(p => Math.max(...CENTER_AXES.map(a => Math.abs(p.inSessionVsPre[a])))));
    x4 = worst > 2 ? 'yes' : 'no';
    if (x4 === 'yes') reasons.push(`X4: in-session window means differ from the pre-session output by ${round2(worst)} LSB`);
  }

  // X-replug: H11 per la RAM.
  let h11;
  if (!replug) h11 = 'incomplete';
  else if (!replug.previousDiffersFromBaseline) { h11 = 'inconclusive'; reasons.push('X-replug: RAM equalled the baseline before the unplug, so nothing could be lost'); }
  else h11 = replug.identicalToPrevious ? 'kept' : 'lost';

  return {
    label: 'R1-X (docs/hw-probe-bdm040.md); against the simulator it is model-verified',
    x1, fixWorks, x2, x3, x4, replugKeepsRam: h11, reasons,
  };
}

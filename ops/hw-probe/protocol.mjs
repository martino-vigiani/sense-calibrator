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

import { waitForStable } from '../../js/calib/sampling.js';
import {
  CENTER_AXES, CENTER_INDEXES, MODULE_FIELDS, RANGE_INDEXES,
  centersOf, diffValues, readModuleCal, sameValues, writeModuleCal,
} from './module-cal.mjs';
import {
  MAX_CENTER_DELTA, POSSIBLY_PERMANENT_STEPS, checkWriteValues, createArming, arm, isArmed, writeRefusal,
} from './safety.mjs';

export const PROBE_SCHEMA = 'sense-hw-probe/1';

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
};

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
const outDelta = (a, b) => (a && b ? Object.fromEntries(CENTER_AXES.map(k => [k, round4(b.mean[k] - a.mean[k])])) : null);

class StepAbort extends Error {
  constructor(reason, data = {}) { super(reason); this.name = 'StepAbort'; this.data = data; }
}

// hostname: location.hostname nella pagina.
// clock: { sleep, setTimeout, clearTimeout } (il browser o l'orologio virtuale).
// confirm(step, text) → Promise<boolean>: conferma esplicita per ogni passo che
//   scrive. Nessuna conferma = nessuna scrittura.
export function createProbe({ hostname, clock, confirm, log = () => {}, now = () => Date.now(), params = {} }) {
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
  let conn = null;
  let firstIdentity = null;

  function attach({ ds5, source, info = {}, identity = null }) {
    const id = record.connections.length + 1;
    conn = { id, ds5, source, identity, arming: createArming(id), nv: null, baseline: null, baselineOut: null, snapshots: [], needsPowerCycle: false };
    if (firstIdentity === null) firstIdentity = identity;
    record.controller ??= { board: info.board ?? null, fwversion: info.fwversion ?? null, buildDate: info.buildDate ?? null };
    record.connections.push({ id, at: new Date(now()).toISOString(), sameController: identity === firstIdentity, nv: null });
    log(`Connection ${id}: disarmed. Run the preflight read first.`);
    return id;
  }

  function armWith(opts) {
    if (!conn) return false;
    return arm(conn.arming, opts);
  }

  const armed = () => !!conn && isArmed(conn.arming, conn.id);

  function hold(what) {
    return waitForStable(conn.source, clock, { requireCentered: true, timeoutMs: P.holdTimeoutMs }).then(ok => {
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

  const measure = () => measureOutput(conn.source, clock, P.measureMs);

  // Valori ammessi per [12,1]: letture di questa connessione, più la baseline
  // della prima connessione se il controller è lo stesso (restauro dopo una
  // riconnessione).
  function allowedSnapshots() {
    const snaps = [...conn.snapshots];
    if (record.baseline && conn.identity === firstIdentity) snaps.push(record.baseline.values);
    return snaps;
  }

  async function guardWrite(step) {
    // Lo stato NVS si rilegge adesso: quello della connessione può essere vecchio.
    const nv = await conn.ds5.queryNvStatus();
    const reasons = writeRefusal({
      step, hostname, arming: conn.arming, connectionId: conn.id, nv: { status: nv.status },
      baseline: conn.baseline, poisoned: !!conn.ds5.poisoned, needsPowerCycle: conn.needsPowerCycle,
    });
    if (reasons.length) throw new StepAbort(`refused: ${reasons.join('; ')}`, { refused: true, nv: nv.status });
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
  async function pass(n) {
    await hold('calibBegin');
    const begin = await conn.ds5.calibBegin();
    const ref = await waitForStable(conn.source, clock, { maxRadius: 0.5, timeoutMs: P.sampleTimeoutMs });
    if (!ref) { conn.needsPowerCycle = true; throw new StepAbort('no stable reference after calibBegin: session left open, power-cycle the controller', { stalled: true }); }
    for (let i = 0; i < n; i++) {
      const ok = await waitForStable(conn.source, clock, { near: ref.center, timeoutMs: P.sampleTimeoutMs });
      if (!ok) { conn.needsPowerCycle = true; throw new StepAbort(`sample ${i + 1}/${n} never stable: session left open, power-cycle the controller`, { stalled: true, samples: i }); }
      await conn.ds5.calibSample();
    }
    await clock.sleep(P.settleMs);
    await conn.ds5.calibEnd();
    return { samples: n, repairCommitted: begin?.committed === true };
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
      if (!record.baseline) record.baseline = { values: r.values, p2: r.p2, out, connection: conn.id };
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
      const begin = await conn.ds5.calibBegin();
      await clock.sleep(P.settleMs);
      await conn.ds5.calibEnd();
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

    // Ripristino manuale: la baseline della prima connessione (stesso
    // controller) o quella di questa connessione.
    async restore() {
      await guardWrite('restore');
      const target = record.baseline && conn.identity === firstIdentity ? record.baseline.values : conn.baseline.values;
      await write(target);
      const after = await read('after restore');
      return { target, after: after.values, exact: sameValues(target, after.values) };
    },

    // H-f, parte 1 (sola lettura): fotografia prima dello spegnimento.
    async 'H-f-prepare'() {
      const r = await read('before power-cycle');
      const out = await measure();
      record.preCycle = { values: r.values, out, connection: conn.id };
      return { values: r.values, out, differsFromBaseline: !!record.baseline && !sameValues(r.values, record.baseline.values) };
    },

    // H-f, parte 2 (sola lettura), su una NUOVA connessione dopo lo
    // spegnimento: la RAM è tornata alla baseline (cioè alla NVS)?
    async 'H-f-check'() {
      if (!record.preCycle) throw new StepAbort('run H-f-prepare before the power-cycle');
      if (conn.id === record.preCycle.connection) throw new StepAbort('power the controller off (hold PS 10 s) and reconnect first');
      if (conn.identity !== firstIdentity) throw new StepAbort('a different controller is connected');
      const r = await read('after power-cycle');
      const out = await measure();
      return {
        values: r.values, out,
        revertedToBaseline: sameValues(r.values, record.baseline.values),
        unchangedFromPreCycle: sameValues(r.values, record.preCycle.values),
        preCycleDiffered: !sameValues(record.preCycle.values, record.baseline.values),
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
    ranSteps: [...new Set(record.steps.map(s => s.id))],
    fields: MODULE_FIELDS,
  };
}

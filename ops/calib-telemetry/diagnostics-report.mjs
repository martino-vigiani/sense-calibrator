// Solo aggregati di diagnostiche validate; assenza storica resta ignota.
import { GUIDED_ONLY_MIN, LSB_PCT, ONE_STEP_PCT, WITHIN_ONE_STEP_MAX } from '../../js/calib/lattice.js';
export function diagnosticsReport(events) {
  const quick = { n: 0, withVerification: 0, withoutVerification: 0, attempts: 0, missingMeasurements: 0,
    criteria: {}, holds: {}, catastrophic: { n: 0, stableMeasurement: 0, unstableMeasurement: 0, unknownMeasurement: 0 } };
  const range = { n: 0, withCompletion: 0, withoutCompletion: 0,
    incomplete: { n: 0, reversalOnly: 0, coverageOnly: 0, rotationOnly: 0, mixed: 0, unknown: 0, byStick: { left: {}, right: {} } },
    // Il contratto ha un solo 'error' per tre storie diverse. Si separano
    // dai campi esistenti (euristica, nessun campo nuovo): `start` = rangeBegin
    // non accettato o senza risposta (nessun tracker: durS 0, copertura e giri
    // 0, niente completion); `close` = rangeEnd partito o scaduto
    // (committed); `interrupted` = sessione aperta lasciata senza rangeEnd
    // (pagina chiusa o controller staccato a metà rotazione).
    error: { n: 0, start: 0, interrupted: 0, close: 0 } };
  const count = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for (const e of events) {
    if (e.type === 'quick') {
      quick.n++;
      if (e.verification) quick.withVerification++; else quick.withoutVerification++;
      const attempts = e.verification?.attempts ?? [];
      for (const a of attempts) {
        quick.attempts++;
        if (!a.off) quick.missingMeasurements++;
        count(quick.criteria, a.criterion); count(quick.holds, a.hold);
      }
      if (e.outcome === 'catastrophic') {
        quick.catastrophic.n++;
        // Il fallback conserva l'ultima misura estrema della passata finale,
        // anche quando il gate di stabilità non l'ha accettata.
        const lastPass = attempts.at(-1)?.pass;
        const extreme = attempts.findLast(a => a.pass === lastPass && a.off && Math.max(...a.off) >= GUIDED_ONLY_MIN);
        if (!extreme || extreme.criterion === 'legacy') quick.catastrophic.unknownMeasurement++;
        else if (extreme.criterion === 'none') quick.catastrophic.unstableMeasurement++;
        else quick.catastrophic.stableMeasurement++;
      }
    } else if (e.type === 'range') {
      range.n++;
      if (e.completion) range.withCompletion++; else range.withoutCompletion++;
      if (e.outcome === 'error') {
        range.error.n++;
        const still = e.durS === 0 && !e.completion && [...e.coverage, ...e.turns].every(v => v === 0);
        if (e.committed) range.error.close++;
        else if (still) range.error.start++;
        else range.error.interrupted++;
        continue;
      }
      if (e.outcome !== 'incomplete') continue;
      range.incomplete.n++;
      if (!e.completion) { range.incomplete.unknown++; continue; }
      const reasons = new Set(e.completion.missing.flat());
      if (!reasons.size) range.incomplete.unknown++;
      else if (reasons.size === 1 && reasons.has('reverse')) range.incomplete.reversalOnly++;
      else if (reasons.size === 1 && reasons.has('coverage')) range.incomplete.coverageOnly++;
      // Bordo e lati completi, mancano giri (e forse l'inversione): non è un
      // limite fisico (RANGE_DEFAULTS.rotationUnlockMs).
      else if ([...reasons].every(r => r === 'turns' || r === 'reverse')) range.incomplete.rotationOnly++;
      else range.incomplete.mixed++;
      e.completion.missing.forEach((list, side) => {
        for (const reason of list) count(range.incomplete.byStick[side ? 'right' : 'left'], reason);
      });
    }
  }
  return { quick, range };
}

// Dopo un centraggio, lo stick torna fuori centro: quando, e dopo cosa?
//
// (a) Finestre `rest` che seguono, nella stessa visita, una Quick o Guided
//     committata il cui risultato era entro un passo (max(after) ≤ 1.25%):
//     quante trovano di nuovo uno stick oltre 1.25%, per fascia di sinceCalS
//     e per operazione in opsSince (con / senza). Le righe delle pagine
//     precedenti non hanno i campi: contano in `legacy`, mai in una fascia.
//     `bySequence` ricava Range e Write dagli eventi della visita (anche per
//     le righe vecchie): riconnessione e riavvio non si vedono lì.
// (b) Eventi `landing` (l'ultimo per visita e calibrazione, ref): per stick
//     con almeno MIN_LANDINGS rilasci, quanti hanno il p95 della dispersione
//     oltre un passo del reticolo (ONE_STEP_PCT ≈ 1.58 LSB: due arrivi che
//     differiscono solo fra i byte 127 e 128 su entrambi gli assi stanno a
//     1.41 LSB, sotto) e quanti hanno la mediana oltre 1.25% dal centro.
//     Nessun verdetto: le due firme (usura, calibrazione persa) sono descritte,
//     non attribuite a un controller.
export const SINCE_CAL_BANDS = Object.freeze([
  ['<1m', 0, 60], ['1-5m', 60, 300], ['5-15m', 300, 900], ['15-60m', 900, 3600], ['>=60m', 3600, Infinity],
]);
export const AFTER_OPS = Object.freeze(['range', 'flash', 'reconnect', 'power-cycle']);
export const MIN_LANDINGS = 5;
export const WEAR_SPREAD_LSB = ONE_STEP_PCT / LSB_PCT;

const ratio = (n, k, minimum) => (n >= minimum ? Math.round((k / n) * 1000) / 1000 : null);
const cell = () => ({ n: 0, offCenter: 0 });
const add = (c, off) => { c.n += 1; if (off) c.offCenter += 1; };
const close = (c, minimum) => ({ ...c, rate: ratio(c.n, c.offCenter, minimum) });
const bandFor = s => SINCE_CAL_BANDS.find(([, lo, hi]) => s >= lo && s < hi)[0];

export function afterCalibrationReport(events, { minimumCohortSize = 5 } = {}) {
  const bySid = new Map();
  for (const e of events) (bySid.get(e.sid) ?? bySid.set(e.sid, []).get(e.sid)).push(e);

  const all = cell();
  const bands = Object.fromEntries([...SINCE_CAL_BANDS.map(([k]) => [k, cell()]), ['legacy', cell()], ['mismatch', cell()]]);
  const withOp = Object.fromEntries(AFTER_OPS.map(op => [op, { with: cell(), without: cell() }]));
  const calibrationOnly = cell();
  const bySequence = Object.fromEntries(['range', 'flash'].map(op => [op, { with: cell(), without: cell() }]));
  const latestLanding = new Map();

  for (const [sid, list] of bySid) {
    list.sort((a, b) => a.seq - b.seq);
    let anchor = null;
    let seen = new Set();
    for (const e of list) {
      if ((e.type === 'quick' || e.type === 'guided') && e.committed) {
        anchor = e;
        seen = new Set();
      } else if (e.type === 'range' && e.committed) seen.add('range');
      else if (e.type === 'flash') seen.add('flash');
      else if (e.type === 'landing') {
        const key = `${sid}:${e.ref}`;
        if (!latestLanding.has(key) || latestLanding.get(key).seq < e.seq) latestLanding.set(key, e);
      } else if (e.type === 'rest' && anchor?.after && Math.max(...anchor.after) <= WITHIN_ONE_STEP_MAX) {
        const off = Math.max(...e.sticks.map(st => st.off)) > WITHIN_ONE_STEP_MAX;
        add(all, off);
        for (const op of ['range', 'flash']) add(bySequence[op][seen.has(op) ? 'with' : 'without'], off);
        if (!Object.hasOwn(e, 'sinceCalS')) { add(bands.legacy, off); continue; }
        // Un rest nuovo senza calibrazione mentre la visita ne mostra una
        // centrata: evento di calibrazione da un altro controller, o perso.
        if (e.sinceCalS === null || !Array.isArray(e.opsSince)) { add(bands.mismatch, off); continue; }
        add(bands[bandFor(e.sinceCalS)], off);
        for (const op of AFTER_OPS) add(withOp[op][e.opsSince.includes(op) ? 'with' : 'without'], off);
        if (e.opsSince.length <= 1) add(calibrationOnly, off);
      }
    }
  }

  const m = minimumCohortSize;
  const pair = o => ({ with: close(o.with, m), without: close(o.without, m) });
  const sticks = { n: 0, wideSpread: 0, offCenterMedian: 0, both: 0, afterCalibration: 0, p95SpreadLsb: [] };
  for (const e of latestLanding.values()) {
    for (const st of e.sticks) {
      if (st.count < MIN_LANDINGS || !st.spread || !st.median) continue;
      const wide = st.spread[1] > WEAR_SPREAD_LSB;
      const offCenter = Math.hypot(st.median[0], st.median[1]) / 2 * LSB_PCT > WITHIN_ONE_STEP_MAX;
      sticks.n += 1;
      if (wide) sticks.wideSpread += 1;
      if (offCenter) sticks.offCenterMedian += 1;
      if (wide && offCenter) sticks.both += 1;
      if (e.sinceCalS !== null) sticks.afterCalibration += 1;
      sticks.p95SpreadLsb.push(st.spread[1]);
    }
  }
  const spreads = sticks.p95SpreadLsb.sort((a, b) => a - b);
  const q = p => spreads[Math.max(0, Math.ceil(p * spreads.length) - 1)];
  return {
    definition: 'rest windows after a committed Quick or Guided whose result was within one step (≤1.25%); off center = either stick over 1.25%',
    restAfterCentering: {
      all: close(all, m),
      bySinceCal: Object.fromEntries(Object.entries(bands).map(([k, c]) => [k, close(c, m)])),
      byOpsSince: { ...Object.fromEntries(AFTER_OPS.map(op => [op, pair(withOp[op])])), calibrationOnly: close(calibrationOnly, m) },
      bySequence: Object.fromEntries(Object.entries(bySequence).map(([op, o]) => [op, pair(o)])),
    },
    landings: {
      definition: `latest landing event per visit and calibration; sticks with at least ${MIN_LANDINGS} releases; wide = p95 distance from the median over one lattice step (${Math.round(WEAR_SPREAD_LSB * 100) / 100} LSB); off center = median over 1.25%`,
      events: latestLanding.size,
      sticks: sticks.n,
      ...(sticks.n < m ? { suppressed: true } : {
        wideSpread: sticks.wideSpread,
        offCenterMedian: sticks.offCenterMedian,
        both: sticks.both,
        afterCalibration: sticks.afterCalibration,
        wideSpreadRate: ratio(sticks.n, sticks.wideSpread, m),
        p95SpreadLsb: { p10: q(0.1), p50: q(0.5), p90: q(0.9), max: spreads.at(-1) },
      }),
    },
  };
}

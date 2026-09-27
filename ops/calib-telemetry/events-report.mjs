// Report privato degli eventi v2 (POST /api/calib/v2/events → events-v2.jsonl).
//
// Due domande:
//   1. Si salva davvero? Per ogni calibrazione che ha cambiato la RAM del
//      controller (quick, guided, range con committed), l'evento `save` che
//      chiude il suo periodo "non salvato": salvata, e se no perché (Write
//      bloccato e motivo, flash fallito, Cancel, scollegato, pagina chiusa), o
//      nessun evento (esito ignoto: la pagina chiusa senza che il keepalive
//      arrivasse, o ancora aperta). Per tipo ed esito, per release (`app`) e
//      secondo se il blocco "Last step" è mai stato in vista (`seen`).
//   2. Quanto rumore a riposo? Distribuzioni dei riassunti `rest` per stick:
//      p95 e massimo della distanza dalla mediana, escursioni al minuto,
//      offset della mediana, cadenza dei report; per scheda e per stato
//      (prima della calibrazione, non salvata, salvata).
//
// Solo aggregati: mai un sid, un seq o un evento singolo in uscita. Ogni riga
// passa dal validatore del contratto (lo stesso del server e della pagina):
// una riga che non lo rispetta è contata e scartata, mai interpretata.
import fs from 'node:fs/promises';
import { validateEventV2 } from '../../js/telemetry-v2.js';

export const EVENTS_REPORT_SCHEMA = 'sense-calibrator.telemetry-events.v2';
export const DEFAULT_EVENTS_CONFIG = Object.freeze({ minimumCohortSize: 5, since: null });

const CALIB_TYPES = new Set(['quick', 'guided', 'range']);
const P95_BUCKETS = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 10];

const round = (value, digits = 3) => (value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits);
function quantiles(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = p => s[Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1))];
  return { n: s.length, p10: round(q(0.1)), p50: round(q(0.5)), p90: round(q(0.9)), max: round(s[s.length - 1]) };
}
function histogram(values, edges) {
  const bins = [...edges.map(e => ({ lt: e, n: 0 })), { gte: edges[edges.length - 1], n: 0 }];
  for (const v of values) {
    const i = edges.findIndex(e => v < e);
    bins[i === -1 ? bins.length - 1 : i].n += 1;
  }
  return bins;
}
const inc = (obj, key, by = 1) => { obj[key] = (obj[key] ?? 0) + by; };

// Perché un periodo non si è chiuso con un salvataggio. L'ordine conta: un
// flash tentato e fallito spiega più di un Cancel precedente.
export function saveReason(save) {
  if (!save) return 'unknown';
  if (save.result === 'saved') return 'saved';
  if (save.attempts > 0 && save.lastFlash !== 'ok') return 'flash-failed';
  if (save.lock === 'disabled') return `locked:${save.reasons.join('+') || 'unspecified'}`;
  if (save.cancels > 0) return 'cancelled';
  return save.result; // 'disconnected' | 'left'
}

function rateBlock(counts, minimum) {
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  const saved = counts.saved ?? 0;
  return { n, saved, saveRate: n >= minimum ? round(saved / n) : null, reasons: Object.fromEntries(Object.entries(counts).sort()) };
}

export function parseEventLines(text, { since = null } = {}) {
  const input = { lines: 0, blank: 0, invalidJson: 0, invalidEvent: 0, beforeCutoff: 0, accepted: 0 };
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) { input.blank += 1; continue; }
    input.lines += 1;
    let record;
    try { record = JSON.parse(line); } catch { input.invalidJson += 1; continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) { input.invalidEvent += 1; continue; }
    // Il server aggiunge solo il giorno di ricezione; tutto il resto è l'evento.
    const { receivedDay, ...event } = record;
    if (typeof receivedDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(receivedDay) || validateEventV2(event) !== null) {
      input.invalidEvent += 1;
      continue;
    }
    if (since && receivedDay < since) { input.beforeCutoff += 1; continue; }
    input.accepted += 1;
    events.push({ ...event, receivedDay });
  }
  return { input, events };
}

export function buildEventsReport(text, options = {}) {
  const config = { ...DEFAULT_EVENTS_CONFIG, ...options };
  const { input, events } = parseEventLines(text, config);
  const bySid = new Map();
  for (const e of events) {
    if (!bySid.has(e.sid)) bySid.set(e.sid, []);
    bySid.get(e.sid).push(e);
  }

  const counts = { visits: bySid.size, byType: {} };
  const calibrations = { byTypeOutcome: {}, notCommitted: {} };
  const save = { byType: {}, byTypeOutcome: {}, byApp: {}, bySeen: {}, byStart: {}, periods: { byResult: {}, byReason: {} } };
  const save2 = { opensFromBlock: 0, opensFromReminder: 0, cancels: 0, periodsWithReminderOpen: 0, periods: 0 };
  const flash = { byResult: {}, byNv: {}, byLock: {}, attempts: {} };
  const restAll = [];

  for (const list of bySid.values()) {
    list.sort((a, b) => a.seq - b.seq);
    const saves = list.filter(e => e.type === 'save');
    for (const e of list) {
      inc(counts.byType, e.type);
      if (e.type === 'flash') {
        inc(flash.byResult, e.result);
        inc(flash.byNv, e.nv ?? 'null');
        inc(flash.byLock, e.lock);
        inc(flash.attempts, String(Math.min(e.attempt, 3)) + (e.attempt >= 3 ? '+' : ''));
      } else if (e.type === 'save') {
        save2.periods += 1;
        save2.opensFromBlock += e.opens;
        save2.opensFromReminder += e.reminderOpens;
        save2.cancels += e.cancels;
        if (e.reminderOpens > 0) save2.periodsWithReminderOpen += 1;
        inc(save.periods.byResult, e.result);
        inc(save.periods.byReason, saveReason(e));
      } else if (e.type === 'rest') {
        restAll.push(e);
      } else if (CALIB_TYPES.has(e.type)) {
        const key = `${e.type}:${e.outcome}`;
        if (!e.committed) { inc(calibrations.notCommitted, key); continue; }
        inc(calibrations.byTypeOutcome, key);
        // Il periodo di questa calibrazione si chiude col primo `save` dopo di
        // lei. Se quel save punta a una calibrazione successiva, questa è
        // stata sostituita nello stesso periodo (Quick rifatto prima di
        // salvare): non conta né come salvata né come persa.
        const closing = saves.find(s => s.seq > e.seq);
        let reason;
        if (!closing) reason = 'unknown';
        else if (closing.ref === e.seq) reason = saveReason(closing);
        else if (closing.ref !== null && closing.ref > e.seq) reason = 'superseded';
        else reason = saveReason(closing);
        if (reason === 'superseded') { inc(save.byType, `${e.type}:superseded`); continue; }
        const bucket = (obj, k) => { obj[k] ??= {}; inc(obj[k], reason); };
        bucket(save.byType, e.type);
        bucket(save.byTypeOutcome, key);
        bucket(save.byApp, String(e.app));
        if (closing) bucket(save.bySeen, closing.seen ? 'seen' : 'not-seen');
        if (e.type === 'quick') bucket(save.byStart, e.start);
      }
    }
  }

  const rates = obj => Object.fromEntries(Object.entries(obj).sort()
    .map(([k, v]) => [k, typeof v === 'number' ? v : rateBlock(v, config.minimumCohortSize)]));

  const stickStats = (list, side) => {
    const s = list.map(e => e.sticks[side]);
    const perMin = (k) => list.map((e, i) => s[i].ex[k] / (e.durS / 60));
    return {
      p95Lsb: quantiles(s.map(x => x.p95)),
      maxLsb: quantiles(s.map(x => x.max)),
      p95Histogram: histogram(s.map(x => x.p95), P95_BUCKETS),
      maxHistogram: histogram(s.map(x => x.max), P95_BUCKETS),
      excursionsPerMin: { ge1: quantiles(perMin(0)), ge2: quantiles(perMin(1)), ge4: quantiles(perMin(2)) },
      offsetPct: quantiles(s.map(x => x.off)),
      spreadLsb: quantiles(s.map(x => Math.max(x.sx, x.sy))),
    };
  };
  const restBlock = list => (list.length < config.minimumCohortSize
    ? { n: list.length, suppressed: true }
    : {
      n: list.length,
      left: stickStats(list, 0),
      right: stickStats(list, 1),
      reportIntervalMs: { median: quantiles(list.map(e => e.intervalMs[0])), p95: quantiles(list.map(e => e.intervalMs[1])), max: quantiles(list.map(e => e.intervalMs[2])) },
      windowsWithGaps: list.filter(e => e.gaps > 0).length,
      discardedWindows: list.reduce((a, e) => a + e.discarded, 0),
    });
  const groupBy = (list, key) => {
    const out = {};
    for (const e of list) (out[key(e)] ??= []).push(e);
    return Object.fromEntries(Object.entries(out).sort().map(([k, v]) => [k, restBlock(v)]));
  };

  return {
    schema: EVENTS_REPORT_SCHEMA,
    config,
    input,
    counts: { visits: counts.visits, byType: Object.fromEntries(Object.entries(counts.byType).sort()) },
    calibrations: {
      committed: Object.fromEntries(Object.entries(calibrations.byTypeOutcome).sort()),
      notCommitted: Object.fromEntries(Object.entries(calibrations.notCommitted).sort()),
    },
    saving: {
      byType: rates(save.byType),
      byTypeOutcome: rates(save.byTypeOutcome),
      byApp: rates(save.byApp),
      bySaveStepSeen: rates(save.bySeen),
      byQuickStart: rates(save.byStart),
      periods: {
        n: save2.periods,
        byResult: Object.fromEntries(Object.entries(save.periods.byResult).sort()),
        byReason: Object.fromEntries(Object.entries(save.periods.byReason).sort()),
        writeDialogOpens: { fromSaveStep: save2.opensFromBlock, fromReminder: save2.opensFromReminder },
        periodsWithReminderOpen: save2.periodsWithReminderOpen,
        cancels: save2.cancels,
      },
    },
    flash: {
      byResult: Object.fromEntries(Object.entries(flash.byResult).sort()),
      byNvStatus: Object.fromEntries(Object.entries(flash.byNv).sort()),
      byLock: Object.fromEntries(Object.entries(flash.byLock).sort()),
      byAttempt: Object.fromEntries(Object.entries(flash.attempts).sort()),
    },
    restNoise: {
      all: restBlock(restAll),
      byBoard: groupBy(restAll, e => e.board ?? 'unknown'),
      byState: groupBy(restAll, e => e.state),
      byContext: groupBy(restAll, e => e.ctx),
    },
  };
}

export async function createEventsReportFromFile({ inputPath, ...options }) {
  return buildEventsReport(await fs.readFile(inputPath, 'utf8'), options);
}

export function formatEventsSummary(report) {
  const q = report.saving.byType.quick;
  const rest = report.restNoise.all;
  const pct = v => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
  return [
    `events ${report.input.accepted} (invalid ${report.input.invalidEvent + report.input.invalidJson})`,
    `visits ${report.counts.visits}`,
    `quick saved ${q ? `${q.saved}/${q.n} (${pct(q.saveRate)})` : 'n/a'}`,
    `rest windows ${rest.n}`,
    rest.suppressed ? 'noise suppressed' : `right p95 median ${rest.right.p95Lsb.p50} LSB`,
  ].join(' · ');
}

'use strict';

// Registratore diagnostico: un report da mandare allo sviluppatore quando lo
// stick torna fuori centro poco dopo una calibrazione. Puro come js/calib:
// niente DOM, niente timer, niente HID. La pagina (app.js) lo alimenta con gli
// input report e con gli eventi che già conosce, e decide quando avviarlo.
//
// Cosa contiene (contratto: ops/calib-telemetry/contract/diagnostics-v1.schema.json):
//   - eventi: connessione (scheda, versione firmware), disconnessione, stato
//     NVS, inizio di ogni operazione, risultati del test drift, gli eventi v2
//     che la pagina costruisce per Quick/Guided/Range/Write/salvataggio/riposo,
//     blocco di spegnimento messo o tolto, Restart, calibrazione non salvata;
//   - i rilasci di js/calib/landing.js (dove si ferma lo stick ogni volta);
//   - una traccia a 1 Hz della posizione per stick (mediana e spread di quel
//     secondo di report), mai i report grezzi a 250 Hz.
// Ogni tempo è in ms dall'inizio della registrazione, mai un orario. Nessun
// seriale, chiave del controller, colore, data del firmware o testo libero:
// ogni campo passa da un costruttore che tiene solo enum e numeri arrotondati,
// e il report intero dal validatore del contratto prima di uscire.

import { DRIFT_MOVE_SPREAD } from '../calib/measure.js';
import { createLandingDetector, summarizeLandings } from '../calib/landing.js';
import { EVENTS_V2_ENDPOINT, TELEMETRY_APP_BUILD, validateEventV2, validateSchema } from '../telemetry-v2.js';
import { DIAGNOSTICS_V1_SCHEMA } from './diagnostics-schema.js';

export const DIAGNOSTICS_ENDPOINT = EVENTS_V2_ENDPOINT.replace(/\/events$/, '/diagnostics');
export const DIAGNOSTICS_FORMAT = 'sense-calibrator-diagnostics';

export const DIAG_LIMITS = Object.freeze({
  maxMs: 30 * 60_000,
  maxEvents: 400,
  eventBytes: 200_000,  // gli eventi v2 Quick arrivano a ~1 KB: il tetto vero è questo
  maxLandings: 1500,
  maxTrace: 1860,
  maxBytes: 512 * 1024, // limite del corpo sul server
});

const STICK_SCALE = 127.5;
const BOARDS = new Set(['BDM-010', 'BDM-020', 'BDM-030', 'BDM-040', 'BDM-050', 'BDM-060R', 'BDM-060M', 'BDM-060X']);
const NV_STATUSES = new Set(['locked', 'unlocked', 'pending_reboot', 'unknown', 'error']);
const OPS = new Set(['drift', 'quick', 'guided', 'range', 'flash', 'restart']);

const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isNum = value => typeof value === 'number' && Number.isFinite(value);
const board = value => (BOARDS.has(value) ? value : null);
const firmware = value => (Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null);
const nvStatus = value => (NV_STATUSES.has(value) ? value : null);
const pct = value => (isNum(value) ? round(clamp(value, 0, 200), 2) : 0);
const pair = value => (Array.isArray(value) && value.length === 2 ? value.map(pct) : null);
// xy di summarizeResult (in %) → LSB con segno, 0,1.
const lsbAxes = xy => (Array.isArray(xy) && xy.length === 2 && xy.every(s => Array.isArray(s) && s.length === 2 && s.every(isNum))
  ? xy.map(s => s.map(v => round(clamp(v * STICK_SCALE / 100, -128, 128), 1)))
  : null);

// Costruttori per tipo: solo i campi del contratto, già nel loro dominio.
// Un dato che non si lascia ridurre fa scartare l'evento (null), mai passare.
const BUILDERS = {
  connect: d => ({ board: board(d.board), fw: firmware(d.fw) }),
  disconnect: () => ({}),
  nv: d => ({ nv: nvStatus(d.nv) }),
  start: d => (OPS.has(d.op) ? { op: d.op } : null),
  drift: d => {
    const res = d.res;
    const off = pair(res?.off); const noise = pair(res?.noise); const axes = lsbAxes(res?.xy);
    return off && noise && axes ? { auto: d.auto === true, off, noise, axes, unstable: d.unstable === true } : null;
  },
  // L'evento v2 è già stato costruito dai builder di telemetry-v2.js: qui
  // passa di nuovo dal suo validatore, e uno che non lo rispetta non entra.
  calib: d => (d.event && validateEventV2(d.event) === null ? { event: JSON.parse(JSON.stringify(d.event)) } : null),
  'power-cycle': d => (d.lock === 'marked' || d.lock === 'cleared' ? { lock: d.lock } : null),
  restart: d => ({ sent: d.sent === true }),
  unsaved: d => ({ on: d.on === true }),
};

function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Un secondo di report → { l: [x, y, spread], r: [...] } in LSB.
function tracePoint(xs, ys) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  return [
    round(clamp(medianOf(xs) * STICK_SCALE, -128, 128), 1),
    round(clamp(medianOf(ys) * STICK_SCALE, -128, 128), 1),
    round(clamp(Math.max(maxX - minX, maxY - minY) * STICK_SCALE, 0, 256), 1),
  ];
}

export function createDiagRecorder(options = {}) {
  const limits = { ...DIAG_LIMITS, ...(options.limits ?? {}) };
  const detector = createLandingDetector(options.landing);
  let active = false;
  let t0 = null;
  let endedAt = null;
  let stop = 'user';
  let events = [];
  let eventBytes = 0;
  let landings = [];
  let trace = [];
  let dropped = { events: 0, landings: 0, trace: 0 };
  let bucket = null; // { sec, lx, ly, rx, ry } del secondo in corso

  const rel = now => clamp(Math.round(now - t0), 0, limits.maxMs + 60_000);

  function flushBucket() {
    if (!bucket || !bucket.lx.length) { bucket = null; return null; }
    const row = {
      t: bucket.sec * 1000,
      n: Math.min(2000, bucket.lx.length),
      l: tracePoint(bucket.lx, bucket.ly),
      r: tracePoint(bucket.rx, bucket.ry),
    };
    bucket = null;
    if (trace.length >= limits.maxTrace) { dropped.trace += 1; return null; }
    trace.push(row);
    return row;
  }

  function end(now, reason) {
    if (!active) return false;
    flushBucket();
    active = false;
    endedAt = Math.min(now, t0 + limits.maxMs);
    stop = reason;
    detector.reset();
    return true;
  }

  const recorder = {
    get active() { return active; },
    get started() { return t0 !== null; },
    get events() { return events; },
    get landings() { return landings; },
    get trace() { return trace; },
    get stopReason() { return active ? null : stop; },
    limits,

    start(now) {
      active = true;
      t0 = now;
      endedAt = null;
      stop = 'user';
      events = []; eventBytes = 0; landings = []; trace = [];
      dropped = { events: 0, landings: 0, trace: 0 };
      bucket = null;
      detector.reset();
    },
    stop(now, reason = 'user') { return end(now, reason); },
    elapsed(now) {
      if (t0 === null) return 0;
      return Math.max(0, Math.min(active ? now : endedAt, t0 + limits.maxMs) - t0);
    },
    // Da chiamare anche senza report (timer della pagina): ferma la
    // registrazione allo scadere dei 30 minuti. Ritorna true se l'ha fermata.
    tick(now) {
      return active && now - t0 >= limits.maxMs ? end(now, 'time-limit') : false;
    },
    // Un input report. Ritorna { landings, row, stopped }: i rilasci chiusi da
    // questo report, la riga di traccia del secondo appena finito, e se la
    // registrazione si è fermata qui per il limite di tempo.
    push(sticks, now) {
      const out = { landings: [], row: null, stopped: false };
      if (!active || !sticks) return out;
      if (recorder.tick(now)) { out.stopped = true; return out; }
      const t = rel(now);
      for (const l of detector.push(sticks, t)) {
        if (landings.length >= limits.maxLandings) { dropped.landings += 1; continue; }
        landings.push(l);
        out.landings.push(l);
      }
      const sec = Math.floor(t / 1000);
      if (bucket && bucket.sec !== sec) out.row = flushBucket();
      bucket ??= { sec, lx: [], ly: [], rx: [], ry: [] };
      bucket.lx.push(sticks.lx); bucket.ly.push(sticks.ly);
      bucket.rx.push(sticks.rx); bucket.ry.push(sticks.ry);
      return out;
    },
    // I report si sono interrotti per un motivo noto (controller scollegato):
    // un rilascio in corso non si può più attribuire.
    gap() {
      detector.reset();
      flushBucket();
    },
    // Un evento. Ritorna l'evento registrato, o null (non attivo, tipo o dati
    // fuori contratto, tetto raggiunto).
    note(now, type, data = {}) {
      if (!active || !Object.prototype.hasOwnProperty.call(BUILDERS, type)) return null;
      const fields = BUILDERS[type](data ?? {});
      if (!fields) return null;
      const event = { t: rel(now), type, ...fields };
      const bytes = JSON.stringify(event).length + 1;
      if (events.length >= limits.maxEvents || eventBytes + bytes > limits.eventBytes) {
        dropped.events += 1;
        return null;
      }
      events.push(event);
      eventBytes += bytes;
      return event;
    },
    summary() { return summarizeLandings(landings); },
    // Il report completo, nel formato del contratto. Durante la registrazione
    // `stop` è 'recording' e la traccia non include il secondo in corso.
    report(now) {
      const p = detector.params;
      return {
        format: DIAGNOSTICS_FORMAT,
        v: 1,
        app: TELEMETRY_APP_BUILD,
        durMs: Math.round(recorder.elapsed(now)),
        stop: active ? 'recording' : stop,
        params: {
          moveSpreadPct: round(p.moveSpread * 100, 2),
          stableSpreadPct: round(p.stableSpread * 100, 2),
          holdMs: p.holdMs,
          minPeakPct: round(p.minPeak * 100, 2),
          maxLandPct: round(p.maxLand * 100, 2),
        },
        events: events.map(e => ({ ...e })),
        landings: landings.map(l => ({ ...l, landAxes: [...l.landAxes] })),
        trace: trace.map(r => ({ ...r, l: [...r.l], r: [...r.r] })),
        summary: summarizeLandings(landings),
        dropped: { ...dropped },
      };
    },
  };
  return recorder;
}

// null se il report rispetta il contratto, altrimenti il primo errore. Gli
// eventi `calib` passano anche dal contratto degli eventi v2.
export function validateDiagnostics(report) {
  const error = validateSchema(report, DIAGNOSTICS_V1_SCHEMA);
  if (error) return error;
  for (let i = 0; i < report.events.length; i++) {
    const e = report.events[i];
    if (e.type !== 'calib') continue;
    const inner = validateEventV2(e.event);
    if (inner) return `$.events[${i}].event${inner.slice(1)}`;
  }
  return null;
}

// Il JSON che parte (o si scarica): una riga, nessuno spazio.
export const diagnosticsJson = report => JSON.stringify(report);
export const diagnosticsBytes = report => new TextEncoder().encode(diagnosticsJson(report)).length;

// Campi descritti nella conferma d'invio: cosa c'è, con quanti elementi.
export function diagnosticsContents(report) {
  return {
    bytes: diagnosticsBytes(report),
    seconds: Math.round(report.durMs / 1000),
    minutes: Math.max(1, Math.round(report.durMs / 60_000)),
    events: report.events.length,
    landings: report.landings.length,
    trace: report.trace.length,
  };
}

// Invio esplicito (dopo la conferma). Un report fuori contratto o troppo
// grande non parte: lancia senza chiamare fetch. Ritorna il codice del server.
export async function uploadDiagnostics(report, options = {}) {
  const error = validateDiagnostics(report);
  if (error) throw Object.assign(new Error(`Report not valid: ${error}`), { reason: 'invalid' });
  const body = diagnosticsJson(report);
  if (new TextEncoder().encode(body).length > DIAG_LIMITS.maxBytes) {
    throw Object.assign(new Error('Report too large'), { reason: 'too-large' });
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const signal = options.signal
    ?? (globalThis.AbortSignal?.timeout ? AbortSignal.timeout(options.timeoutMs ?? 20_000) : undefined);
  const response = await fetchImpl(options.endpoint ?? DIAGNOSTICS_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { reason: 'http', status: response.status });
  const json = await response.json();
  if (!json || typeof json.code !== 'string' || !/^SC-[A-Z2-7]{8}$/.test(json.code)) {
    throw Object.assign(new Error('Unexpected reply'), { reason: 'reply' });
  }
  return json.code;
}

// Per la pagina: lo spread entro cui un secondo di traccia conta come "fermo"
// nel grafico (la soglia di movimento della pagina, in LSB).
export const TRACE_STILL_LSB = round(DRIFT_MOVE_SPREAD * STICK_SCALE, 1);

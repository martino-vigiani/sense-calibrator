'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Config
const PORT = process.env.PORT || 3040;
const DATA_PATH = process.env.DATA_PATH || '/var/lib/calib-telemetry/sessions.jsonl';
const DATA_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
// v2: eventi tipizzati in un file separato, stessa semantica append-only e
// stesso tetto. Il file v1 resta com'è, per il report v1 e le pagine in cache.
const DATA_V2_PATH = process.env.DATA_V2_PATH || '/var/lib/calib-telemetry/events-v2.jsonl';
const DATA_V2_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
const V2_BODY_LIMIT = '4kb';

const { validateEventV2 } = require('./events-v2');

// CORS
const ALLOWED_ORIGINS = new Set([
  'https://martino-vigiani.github.io',
  'http://localhost:8741',
  'http://127.0.0.1:8741',
]);

function corsHeaders(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'RateLimit-Policy, RateLimit, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After',
  );
  res.setHeader('Vary', 'Origin');
}

app.use('/api/calib/v1', (req, res, next) => {
  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    corsHeaders(res, origin);
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// v2: stesse origini e stessi header CORS di v1.
app.use('/api/calib/v2', (req, res, next) => {
  const origin = req.headers['origin'];
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    corsHeaders(res, origin);
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Rate limit: in-memory per-IP, 10 POST/min
const postRateLimit = new Map();
const POST_RATE_WINDOW_MS = 60 * 1000;
const POST_RATE_MAX = 10;
const RATE_LIMIT_MAX_KEYS = 50_000;
const RATE_LIMIT_POLICY = 'calibration-submissions';

function capMap(map) { if (map.size > RATE_LIMIT_MAX_KEYS) map.clear(); }

function getClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function checkPostRateLimit(ip) {
  capMap(postRateLimit);
  const now = Date.now();
  const hits = (postRateLimit.get(ip) || []).filter(ts => now - ts < POST_RATE_WINDOW_MS);
  const resetSeconds = hits.length === 0
    ? Math.ceil(POST_RATE_WINDOW_MS / 1000)
    : Math.max(1, Math.ceil((hits[0] + POST_RATE_WINDOW_MS - now) / 1000));
  if (hits.length >= POST_RATE_MAX) {
    return { allowed: false, remaining: 0, resetSeconds };
  }
  hits.push(now);
  postRateLimit.set(ip, hits);
  return {
    allowed: true,
    remaining: POST_RATE_MAX - hits.length,
    resetSeconds,
  };
}

function setRateLimitHeaders(res, state) {
  res.setHeader(
    'RateLimit-Policy',
    `"${RATE_LIMIT_POLICY}";q=${POST_RATE_MAX};w=${POST_RATE_WINDOW_MS / 1000}`,
  );
  res.setHeader(
    'RateLimit',
    `"${RATE_LIMIT_POLICY}";r=${state.remaining};t=${state.resetSeconds}`,
  );
  // Compatibility aliases used by clients built against earlier drafts.
  res.setHeader('RateLimit-Limit', String(POST_RATE_MAX));
  res.setHeader('RateLimit-Remaining', String(state.remaining));
  res.setHeader('RateLimit-Reset', String(state.resetSeconds));
}

function sendProblem(res, { status, code, title, detail, resolution }) {
  return res
    .status(status)
    .type('application/problem+json')
    .json({
      type: `https://subralabs.com/developers.html#${code}`,
      title,
      status,
      detail,
      code,
      resolution,
      // Kept so the existing Sense-Calibrator client remains compatible.
      error: detail,
    });
}

function sendUnsupportedMediaProblem(res) {
  return sendProblem(res, {
    status: 415,
    code: 'unsupported_media_type',
    title: 'Unsupported request encoding',
    detail: 'The request body uses a content type, charset, or content encoding that this endpoint does not support.',
    resolution: 'Send uncompressed application/json encoded as UTF-8.',
  });
}

// Apply the submission quota before parsing JSON. This makes malformed and
// oversized requests visible to clients through the same rate-limit contract,
// and prevents invalid bodies from bypassing the abuse control.
app.use('/api/calib/v1/sessions', (req, res, next) => {
  if (req.method !== 'POST') return next();

  const rateLimit = checkPostRateLimit(getClientIp(req));
  req.calibrationRateLimit = rateLimit;
  setRateLimitHeaders(res, rateLimit);
  if (rateLimit.allowed) return next();

  res.setHeader('Retry-After', String(rateLimit.resetSeconds));
  return sendProblem(res, {
    status: 429,
    code: 'rate_limit_exceeded',
    title: 'Submission rate limit exceeded',
    detail: 'No more than 10 calibration sessions can be submitted per IP address each minute.',
    resolution: `Wait ${rateLimit.resetSeconds} seconds before retrying.`,
  });
});

app.use('/api/calib/v1/sessions', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return sendUnsupportedMediaProblem(res);
  }
  next();
});

// --- v2: POST /api/calib/v2/events ---
//
// Stesso meccanismo di v1 (quota per IP in memoria, applicata PRIMA del parse
// del JSON, header RateLimit, 429 con Retry-After) su un bucket separato: gli
// eventi sono più piccoli e più numerosi di una sessione v1 (la pagina ne
// manda al massimo 60 per caricamento, in fila, e una coda di al più 24 dopo
// "Keep sharing"), e non devono consumare la quota di v1 né esserne consumati.
const eventRateLimit = new Map();
const EVENT_RATE_WINDOW_MS = 60 * 1000;
const EVENT_RATE_MAX = 30;
const EVENT_RATE_LIMIT_POLICY = 'calibration-events';

function checkEventRateLimit(ip) {
  capMap(eventRateLimit);
  const now = Date.now();
  const hits = (eventRateLimit.get(ip) || []).filter(ts => now - ts < EVENT_RATE_WINDOW_MS);
  const resetSeconds = hits.length === 0
    ? Math.ceil(EVENT_RATE_WINDOW_MS / 1000)
    : Math.max(1, Math.ceil((hits[0] + EVENT_RATE_WINDOW_MS - now) / 1000));
  if (hits.length >= EVENT_RATE_MAX) {
    return { allowed: false, remaining: 0, resetSeconds };
  }
  hits.push(now);
  eventRateLimit.set(ip, hits);
  return { allowed: true, remaining: EVENT_RATE_MAX - hits.length, resetSeconds };
}

function setEventRateLimitHeaders(res, state) {
  res.setHeader(
    'RateLimit-Policy',
    `"${EVENT_RATE_LIMIT_POLICY}";q=${EVENT_RATE_MAX};w=${EVENT_RATE_WINDOW_MS / 1000}`,
  );
  res.setHeader('RateLimit', `"${EVENT_RATE_LIMIT_POLICY}";r=${state.remaining};t=${state.resetSeconds}`);
  res.setHeader('RateLimit-Limit', String(EVENT_RATE_MAX));
  res.setHeader('RateLimit-Remaining', String(state.remaining));
  res.setHeader('RateLimit-Reset', String(state.resetSeconds));
}

app.use('/api/calib/v2/events', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const rateLimit = checkEventRateLimit(getClientIp(req));
  setEventRateLimitHeaders(res, rateLimit);
  if (rateLimit.allowed) return next();
  res.setHeader('Retry-After', String(rateLimit.resetSeconds));
  return sendProblem(res, {
    status: 429,
    code: 'rate_limit_exceeded',
    title: 'Submission rate limit exceeded',
    detail: `No more than ${EVENT_RATE_MAX} calibration events can be submitted per IP address each minute.`,
    resolution: `Wait ${rateLimit.resetSeconds} seconds before retrying.`,
  });
});

app.use('/api/calib/v2/events', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return sendUnsupportedMediaProblem(res);
  }
  next();
});

// Parser v2 prima di quello globale: limite più stretto (un evento v2 sta
// sotto 1 KB). Il parser globale salta un body già letto.
app.use('/api/calib/v2/events', express.json({ limit: V2_BODY_LIMIT }));

app.use(express.json({ limit: '8kb' }));

// Periodic cleanup of stale rate-limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of postRateLimit) {
    const fresh = hits.filter(ts => now - ts < POST_RATE_WINDOW_MS);
    if (fresh.length === 0) postRateLimit.delete(ip);
    else postRateLimit.set(ip, fresh);
  }
  for (const [ip, hits] of eventRateLimit) {
    const fresh = hits.filter(ts => now - ts < EVENT_RATE_WINDOW_MS);
    if (fresh.length === 0) eventRateLimit.delete(ip);
    else eventRateLimit.set(ip, fresh);
  }
}, 5 * 60 * 1000).unref();

// Schema validation helpers
function isFiniteInRange(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/
  );
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText,
    offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 23
    && offsetMinute <= 59;
}

function isOffNoise(v) {
  if (!Array.isArray(v) || v.length !== 2) return false;
  return isFiniteInRange(v[0], 0, 200) && isFiniteInRange(v[1], 0, 200);
}

function isCalibSlot(v) {
  if (v === null || v === undefined) return true; // null is valid
  if (typeof v !== 'object' || Array.isArray(v)) return false;
  // Must have exactly off and noise keys
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes('off') || !keys.includes('noise')) return false;
  return isOffNoise(v.off) && isOffNoise(v.noise);
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  't', 'board', 'fw', 'before', 'after', 'passes', 'unstableEvents', 'gate', 'gateOff',
]);

function validateBody(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Body must be a JSON object';
  }

  // Reject unknown top-level keys
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return `Unknown field: ${key}`;
    }
  }

  // t: RFC 3339 date-time, matching OpenAPI format: date-time.
  if (!isRfc3339DateTime(body.t)) {
    return 'Field "t" must be an RFC 3339 date-time string';
  }

  // board: string ≤ 20 chars or null
  if (body.board !== null && body.board !== undefined) {
    if (typeof body.board !== 'string' || body.board.length > 20) {
      return 'Field "board" must be a string ≤ 20 chars or null';
    }
  } else if (!('board' in body)) {
    return 'Field "board" is required';
  }

  // fw: integer or null
  if (body.fw !== null && body.fw !== undefined) {
    if (typeof body.fw !== 'number' || !Number.isInteger(body.fw)) {
      return 'Field "fw" must be an integer or null';
    }
  } else if (!('fw' in body)) {
    return 'Field "fw" is required';
  }

  // before, after: null or { off: [num,num], noise: [num,num] }
  if (!('before' in body)) return 'Field "before" is required';
  if (!isCalibSlot(body.before)) {
    return 'Field "before" must be null or { off: [num,num], noise: [num,num] } with values 0–200';
  }

  if (!('after' in body)) return 'Field "after" is required';
  if (!isCalibSlot(body.after)) {
    return 'Field "after" must be null or { off: [num,num], noise: [num,num] } with values 0–200';
  }

  // passes: array of ≤ 8 finite numbers
  if (!('passes' in body)) return 'Field "passes" is required';
  if (!Array.isArray(body.passes) || body.passes.length > 8) {
    return 'Field "passes" must be an array of ≤ 8 numbers';
  }
  for (const p of body.passes) {
    if (typeof p !== 'number' || !Number.isFinite(p)) {
      return 'Field "passes" must contain only finite numbers';
    }
  }

  // unstableEvents: integer 0–100
  if (!('unstableEvents' in body)) return 'Field "unstableEvents" is required';
  if (
    typeof body.unstableEvents !== 'number' ||
    !Number.isInteger(body.unstableEvents) ||
    body.unstableEvents < 0 ||
    body.unstableEvents > 100
  ) {
    return 'Field "unstableEvents" must be an integer 0–100';
  }

  // gate: finite number 0–1
  if (!('gate' in body)) return 'Field "gate" is required';
  if (!isFiniteInRange(body.gate, 0, 1)) {
    return 'Field "gate" must be a finite number 0–1';
  }

  // gateOff: boolean
  if (!('gateOff' in body)) return 'Field "gateOff" is required';
  if (typeof body.gateOff !== 'boolean') {
    return 'Field "gateOff" must be a boolean';
  }

  return null; // valid
}

// --- Routes ---

// POST /api/calib/v1/sessions
app.post('/api/calib/v1/sessions', (req, res) => {
  const validationError = validateBody(req.body);
  if (validationError) {
    return sendProblem(res, {
      status: 400,
      code: 'invalid_request',
      title: 'Invalid calibration session',
      detail: validationError,
      resolution: 'Correct the request body to match the schema published at /openapi.json, then retry.',
    });
  }

  // Check data file size
  try {
    const stat = fs.statSync(DATA_PATH);
    if (stat.size >= DATA_SIZE_LIMIT) {
      return sendProblem(res, {
        status: 507,
        code: 'storage_capacity_reached',
        title: 'Telemetry storage capacity reached',
        detail: 'The calibration telemetry store is temporarily at its configured capacity.',
        resolution: 'Do not retry automatically. Continue using the calibrator without telemetry.',
      });
    }
  } catch (e) {
    // File doesn't exist yet, that's fine
    if (e.code !== 'ENOENT') {
      console.error('[calib-telemetry] stat error:', e.message);
      return sendProblem(res, {
        status: 500,
        code: 'internal_error',
        title: 'Telemetry service error',
        detail: 'The service could not inspect its storage.',
        resolution: 'Do not retry immediately. Continue using the calibrator without telemetry.',
      });
    }
  }

  // Build the validated record — NEVER include IP, user-agent, or request metadata
  const record = {
    t: req.body.t,
    board: req.body.board ?? null,
    fw: req.body.fw ?? null,
    before: req.body.before ?? null,
    after: req.body.after ?? null,
    passes: req.body.passes,
    unstableEvents: req.body.unstableEvents,
    gate: req.body.gate,
    gateOff: req.body.gateOff,
    receivedAt: new Date().toISOString(),
  };

  try {
    // Ensure directory exists
    const dir = path.dirname(DATA_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(DATA_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.error('[calib-telemetry] write error:', e.message);
    return sendProblem(res, {
      status: 500,
      code: 'internal_error',
      title: 'Telemetry service error',
      detail: 'The service could not store the calibration session.',
      resolution: 'Do not retry immediately. Continue using the calibrator without telemetry.',
    });
  }

  return res.status(204).end();
});

// POST /api/calib/v2/events
//
// Un evento per richiesta, validato contro il contratto (schema chiuso: ogni
// campo obbligatorio, nessun campo sconosciuto a nessun livello, stringhe solo
// enum). Il record è l'evento così com'è più `receivedDay` (data UTC, niente
// ora): la pagina non manda orari, e il giorno basta a separare le release.
// Mai IP, user-agent, header o altri metadati della richiesta.
app.post('/api/calib/v2/events', (req, res) => {
  const validationError = validateEventV2(req.body);
  if (validationError) {
    return sendProblem(res, {
      status: 400,
      code: 'invalid_request',
      title: 'Invalid calibration event',
      detail: validationError,
      resolution: 'Correct the request body to match CalibrationEventV2 in /openapi.json, then retry.',
    });
  }

  try {
    const stat = fs.statSync(DATA_V2_PATH);
    if (stat.size >= DATA_V2_SIZE_LIMIT) {
      return sendProblem(res, {
        status: 507,
        code: 'storage_capacity_reached',
        title: 'Telemetry storage capacity reached',
        detail: 'The calibration telemetry store is temporarily at its configured capacity.',
        resolution: 'Do not retry automatically. Continue using the calibrator without telemetry.',
      });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[calib-telemetry] v2 stat error:', e.message);
      return sendProblem(res, {
        status: 500,
        code: 'internal_error',
        title: 'Telemetry service error',
        detail: 'The service could not inspect its storage.',
        resolution: 'Do not retry immediately. Continue using the calibrator without telemetry.',
      });
    }
  }

  // Copia profonda dell'evento validato: nessun riferimento al body vivo.
  const record = { ...JSON.parse(JSON.stringify(req.body)), receivedDay: new Date().toISOString().slice(0, 10) };

  try {
    fs.mkdirSync(path.dirname(DATA_V2_PATH), { recursive: true });
    fs.appendFileSync(DATA_V2_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.error('[calib-telemetry] v2 write error:', e.message);
    return sendProblem(res, {
      status: 500,
      code: 'internal_error',
      title: 'Telemetry service error',
      detail: 'The service could not store the calibration event.',
      resolution: 'Do not retry immediately. Continue using the calibrator without telemetry.',
    });
  }

  return res.status(204).end();
});

// GET /api/calib/health — public minimal
app.get('/api/calib/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET /health — full local health (not proxied by nginx)
function countLines(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n').filter(l => l.trim().length > 0).length;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[calib-telemetry] health read error:', e.message);
    }
    return 0;
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    sessionLines: countLines(DATA_PATH),
    eventV2Lines: countLines(DATA_V2_PATH),
  });
});

app.use('/api/calib', (req, res) => sendProblem(res, {
  status: 404,
  code: 'endpoint_not_found',
  title: 'Calibration API endpoint not found',
  detail: `No calibration API endpoint matches ${req.method} ${req.originalUrl}.`,
  resolution: 'Use one of the endpoints published at /openapi.json.',
}));

// Rimuove caratteri di controllo (newline compresi) e limita la lunghezza:
// anche in un errore 5xx genuino (bug nostro, non input malformato) il
// messaggio o lo stack possono incorporare contenuto lato client — non è
// solo il caso del SyntaxError di body-parser — quindi non basta fidarsi
// della sorgente dell'errore, va sempre sanificato prima di finire nel log.
function sanitizeForLog(v, maxLen = 500) {
  return String(v).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, maxLen);
}

// Route di solo test: fa transitare un errore 5xx genuino attraverso il
// global error handler qui sotto, per verificare che sanitizzi message/stack
// invece di sopprimerli come nel caso 4xx. Montata solo sotto NODE_ENV=test,
// mai in produzione.
if (process.env.NODE_ENV === 'test') {
  app.post('/__test/throw-500', (req, res, next) => {
    const err = new Error(`boom: ${req.body && req.body.injected}`);
    err.status = 500;
    next(err);
  });
}

// Global error handler
//
// Per gli errori attribuibili al client (4xx, tipicamente SyntaxError di
// body-parser su un body malformato) non logga mai err.message: quel
// messaggio incorpora una fetta letterale del corpo della richiesta, e un
// client non autenticato potrebbe iniettare newline per far sembrare log di
// servizio righe che in realtà controlla lui. type/status bastano a
// diagnosticare senza riportare input del client nel log.
//
// Per i 5xx invece il messaggio serve — è il momento in cui un bug nostro va
// diagnosticato, e il log è l'unica traccia su questa VPS — quindi si logga
// anche message e stack, ma sanificati: possono comunque portarsi dietro
// contenuto del client.
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error(
      '[unhandled]', err.type || err.name || 'error', status,
      sanitizeForLog(err.message), sanitizeForLog(err.stack)
    );
  } else {
    console.error('[unhandled]', err.type || err.name || 'error', status);
  }
  if (res.headersSent) return next(err);
  if (status === 413) {
    const limit = req.path.startsWith('/api/calib/v2/') ? '4 KB' : '8 KB';
    return sendProblem(res, {
      status: 413,
      code: 'payload_too_large',
      title: 'Calibration payload too large',
      detail: `The JSON request body exceeds the ${limit} limit.`,
      resolution: `Send only the documented calibration fields and keep the body under ${limit}.`,
    });
  }
  if (status === 415) {
    return sendUnsupportedMediaProblem(res);
  }
  if (status >= 400 && status < 500) {
    return sendProblem(res, {
      status: 400,
      code: 'invalid_request',
      title: 'Invalid JSON request',
      detail: 'The request body is not valid JSON.',
      resolution: 'Send a valid application/json object matching the schema at /openapi.json.',
    });
  }
  return sendProblem(res, {
    status: 500,
    code: 'internal_error',
    title: 'Telemetry service error',
    detail: 'The service could not process the request.',
    resolution: 'Do not retry immediately. Continue using the calibrator without telemetry.',
  });
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', () =>
    console.log(`calib-telemetry running on port ${PORT} — data: ${DATA_PATH}`)
  );
}

module.exports = { app };

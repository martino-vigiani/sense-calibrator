'use strict';

// Test del contratto v2 (POST /api/calib/v2/events).
//
// Lo schema e le fixture in contract/ sono copie byte per byte di quelli del
// sito (Sense-Calibrator/ops/calib-telemetry/contract/). Le impronte SHA-256
// qui sotto sono le stesse fissate in Sense-Calibrator/test/telemetry-v2.test.js:
// cambiare il contratto da una parte sola fa fallire l'altra. Con
// CALIB_CONTRACT_PEER=<cartella contract del sito> il test confronta anche i file.
//
// Come il test v1: app reale su porta effimera, storage su file temporanei,
// un X-Forwarded-For sintetico per test (i bucket del rate limit non hanno reset).
//
//   cd code/calib-telemetry && node --test
//   CALIB_TEST_IN_PROCESS=1 node --test  # runner dove listen() è vietato

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-telemetry-v2-test-'));
const DATA_PATH = path.join(TMP_DIR, 'sessions.jsonl');
const DATA_V2_PATH = path.join(TMP_DIR, 'events-v2.jsonl');
process.env.DATA_PATH = DATA_PATH;
process.env.DATA_V2_PATH = DATA_V2_PATH;
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const { app } = require('./server');
const { createInProcessFetch } = require('./in-process-fetch');
const { validateEventV2, SCHEMA } = require('./events-v2');
const { openapiComponentsFromSchema } = require('./contract/openapi-components');

const CONTRACT_DIR = path.join(__dirname, 'contract');
const SCHEMA_TEXT = fs.readFileSync(path.join(CONTRACT_DIR, 'events-v2.schema.json'), 'utf8');
const FIXTURES_TEXT = fs.readFileSync(path.join(CONTRACT_DIR, 'events-v2.fixtures.json'), 'utf8');
const FIXTURES = JSON.parse(FIXTURES_TEXT);
// L'openapi.json pubblicato vive nel sito subralabs.com, fuori da questo repo:
// il controllo gira solo se OPENAPI_PATH punta a una sua copia.
const OPENAPI = process.env.OPENAPI_PATH && fs.existsSync(process.env.OPENAPI_PATH)
  ? JSON.parse(fs.readFileSync(process.env.OPENAPI_PATH, 'utf8'))
  : null;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// Stessi valori in Sense-Calibrator/test/telemetry-v2.test.js.
const CONTRACT_SHA256 = {
  schema: '282796145fb4416ccd6295207226915cadce7d176b8f9530e1b75cf7d1a7ccc7',
  fixtures: '9e945ac15bdbfb61b7d6afe73a7671cae51e4794724134d3adea5af424878c78',
};

let server;
let baseUrl;
let testFetch = fetch;
let ipCounter = 0;

test.before(async () => {
  if (process.env.CALIB_TEST_IN_PROCESS === '1') {
    testFetch = createInProcessFetch(app);
    baseUrl = 'http://127.0.0.1:0';
    return;
  }
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test.beforeEach(() => {
  for (const file of [DATA_PATH, DATA_V2_PATH]) {
    try { fs.unlinkSync(file); } catch { /* ENOENT atteso */ }
  }
});

function nextIp() {
  ipCounter += 1;
  return `10.20.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

const validEvent = (type = 'quick') => structuredClone(FIXTURES.valid.find(f => f.event.type === type).event);

async function postEvent(body, { ip, headers = {}, raw = false, url = '/api/calib/v2/events' } = {}) {
  return testFetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || nextIp(), ...headers },
    body: raw ? body : JSON.stringify(body),
  });
}

async function assertProblem(response, status, code) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') || '', /^application\/problem\+json\b/);
  const problem = await response.json();
  assert.equal(problem.status, status);
  assert.equal(problem.code, code);
  assert.equal(problem.error, problem.detail);
  return problem;
}

const readLines = file => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
const exists = file => fs.existsSync(file);

async function makeLargestDiagnosticQuickEvent() {
  // Usa il vero builder del browser: il limite deve coprire il JSON che parte
  // dalla pagina, non una fixture HTTP più piccola costruita separatamente.
  const { buildQuickEvent } = await import('../../js/telemetry-v2.js');
  const largestRoundedPercent = 199.99; // sei caratteri entro il clamp 0–200
  const off = [largestRoundedPercent, largestRoundedPercent];
  const xy = [[-100, -100], [-100, -100]]; // quattro assi → -128 sul wire
  return buildQuickEvent({ sid: '1234abcd', seq: 255, board: 'BDM-060R', fw: 4294967295 }, {
    session: {
      before: { off, xy }, after: { off, xy },
      passes: Array(8).fill(largestRoundedPercent), passXY: Array(8).fill(xy),
      verification: {
        baselineNoise: off, baselineRawNoise: largestRoundedPercent,
        attempts: Array.from({ length: 16 }, (_, index) => ({
          pass: Math.floor(index / 2) + 1, attempt: index % 2 + 1,
          off, noise: off, stableFraction: 0.999, rawNoise: largestRoundedPercent,
          hold: index % 2 ? 'not-released' : 'not-required', accepted: false, criterion: 'stable-fraction',
        })),
      },
    },
    outcome: 'residual-deterministic', start: 'recovery', committed: true, needsPowerCycle: true, durMs: 3600_000,
  });
}

// --- Contratto ---

test('contratto: schema e fixture coincidono con le impronte condivise col sito', () => {
  assert.equal(sha256(SCHEMA_TEXT), CONTRACT_SHA256.schema, 'schema cambiato: copialo nel sito e aggiorna entrambe le impronte');
  assert.equal(sha256(FIXTURES_TEXT), CONTRACT_SHA256.fixtures, 'fixture cambiate: copiale nel sito e aggiorna entrambe le impronte');
  const peer = process.env.CALIB_CONTRACT_PEER;
  if (peer) {
    for (const name of ['events-v2.schema.json', 'events-v2.fixtures.json']) {
      assert.equal(fs.readFileSync(path.join(peer, name), 'utf8'), fs.readFileSync(path.join(CONTRACT_DIR, name), 'utf8'), name);
    }
  }
});

test('contratto: ogni fixture valida passa, ogni fixture invalida è respinta dal validatore', () => {
  for (const { name, event } of FIXTURES.valid) assert.equal(validateEventV2(event), null, name);
  for (const { name, event } of FIXTURES.invalid) assert.notEqual(validateEventV2(event), null, name);
});

test('contratto: una parola chiave non gestita fa lanciare il validatore', () => {
  const schema = { ...SCHEMA, $defs: { ...SCHEMA.$defs, Sid: { type: 'string', format: 'uuid' } } };
  assert.throws(() => validateEventV2(validEvent(), schema), /Unsupported schema keyword format/);
});

test('OpenAPI: le componenti pubblicate sono esattamente quelle derivate dallo schema', { skip: OPENAPI ? false : 'OPENAPI_PATH non impostato' }, () => {
  const expected = openapiComponentsFromSchema(SCHEMA);
  for (const [name, schema] of Object.entries(expected)) {
    assert.deepEqual(OPENAPI.components.schemas[name], schema, `${name}: rigenera con node contract/openapi-components.js`);
  }
  const op = OPENAPI.paths['/api/calib/v2/events'].post;
  assert.equal(op.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CalibrationEventV2');
  assert.deepEqual(Object.keys(op.responses).sort(), ['204', '400', '413', '415', '429', '500', '507']);
  assert.match(OPENAPI.components.headers.EventsRateLimitPolicy.schema.example, /q=30;w=60/);
  // v1 documentato com'era
  assert.equal(OPENAPI.paths['/api/calib/v1/sessions'].post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/CalibrationSession');
});

// --- HTTP ---

test('HTTP accepts and stores the browser diagnostic Quick payload with sixteen attempts within 4 KiB', async () => {
  // Regressione contratto: il servizio precedente respingeva `verification`
  // come proprietà ignota, anche se il vero payload restava sotto 4 KiB.
  const event = await makeLargestDiagnosticQuickEvent();
  const body = JSON.stringify(event);
  assert.equal(event.verification.attempts.length, 16);
  assert.ok(Buffer.byteLength(body, 'utf8') < 4 * 1024);

  const response = await postEvent(body, { raw: true });

  assert.equal(response.status, 204);
  const records = readLines(DATA_V2_PATH).map(line => JSON.parse(line));
  assert.equal(records.length, 1);
  const { receivedDay, ...storedEvent } = records[0];
  assert.match(receivedDay, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(storedEvent, event, 'all sixteen diagnostic measurements reach storage intact');
  assert.equal(exists(DATA_PATH), false, 'the diagnostic event never writes the v1 file');
});

test('HTTP accepts a valid JSON body of exactly 4096 UTF-8 bytes', async () => {
  const event = validEvent();
  const json = JSON.stringify(event);
  const body = json + ' '.repeat(4 * 1024 - Buffer.byteLength(json, 'utf8'));
  assert.equal(Buffer.byteLength(body, 'utf8'), 4096);

  const response = await postEvent(body, { raw: true });

  assert.equal(response.status, 204);
  assert.equal(readLines(DATA_V2_PATH).length, 1);
});

test('HTTP rejects a valid JSON body of 4097 UTF-8 bytes without writing either event log', async () => {
  const json = JSON.stringify(validEvent());
  const body = json + ' '.repeat(4 * 1024 + 1 - Buffer.byteLength(json, 'utf8'));
  assert.equal(Buffer.byteLength(body, 'utf8'), 4097);

  const response = await postEvent(body, { raw: true });

  await assertProblem(response, 413, 'payload_too_large');
  assert.equal(exists(DATA_V2_PATH), false);
  assert.equal(exists(DATA_PATH), false);
});

test('ogni fixture valida → 204 e una riga: l\'evento così com\'è più il giorno di ricezione', async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const { name, event } of FIXTURES.valid) {
    const res = await postEvent(event);
    assert.equal(res.status, 204, name);
  }
  const records = readLines(DATA_V2_PATH).map(l => JSON.parse(l));
  assert.equal(records.length, FIXTURES.valid.length);
  records.forEach((record, i) => {
    const { receivedDay, ...event } = record;
    assert.deepEqual(event, FIXTURES.valid[i].event);
    assert.equal(receivedDay, today);
    assert.equal(Object.keys(record).at(-1), 'receivedDay');
  });
  assert.equal(exists(DATA_PATH), false, 'v2 never writes the v1 file');
});

test('ogni fixture invalida → 400 invalid_request, nessuna scrittura', async () => {
  for (const { name, event } of FIXTURES.invalid) {
    const res = await postEvent(event);
    const problem = await assertProblem(res, 400, 'invalid_request');
    assert.equal(typeof problem.detail, 'string', name);
  }
  assert.equal(exists(DATA_V2_PATH), false);
});

test('una chiave __proto__ è un campo sconosciuto, non un prototipo', async () => {
  const body = JSON.stringify(validEvent()).replace(/^\{/, '{"__proto__":{"polluted":1},');
  await assertProblem(await postEvent(body, { raw: true }), 400, 'invalid_request');
  assert.equal({}.polluted, undefined);
});

test('privacy: IP, User-Agent e header della richiesta non finiscono mai nel JSONL v2', async () => {
  const res = await postEvent(validEvent('rest'), {
    ip: '203.0.113.77',
    headers: { 'User-Agent': 'Mozilla/5.0 SecretBrowser/9.9', Referer: 'https://example.test/page', Origin: 'https://martino-vigiani.github.io' },
  });
  assert.equal(res.status, 204);
  const text = fs.readFileSync(DATA_V2_PATH, 'utf8');
  for (const needle of ['203.0.113.77', 'SecretBrowser', 'example.test', 'github.io', 'receivedAt', 'T']) {
    if (needle === 'T') assert.doesNotMatch(text, /"receivedDay":"[^"]*T/, 'day only, no time');
    else assert.ok(!text.includes(needle), needle);
  }
});

test('v1 e v2 restano separati: file, contratti e bucket del rate limit', async () => {
  const ip = nextIp();
  const v1 = {
    t: '2026-07-20T10:00:00.000Z', board: 'v1.2', fw: 3,
    before: { off: [10, 20], noise: [5, 8] }, after: { off: [1, 2], noise: [1, 1] },
    passes: [1.1], unstableEvents: 0, gate: 0.5, gateOff: false,
  };
  assert.equal((await postEvent(v1, { ip, url: '/api/calib/v1/sessions' })).status, 204);
  await assertProblem(await postEvent(validEvent(), { ip, url: '/api/calib/v1/sessions' }), 400, 'invalid_request');
  await assertProblem(await postEvent(v1, { ip }), 400, 'invalid_request');
  assert.equal(readLines(DATA_PATH).length, 1);
  assert.equal(exists(DATA_V2_PATH), false);
  // esaurito il bucket v2, v1 dallo stesso IP passa ancora
  for (let i = 0; i < 30; i++) await postEvent(validEvent('flash'), { ip });
  await assertProblem(await postEvent(validEvent('flash'), { ip }), 429, 'rate_limit_exceeded');
  assert.equal((await postEvent(v1, { ip, url: '/api/calib/v1/sessions' })).status, 204);
});

test('rate limit v2: 30 per minuto per IP, poi 429 con Retry-After e header della policy', async () => {
  const ip = nextIp();
  let last;
  for (let i = 0; i < 30; i++) {
    last = await postEvent(validEvent('save'), { ip });
    assert.equal(last.status, 204, `request ${i + 1}`);
  }
  assert.equal(last.headers.get('ratelimit-policy'), '"calibration-events";q=30;w=60');
  assert.match(last.headers.get('ratelimit'), /^"calibration-events";r=0;t=\d+$/);
  const res = await postEvent(validEvent('save'), { ip });
  const problem = await assertProblem(res, 429, 'rate_limit_exceeded');
  assert.match(problem.detail, /30 calibration events/);
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
  // anche un body malformato consuma la quota (quota prima del parse, come v1)
  await assertProblem(await postEvent('{', { ip, raw: true }), 429, 'rate_limit_exceeded');
  assert.equal(readLines(DATA_V2_PATH).length, 30);
});

test('CORS v2: le origini di v1, con preflight e header di rate limit leggibili', async () => {
  const pre = await testFetch(`${baseUrl}/api/calib/v2/events`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://martino-vigiani.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://martino-vigiani.github.io');
  assert.match(pre.headers.get('access-control-allow-headers'), /Content-Type/i);
  assert.match(pre.headers.get('access-control-expose-headers'), /RateLimit/);
  const other = await postEvent(validEvent(), { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.status, 204, 'CORS is not authentication: the server still accepts a valid event');
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('media type, JSON malformato e body oltre 4 KB', async () => {
  await assertProblem(await postEvent(JSON.stringify(validEvent()), { raw: true, headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
  await assertProblem(await postEvent('{"v":2,', { raw: true }), 400, 'invalid_request');
  const big = { ...validEvent(), pad: 'x'.repeat(5000) };
  const problem = await assertProblem(await postEvent(big), 413, 'payload_too_large');
  assert.match(problem.detail, /4 KB/);
  assert.equal(exists(DATA_V2_PATH), false);
});

test('safety valve v2: file al limite (50MB) → 507, nessuna scrittura; il file v1 non conta', async () => {
  fs.writeFileSync(DATA_V2_PATH, '');
  fs.truncateSync(DATA_V2_PATH, 50 * 1024 * 1024);
  await assertProblem(await postEvent(validEvent()), 507, 'storage_capacity_reached');
  assert.equal(fs.statSync(DATA_V2_PATH).size, 50 * 1024 * 1024);
  fs.unlinkSync(DATA_V2_PATH);
  fs.writeFileSync(DATA_PATH, '');
  fs.truncateSync(DATA_PATH, 50 * 1024 * 1024);
  assert.equal((await postEvent(validEvent())).status, 204);
});

test('GET sulla rotta v2 → problema 404, non HTML', async () => {
  const res = await testFetch(`${baseUrl}/api/calib/v2/events`);
  await assertProblem(res, 404, 'endpoint_not_found');
});

test('/health locale riporta anche le righe v2', async () => {
  await postEvent(validEvent());
  await postEvent(validEvent('rest'));
  const body = await (await testFetch(`${baseUrl}/health`)).json();
  assert.equal(body.eventV2Lines, 2);
  assert.equal(body.sessionLines, 0);
});

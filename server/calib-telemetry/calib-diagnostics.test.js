'use strict';

// Test dei report diagnostici (POST /api/calib/v2/diagnostics).
//
// Lo schema e le fixture in contract/ sono copie byte per byte di quelli del
// sito (ops/calib-telemetry/contract/diagnostics-v1.*). Le impronte SHA-256 qui
// sotto sono le stesse fissate in test/diag-contract.test.js: cambiare il
// contratto da una parte sola fa fallire l'altra. Con CALIB_CONTRACT_PEER=<cartella
// contract del sito> il test confronta anche i file.
//
// Come il test v2: app reale su porta effimera, storage in una cartella
// temporanea, un X-Forwarded-For sintetico per test (il bucket orario non ha reset).
//
//   node --test
//   CALIB_TEST_IN_PROCESS=1 node --test  # runner dove listen() è vietato

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-diagnostics-test-'));
const DATA_PATH = path.join(TMP_DIR, 'sessions.jsonl');
const DATA_V2_PATH = path.join(TMP_DIR, 'events-v2.jsonl');
const DIAG_DIR = path.join(TMP_DIR, 'diagnostics');
process.env.DATA_PATH = DATA_PATH;
process.env.DATA_V2_PATH = DATA_V2_PATH;
delete process.env.DIAG_DIR; // il default deve stare accanto ai JSONL
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const { app, cleanupDiagnostics, DIAG_DIR: SERVER_DIAG_DIR } = require('./server');
const { createInProcessFetch } = require('./in-process-fetch');
const { validateDiagnostics, newCode, DIAGNOSTICS_SCHEMA } = require('./diagnostics');
const { NAMING, openapiComponentsFromSchema } = require('./contract/openapi-components');

const CONTRACT_DIR = path.join(__dirname, 'contract');
const SCHEMA_TEXT = fs.readFileSync(path.join(CONTRACT_DIR, 'diagnostics-v1.schema.json'), 'utf8');
const FIXTURES_TEXT = fs.readFileSync(path.join(CONTRACT_DIR, 'diagnostics-v1.fixtures.json'), 'utf8');
const FIXTURES = JSON.parse(FIXTURES_TEXT);
const OPENAPI = process.env.OPENAPI_PATH && fs.existsSync(process.env.OPENAPI_PATH)
  ? JSON.parse(fs.readFileSync(process.env.OPENAPI_PATH, 'utf8'))
  : null;
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

// Stessi valori in test/diag-contract.test.js.
const CONTRACT_SHA256 = {
  schema: '0f829930cddb647ae4d16ae37670232d68f8551ed5fce9a51f664274ac01c9e5',
  fixtures: 'cb5776792363f132a7c0752d4403415d3c3349df819d32b82d291427b2d7caea',
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
  fs.rmSync(DIAG_DIR, { recursive: true, force: true });
  for (const file of [DATA_PATH, DATA_V2_PATH]) {
    try { fs.unlinkSync(file); } catch { /* ENOENT atteso */ }
  }
  // Il server tiene i totali della cartella in memoria: dopo averla svuotata
  // da fuori li si ricalcola come fa la pulizia quotidiana.
  cleanupDiagnostics();
});

function nextIp() {
  ipCounter += 1;
  return `10.30.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

const validReport = (i = 0) => structuredClone(FIXTURES.valid[i].report);

async function postReport(body, { ip, headers = {}, raw = false } = {}) {
  return testFetch(`${baseUrl}/api/calib/v2/diagnostics`, {
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

const reports = () => (fs.existsSync(DIAG_DIR) ? fs.readdirSync(DIAG_DIR).sort() : []);

// Il report più grande che la pagina può produrre: ogni tetto del registratore
// raggiunto con i valori più lunghi. Usa il vero registratore del browser.
async function makeLargestReport() {
  const { createDiagRecorder, DIAG_LIMITS } = await import('../../js/diag/recorder.js');
  const v2 = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, 'events-v2.fixtures.json'), 'utf8'));
  const quick = v2.valid.filter(f => f.event.type === 'quick').map(f => f.event)
    .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
  const r = createDiagRecorder();
  r.start(0);
  // Eventi fino al tetto in byte, con l'evento v2 più lungo delle fixture.
  for (let i = 0; i < DIAG_LIMITS.maxEvents + 10; i++) r.note(1_799_000, 'calib', { event: quick });
  const report = r.report(DIAG_LIMITS.maxMs);
  const landing = { t: 1_799_999, stick: 'right', peak: 141.4, landAxes: [-127.4, -127.4], landPct: 141.29, settleMs: 59_999 };
  report.landings = Array.from({ length: DIAG_LIMITS.maxLandings }, () => ({ ...landing, landAxes: [...landing.landAxes] }));
  report.trace = Array.from({ length: DIAG_LIMITS.maxTrace }, (_, i) => ({
    t: Math.min(1_859_000, i * 1000), n: 1999, l: [-127.4, -127.4, 254.9], r: [-127.4, -127.4, 254.9],
  }));
  report.durMs = DIAG_LIMITS.maxMs;
  report.stop = 'time-limit';
  report.dropped = { events: 99_999, landings: 99_999, trace: 99_999 };
  return report;
}

// --- Contratto ---

test('contratto: schema e fixture coincidono con le impronte condivise col sito', () => {
  assert.equal(sha256(SCHEMA_TEXT), CONTRACT_SHA256.schema, 'schema cambiato: copialo nel sito e aggiorna entrambe le impronte');
  assert.equal(sha256(FIXTURES_TEXT), CONTRACT_SHA256.fixtures, 'fixture cambiate: copiale nel sito e aggiorna entrambe le impronte');
  const peer = process.env.CALIB_CONTRACT_PEER;
  if (peer) {
    for (const name of ['diagnostics-v1.schema.json', 'diagnostics-v1.fixtures.json']) {
      assert.equal(fs.readFileSync(path.join(peer, name), 'utf8'), fs.readFileSync(path.join(CONTRACT_DIR, name), 'utf8'), name);
    }
  }
});

test('contratto: ogni fixture valida passa, ogni fixture invalida è respinta', () => {
  assert.ok(FIXTURES.valid.length >= 3 && FIXTURES.invalid.length >= 20);
  for (const { name, report } of FIXTURES.valid) assert.equal(validateDiagnostics(report), null, name);
  for (const { name, report } of FIXTURES.invalid) assert.notEqual(validateDiagnostics(report), null, name);
});

test('contratto: una parola chiave non gestita fa lanciare il validatore', () => {
  const { validateSchema } = require('./events-v2');
  const schema = { ...DIAGNOSTICS_SCHEMA, $defs: { ...DIAGNOSTICS_SCHEMA.$defs, Ms: { type: 'integer', format: 'int32' } } };
  assert.throws(() => validateSchema(validReport(), schema), /Unsupported schema keyword format/);
});

test('contratto: il report più grande che la pagina produce sta sotto 512 KB ed è valido', async () => {
  const report = await makeLargestReport();
  assert.equal(validateDiagnostics(report), null);
  const bytes = Buffer.byteLength(JSON.stringify(report), 'utf8');
  assert.ok(bytes < 512 * 1024, `${bytes} bytes`);
});

test('OpenAPI: le componenti pubblicate del report sono quelle derivate dallo schema', { skip: OPENAPI ? false : 'OPENAPI_PATH non impostato' }, () => {
  const expected = openapiComponentsFromSchema(DIAGNOSTICS_SCHEMA, NAMING.diagnostics);
  for (const [name, schema] of Object.entries(expected)) {
    assert.deepEqual(OPENAPI.components.schemas[name], schema, `${name}: rigenera con node contract/openapi-components.js`);
  }
});

test('codici: SC- più 8 caratteri base32, casuali', () => {
  const codes = new Set(Array.from({ length: 2000 }, newCode));
  assert.equal(codes.size, 2000);
  for (const code of codes) assert.match(code, /^SC-[A-Z2-7]{8}$/);
});

// --- HTTP ---

test('ogni fixture valida → 201 { code } e un file 600 in una cartella 700: il report più il giorno', async () => {
  assert.equal(SERVER_DIAG_DIR, DIAG_DIR, 'default: diagnostics/ next to the v2 JSONL');
  const today = new Date().toISOString().slice(0, 10);
  const codes = [];
  for (const { name, report } of FIXTURES.valid) {
    const res = await postReport(report);
    assert.equal(res.status, 201, name);
    assert.match(res.headers.get('content-type') || '', /^application\/json\b/);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['code']);
    assert.match(body.code, /^SC-[A-Z2-7]{8}$/);
    codes.push(body.code);
  }
  assert.deepEqual(reports(), codes.map(c => `${c}.json`).sort());
  assert.equal(fs.statSync(DIAG_DIR).mode & 0o777, 0o700);
  codes.forEach((code, i) => {
    const file = path.join(DIAG_DIR, `${code}.json`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const { receivedDay, ...report } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(report, FIXTURES.valid[i].report);
    assert.equal(receivedDay, today);
  });
  assert.equal(fs.existsSync(DATA_V2_PATH), false, 'a report never writes the events log');
});

test('una cartella esistente con permessi larghi viene ristretta a 700', async () => {
  fs.mkdirSync(DIAG_DIR, { mode: 0o755 });
  fs.chmodSync(DIAG_DIR, 0o755);
  assert.equal((await postReport(validReport())).status, 201);
  assert.equal(fs.statSync(DIAG_DIR).mode & 0o777, 0o700);
});

test('ogni fixture invalida → 400 invalid_request, nessun file', async () => {
  for (const { name, report } of FIXTURES.invalid) {
    const problem = await assertProblem(await postReport(report, { ip: nextIp() }), 400, 'invalid_request');
    assert.equal(typeof problem.detail, 'string', name);
  }
  assert.deepEqual(reports(), []);
});

test('privacy: IP, User-Agent e header non finiscono mai nel file', async () => {
  const res = await postReport(validReport(), {
    ip: '203.0.113.88',
    headers: { 'User-Agent': 'Mozilla/5.0 SecretBrowser/9.9', Referer: 'https://example.test/page', Origin: 'https://martino-vigiani.github.io' },
  });
  assert.equal(res.status, 201);
  const [file] = reports();
  const text = fs.readFileSync(path.join(DIAG_DIR, file), 'utf8');
  for (const needle of ['203.0.113.88', 'SecretBrowser', 'example.test', 'github.io', 'receivedAt']) assert.ok(!text.includes(needle), needle);
  assert.doesNotMatch(text, /"receivedDay":"[^"]*T/, 'day only, no time');
});

test('il report più grande della pagina passa; oltre 512 KB → 413 senza scrivere', async () => {
  const largest = await makeLargestReport();
  assert.equal((await postReport(largest)).status, 201);
  fs.rmSync(DIAG_DIR, { recursive: true, force: true });
  const json = JSON.stringify(validReport());
  const over = json + ' '.repeat(512 * 1024 + 1 - Buffer.byteLength(json));
  const problem = await assertProblem(await postReport(over, { raw: true }), 413, 'payload_too_large');
  assert.match(problem.detail, /512 KB/);
  assert.deepEqual(reports(), []);
  // Il parser globale resta a 8 KB e gli eventi v2 a 4 KB.
  const v2 = await testFetch(`${baseUrl}/api/calib/v2/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() }, body: JSON.stringify({ pad: 'x'.repeat(5000) }),
  });
  assert.match((await assertProblem(v2, 413, 'payload_too_large')).detail, /4 KB/);
});

test('rate limit: 3 report all\'ora per IP, poi 429 con Retry-After; bucket separato dagli eventi', async () => {
  const ip = nextIp();
  let last;
  for (let i = 0; i < 3; i++) {
    last = await postReport(validReport(), { ip });
    assert.equal(last.status, 201, `request ${i + 1}`);
  }
  assert.equal(last.headers.get('ratelimit-policy'), '"calibration-diagnostics";q=3;w=3600');
  assert.match(last.headers.get('ratelimit'), /^"calibration-diagnostics";r=0;t=\d+$/);
  const res = await postReport(validReport(), { ip });
  const problem = await assertProblem(res, 429, 'rate_limit_exceeded');
  assert.match(problem.detail, /3 diagnostic reports/);
  assert.ok(Number(res.headers.get('retry-after')) > 3000);
  // la quota scatta prima del parse: anche un body malformato è respinto con 429
  await assertProblem(await postReport('{', { ip, raw: true }), 429, 'rate_limit_exceeded');
  assert.equal(reports().length, 3);
  // un altro IP passa, e lo stesso IP può ancora mandare eventi v2
  assert.equal((await postReport(validReport())).status, 201);
  const v2 = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, 'events-v2.fixtures.json'), 'utf8')).valid[0].event;
  const ev = await testFetch(`${baseUrl}/api/calib/v2/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(v2),
  });
  assert.equal(ev.status, 204);
});

test('CORS: le stesse origini degli altri endpoint v2, con preflight', async () => {
  const pre = await testFetch(`${baseUrl}/api/calib/v2/diagnostics`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://martino-vigiani.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://martino-vigiani.github.io');
  assert.match(pre.headers.get('access-control-expose-headers'), /RateLimit/);
  const other = await postReport(validReport(), { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.status, 201);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('media type e JSON malformato', async () => {
  await assertProblem(await postReport(JSON.stringify(validReport()), { raw: true, headers: { 'Content-Type': 'text/plain' } }), 415, 'unsupported_media_type');
  await assertProblem(await postReport('{"format":', { raw: true }), 400, 'invalid_request');
  assert.deepEqual(reports(), []);
});

test('tetto della cartella (200 MB) → 507, nessuna scrittura', async () => {
  fs.mkdirSync(DIAG_DIR, { recursive: true, mode: 0o700 });
  const filler = path.join(DIAG_DIR, 'SC-AAAAAAAA.json');
  fs.writeFileSync(filler, '');
  fs.truncateSync(filler, 200 * 1024 * 1024);
  cleanupDiagnostics(); // il server la vede all'avvio o alla pulizia quotidiana
  await assertProblem(await postReport(validReport()), 507, 'storage_capacity_reached');
  assert.deepEqual(reports(), ['SC-AAAAAAAA.json']);
});

test('conservazione: i report oltre 180 giorni si cancellano, gli altri file restano', async () => {
  assert.equal((await postReport(validReport())).status, 201);
  const [fresh] = reports();
  const old = path.join(DIAG_DIR, 'SC-BBBBBBBB.json');
  const foreign = path.join(DIAG_DIR, 'notes.txt');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(foreign, 'keep');
  const past = (Date.now() - 181 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, past, past);
  fs.utimesSync(foreign, past, past);
  assert.equal(cleanupDiagnostics(), 1);
  assert.deepEqual(reports(), [fresh, 'notes.txt'].sort());
  // Senza cartella non fallisce.
  fs.rmSync(DIAG_DIR, { recursive: true, force: true });
  assert.equal(cleanupDiagnostics(), 0);
});

test('privacy: il mtime del file è la mezzanotte UTC del giorno di ricezione, e la pulizia a 180 giorni lo usa', async () => {
  const before = Date.now();
  assert.equal((await postReport(validReport())).status, 201);
  const [name] = reports();
  const file = path.join(DIAG_DIR, name);
  const midnight = Math.floor(before / 86_400_000) * 86_400_000;
  const stat = fs.statSync(file);
  assert.equal(stat.mtimeMs, midnight, 'no time of receipt in the mtime');
  assert.equal(stat.atimeMs, midnight);
  assert.equal(stat.mode & 0o777, 0o600);
  const DAY = 86_400_000;
  assert.equal(cleanupDiagnostics(midnight + 180 * DAY), 0, 'kept for 180 days');
  assert.deepEqual(reports(), [name]);
  assert.equal(cleanupDiagnostics(midnight + 180 * DAY + 1), 1, 'deleted after');
  assert.deepEqual(reports(), []);
});

test('POST e /health non scandiscono la cartella: totali in memoria', async () => {
  assert.equal((await postReport(validReport())).status, 201);
  const originalReaddir = fs.readdirSync;
  const originalStat = fs.statSync;
  const calls = [];
  fs.readdirSync = (...args) => { calls.push(['readdir', String(args[0])]); return originalReaddir(...args); };
  fs.statSync = (...args) => { calls.push(['stat', String(args[0])]); return originalStat(...args); };
  try {
    assert.equal((await postReport(validReport(1))).status, 201);
    const body = await (await testFetch(`${baseUrl}/health`)).json();
    assert.equal(body.diagnosticReports, 2);
  } finally {
    fs.readdirSync = originalReaddir;
    fs.statSync = originalStat;
  }
  assert.deepEqual(calls.filter(([, p]) => p.startsWith(DIAG_DIR)), []);
});

test('GET sulla rotta → problema 404, non HTML', async () => {
  await assertProblem(await testFetch(`${baseUrl}/api/calib/v2/diagnostics`), 404, 'endpoint_not_found');
});

test('/health locale conta i report', async () => {
  let body = await (await testFetch(`${baseUrl}/health`)).json();
  assert.equal(body.diagnosticReports, 0);
  await postReport(validReport());
  await postReport(validReport(1));
  body = await (await testFetch(`${baseUrl}/health`)).json();
  assert.equal(body.diagnosticReports, 2);
  // /api/calib/health resta minimale
  assert.deepEqual(await (await testFetch(`${baseUrl}/api/calib/health`)).json(), { status: 'ok' });
});

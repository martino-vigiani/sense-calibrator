'use strict';

// Test di integrazione per calib-telemetry.
// Avvia l'app Express reale su una porta effimera, con lo storage JSONL su un file
// temporaneo (DATA_PATH), così nessuna corsa tocca /var/lib/calib-telemetry.
//
//   cd code/calib-telemetry && node --test
//   CALIB_TEST_IN_PROCESS=1 node --test  # runner dove listen() è vietato
//
// NB: DATA_PATH è una const letta una sola volta al require('./server'), quindi va
// impostata PRIMA del require e resta fissa per tutto il file: ogni test isola le
// proprie scritture ripulendo il file in beforeEach, non usando path diversi.
//
// Rate limit: il servizio non espone un seam di reset (a differenza di newsletter),
// quindi ogni test che fa POST usa un X-Forwarded-For sintetico distinto per non
// condividere il bucket 10/min con gli altri test. `app.set('trust proxy', 'loopback')`
// in server.js fa sì che, connettendosi da 127.0.0.1, l'header X-Forwarded-For diventi
// req.ip — lo stesso meccanismo usato dal test di privacy per verificare la non-persistenza.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-telemetry-test-'));
const DATA_PATH = path.join(TMP_DIR, 'sessions.jsonl');
process.env.DATA_PATH = DATA_PATH;
process.env.PORT = '0';
// Monta /__test/throw-500 (solo sotto questo env, mai in produzione): serve
// al test del 5xx genuino più sotto, per passare dallo stesso global error
// handler di produzione con un errore che non è un body malformato.
process.env.NODE_ENV = 'test';

const { app } = require('./server');
const { createInProcessFetch } = require('./in-process-fetch');

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
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

test.beforeEach(() => {
  // Ogni test riparte da nessun file: mirror del comportamento a freddo in produzione
  // (server.js gestisce ENOENT sia in stat che in read) e isolamento fra i test.
  try { fs.unlinkSync(DATA_PATH); } catch { /* noop, ENOENT atteso */ }
});

// --- Helpers ---

// IP sintetico univoco per test: evita che i bucket rate-limit (keyed per IP,
// nessun reset esposto) si contaminino fra test indipendenti.
function nextIp() {
  ipCounter += 1;
  return `10.10.${(ipCounter >> 8) & 0xff}.${ipCounter & 0xff}`;
}

function validSession(overrides = {}) {
  return {
    t: '2026-07-20T10:00:00.000Z',
    board: 'v1.2',
    fw: 3,
    before: { off: [10, 20], noise: [5, 8] },
    after: { off: [1, 2], noise: [1, 1] },
    passes: [1.1, 2.2, 3.3],
    unstableEvents: 2,
    gate: 0.5,
    gateOff: false,
    ...overrides,
  };
}

async function postSession(body, { ip, headers = {}, raw = false } = {}) {
  return testFetch(`${baseUrl}/api/calib/v1/sessions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || nextIp(),
      ...headers,
    },
    body: raw ? body : JSON.stringify(body),
  });
}

async function assertProblem(response, expectedStatus, expectedCode) {
  assert.equal(response.status, expectedStatus);
  assert.match(response.headers.get('content-type') || '', /^application\/problem\+json\b/);
  const problem = await response.json();
  assert.equal(problem.status, expectedStatus);
  assert.equal(problem.code, expectedCode);
  assert.equal(typeof problem.type, 'string');
  assert.equal(typeof problem.title, 'string');
  assert.equal(typeof problem.detail, 'string');
  assert.equal(typeof problem.resolution, 'string');
  // Compatibilità con il client esistente, che leggeva `error`.
  assert.equal(problem.error, problem.detail);
  return problem;
}

function readLines() {
  const content = fs.readFileSync(DATA_PATH, 'utf8');
  return content.split('\n').filter((l) => l.trim().length > 0);
}

function readRecords() {
  return readLines().map((l) => JSON.parse(l));
}

// --- Schema validation: happy path ---

test('sessione valida → 204 e riga JSONL con i soli campi attesi', async () => {
  const body = validSession();
  const res = await postSession(body);
  assert.equal(res.status, 204);

  const records = readRecords();
  assert.equal(records.length, 1);
  const record = records[0];
  assert.deepEqual(Object.keys(record).sort(), [
    'after', 'before', 'board', 'fw', 'gate', 'gateOff',
    'passes', 'receivedAt', 't', 'unstableEvents',
  ]);
  assert.equal(record.t, body.t);
  assert.equal(record.board, body.board);
  assert.deepEqual(record.before, body.before);
  assert.deepEqual(record.passes, body.passes);
  assert.ok(!isNaN(Date.parse(record.receivedAt)), 'receivedAt deve essere un timestamp valido');
});

test('timestamp RFC 3339 con offset → 204 e valore preservato', async () => {
  const timestamp = '2026-09-09T12:00:00+02:00';
  const res = await postSession(validSession({ t: timestamp }));
  assert.equal(res.status, 204);
  assert.equal(readRecords()[0].t, timestamp);
});

test('before/after null sono validi (nessuna calibrazione registrata)', async () => {
  const res = await postSession(validSession({ before: null, after: null }));
  assert.equal(res.status, 204);
  const [record] = readRecords();
  assert.equal(record.before, null);
  assert.equal(record.after, null);
});

test('board/fw null sono validi', async () => {
  const res = await postSession(validSession({ board: null, fw: null }));
  assert.equal(res.status, 204);
  const [record] = readRecords();
  assert.equal(record.board, null);
  assert.equal(record.fw, null);
});

test('CORS rende leggibili al client browser gli header di rate limit', async () => {
  const res = await postSession(validSession(), {
    headers: { Origin: 'https://martino-vigiani.github.io' },
  });
  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get('access-control-allow-origin'),
    'https://martino-vigiani.github.io',
  );
  const exposed = res.headers.get('access-control-expose-headers') || '';
  for (const header of ['RateLimit-Policy', 'RateLimit', 'Retry-After']) {
    assert.ok(exposed.split(/,\s*/).includes(header), `${header} deve essere esposto via CORS`);
  }
});

// --- Schema validation: rigetti, tabella di mutazioni ---

const invalidPayloads = [
  ['body è una stringa JSON, non un oggetto', '"just a string"', true],
  ['body è un array JSON', '[1,2,3]', true],
  ['body è null', 'null', true],
  ['body è un numero', '42', true],
  ['campo "board" mancante', JSON.stringify(withoutKey(validSession(), 'board'))],
  ['campo "fw" mancante', JSON.stringify(withoutKey(validSession(), 'fw'))],
  ['campo "before" mancante', JSON.stringify(withoutKey(validSession(), 'before'))],
  ['campo "passes" mancante', JSON.stringify(withoutKey(validSession(), 'passes'))],
  ['campo "gate" mancante', JSON.stringify(withoutKey(validSession(), 'gate'))],
  ['campo "gateOff" mancante', JSON.stringify(withoutKey(validSession(), 'gateOff'))],
  ['campo extra sconosciuto', JSON.stringify(validSession({ extra: 'nope' }))],
  ['"t" non è RFC 3339', JSON.stringify(validSession({ t: 'not-a-date' }))],
  ['"t" contiene solo la data', JSON.stringify(validSession({ t: '2026-09-09' }))],
  ['"t" usa un formato locale ambiguo', JSON.stringify(validSession({ t: '09/09/2026 10:00:00' }))],
  ['"t" usa il formato HTTP-date', JSON.stringify(validSession({ t: 'Wed, 09 Sep 2026 10:00:00 GMT' }))],
  ['"t" non include il fuso orario', JSON.stringify(validSession({ t: '2026-09-09T10:00:00' }))],
  ['"t" contiene un giorno inesistente', JSON.stringify(validSession({ t: '2026-02-30T10:00:00Z' }))],
  ['"t" usa un leap second fuori calendario', JSON.stringify(validSession({ t: '2026-09-09T10:00:60Z' }))],
  ['"board" oltre 20 caratteri', JSON.stringify(validSession({ board: 'x'.repeat(21) }))],
  ['"fw" non intero (stringa)', JSON.stringify(validSession({ fw: '3' }))],
  ['"fw" non intero (float)', JSON.stringify(validSession({ fw: 3.5 }))],
  ['"before" senza chiave "noise"', JSON.stringify(validSession({ before: { off: [1, 1] } }))],
  ['"before.off" fuori range (>200)', JSON.stringify(validSession({ before: { off: [201, 1], noise: [1, 1] } }))],
  ['"before.off" fuori range (<0)', JSON.stringify(validSession({ before: { off: [-1, 1], noise: [1, 1] } }))],
  ['"before.off" con un solo elemento', JSON.stringify(validSession({ before: { off: [1], noise: [1, 1] } }))],
  ['"passes" con più di 8 elementi', JSON.stringify(validSession({ passes: Array(9).fill(1) }))],
  ['"passes" con elemento non numerico', JSON.stringify(validSession({ passes: [1, 'due', 3] }))],
  ['"unstableEvents" fuori range (>100)', JSON.stringify(validSession({ unstableEvents: 101 }))],
  ['"unstableEvents" negativo', JSON.stringify(validSession({ unstableEvents: -1 }))],
  ['"unstableEvents" non intero', JSON.stringify(validSession({ unstableEvents: 2.5 }))],
  ['"gate" fuori range (>1)', JSON.stringify(validSession({ gate: 1.1 }))],
  ['"gate" fuori range (<0)', JSON.stringify(validSession({ gate: -0.1 }))],
  ['"gateOff" non booleano', JSON.stringify(validSession({ gateOff: 'true' }))],
  ['JSON sintatticamente malformato', '{ "t": "2026", not valid json', true],
];

function withoutKey(obj, key) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

for (const [description, rawBody] of invalidPayloads) {
  test(`schema: rifiuta con 400 — ${description}`, async () => {
    const res = await postSession(rawBody, { raw: true });
    const problem = await assertProblem(res, 400, 'invalid_request');
    assert.equal(typeof problem.error, 'string', 'la risposta 400 deve avere un campo error descrittivo');

    // Nessuna scrittura deve avvenire per un payload rifiutato.
    assert.equal(fs.existsSync(DATA_PATH), false, 'un payload invalido non deve produrre scritture su disco');
  });
}

for (const [description, headers] of [
  ['content type non supportato', { 'Content-Type': 'text/plain' }],
  ['charset non supportato', { 'Content-Type': 'application/json; charset=iso-8859-1' }],
  ['content encoding non supportato', { 'Content-Encoding': 'x-unsupported' }],
]) {
  test(`media type: ${description} → 415 strutturato`, async () => {
    const res = await postSession(validSession(), { headers });
    await assertProblem(res, 415, 'unsupported_media_type');
    assert.equal(res.headers.get('ratelimit-policy'), '"calibration-submissions";q=10;w=60');
    assert.equal(fs.existsSync(DATA_PATH), false, 'una richiesta 415 non deve produrre scritture');
  });
}

// --- Log injection: il messaggio di SyntaxError di body-parser incorpora una
// fetta verbatim del body. Un client non autenticato potrebbe iniettare newline
// per far sembrare log di servizio righe che in realtà controlla lui.

test('log injection: JSON malformato con newline iniettate non finisce nel log', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => { calls.push(args); };

  let res;
  try {
    // body-parser include il body verbatim nel messaggio SyntaxError per
    // "Unexpected token" (a differenza di "Expected ... after property value",
    // che riporta solo posizione/riga): questa forma innesca l'inclusione.
    const injected = '{"a":\n[FAKE] rotated admin credentials\n}';
    res = await postSession(injected, { raw: true });
  } finally {
    console.error = originalError;
  }

  assert.equal(res.status, 400);
  assert.equal(calls.length, 1, 'il global error handler deve loggare esattamente una volta');
  const loggedText = calls[0].join(' ');
  assert.ok(
    !/[\r\n]/.test(loggedText),
    'il log non deve contenere newline iniettabili dal client (righe di log false)'
  );
  assert.ok(
    !loggedText.includes('[FAKE]'),
    'il body iniettato dal client non deve comparire nel log del server'
  );
});

test('5xx genuino: il messaggio finisce nel log, ma sanificato (niente newline iniettabili)', async () => {
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => { calls.push(args); };

  let res;
  try {
    res = await testFetch(`${baseUrl}/__test/throw-500`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
      body: JSON.stringify({ injected: 'safe\n[FAKE] rotated admin credentials\nend' }),
    });
  } finally {
    console.error = originalError;
  }

  await assertProblem(res, 500, 'internal_error');
  assert.equal(calls.length, 1, 'il global error handler deve loggare esattamente una volta');
  const loggedText = calls[0].join(' ');

  // Il messaggio deve essere presente (è un bug nostro, serve a diagnosticare)...
  assert.ok(loggedText.includes('boom:'), 'il messaggio dell\'errore 5xx deve finire nel log');
  assert.ok(loggedText.includes('safe'), 'il contenuto del messaggio deve essere leggibile');
  // ...ma senza poter fabbricare righe di log finte.
  assert.ok(
    !/[\r\n]/.test(loggedText),
    'il log di un 5xx non deve contenere newline iniettabili dal client (righe di log false)'
  );
  assert.ok(
    !loggedText.includes('[FAKE] rotated admin credentials\n'),
    'la sequenza newline+testo iniettata non deve sopravvivere intatta nel log'
  );
});

// --- Rate limit (10/min per IP) ---

test('rate limit: 10 richieste passano, la 11esima nella stessa finestra → 429', async () => {
  const ip = nextIp();
  for (let i = 0; i < 10; i++) {
    const res = await postSession(validSession({ t: new Date(2026, 6, 20, 10, 0, i).toISOString() }), { ip });
    assert.equal(res.status, 204, `richiesta #${i + 1} entro la soglia deve passare`);
    assert.equal(res.headers.get('ratelimit-policy'), '"calibration-submissions";q=10;w=60');
    assert.match(
      res.headers.get('ratelimit') || '',
      new RegExp(`^"calibration-submissions";r=${9 - i};t=[1-9][0-9]?$`),
    );
  }

  const blocked = await postSession(validSession(), { ip });
  await assertProblem(blocked, 429, 'rate_limit_exceeded');
  assert.match(blocked.headers.get('retry-after') || '', /^[1-9][0-9]?$/);
  assert.match(blocked.headers.get('ratelimit') || '', /;r=0;t=[1-9][0-9]?$/);

  // La richiesta bloccata non deve essere scritta.
  assert.equal(readRecords().length, 10, 'la richiesta oltre soglia non deve arrivare a scrivere');
});

test('rate limit: è per-IP, un IP diverso non eredita il blocco di un altro', async () => {
  const blockedIp = nextIp();
  for (let i = 0; i < 10; i++) {
    await postSession(validSession(), { ip: blockedIp });
  }
  assert.equal((await postSession(validSession(), { ip: blockedIp })).status, 429);

  const freshIp = nextIp();
  const res = await postSession(validSession(), { ip: freshIp });
  assert.equal(res.status, 204, 'un IP con bucket proprio non deve essere impattato dal rate limit altrui');
});

// --- Body size limit: express.json({ limit: '8kb' }), distinto dal safety valve
// sul file di storage (50MB) — è la prima difesa contro un payload abnorme, prima
// ancora che validateBody entri in gioco.

test('body oltre 8kb viene rifiutato (413), senza scrittura e senza crash', async () => {
  const oversized = validSession({ board: 'x'.repeat(20) }); // board resta valido di per sé
  // Gonfia il body con un campo che il body-parser vede PRIMA della validazione dello schema.
  oversized.passes = Array(2000).fill(1.23456789);
  const raw = JSON.stringify(oversized);
  assert.ok(Buffer.byteLength(raw) > 8 * 1024, 'il body di test deve superare davvero 8kb');

  const res = await postSession(raw, { raw: true });
  await assertProblem(res, 413, 'payload_too_large');
  assert.equal(res.headers.get('ratelimit-policy'), '"calibration-submissions";q=10;w=60');
  assert.match(res.headers.get('ratelimit') || '', /;r=9;t=[1-9][0-9]?$/);
  assert.equal(fs.existsSync(DATA_PATH), false, 'un body troppo grande non deve produrre scritture');

  // Il servizio deve restare vivo e rispondere normalmente alla richiesta successiva.
  const followUp = await postSession(validSession());
  assert.equal(followUp.status, 204, 'un body oversize non deve compromettere le richieste successive');
});

// --- Safety valve: limite 50MB sul file di storage ---

const DATA_SIZE_LIMIT = 50 * 1024 * 1024;

test('safety valve: file di storage sotto la soglia (limite-1 byte) → scrittura accettata', async () => {
  fs.writeFileSync(DATA_PATH, '');
  fs.truncateSync(DATA_PATH, DATA_SIZE_LIMIT - 1);
  const sizeBefore = fs.statSync(DATA_PATH).size;

  const res = await postSession(validSession());
  assert.equal(res.status, 204);
  assert.ok(fs.statSync(DATA_PATH).size > sizeBefore, 'la scrittura deve essere avvenuta (append)');
});

test('safety valve: file di storage al limite (50MB) → 507, nessuna scrittura', async () => {
  fs.writeFileSync(DATA_PATH, '');
  fs.truncateSync(DATA_PATH, DATA_SIZE_LIMIT);
  const sizeBefore = fs.statSync(DATA_PATH).size;

  const res = await postSession(validSession());
  await assertProblem(res, 507, 'storage_capacity_reached');
  assert.equal(fs.statSync(DATA_PATH).size, sizeBefore, 'il file non deve crescere oltre il limite');
});

// --- Privacy: niente IP/UA persistiti ---

test('privacy: IP e User-Agent della richiesta non finiscono mai nel JSONL', async () => {
  const telltaleIp = '203.0.113.77'; // TEST-NET-3 (RFC 5737), non instradabile: solo un marcatore
  const telltaleUa = 'SubraLabsCanaryUA/1.0-do-not-persist';

  const res = await postSession(validSession(), {
    ip: telltaleIp,
    headers: { 'User-Agent': telltaleUa },
  });
  assert.equal(res.status, 204);

  const rawContent = fs.readFileSync(DATA_PATH, 'utf8');
  assert.ok(!rawContent.includes(telltaleIp), 'l\'IP del richiedente non deve comparire nel file');
  assert.ok(!rawContent.includes(telltaleUa), 'lo User-Agent non deve comparire nel file');

  const [record] = readRecords();
  const keys = Object.keys(record);
  assert.ok(!keys.some((k) => /ip|agent|address/i.test(k)), 'nessuna chiave del record deve riferirsi a IP/UA');
});

// --- Scrittura JSONL: append, una riga per sessione ---

test('JSONL: due POST successivi appendono due righe distinte, senza sovrascrivere', async () => {
  const first = validSession({ t: '2026-07-20T10:00:00.000Z', unstableEvents: 1 });
  const second = validSession({ t: '2026-07-21T11:00:00.000Z', unstableEvents: 2 });

  assert.equal((await postSession(first)).status, 204);
  assert.equal((await postSession(second)).status, 204);

  const records = readRecords();
  assert.equal(records.length, 2, 'due sessioni devono produrre due righe, non un file sovrascritto');
  assert.equal(records[0].t, first.t);
  assert.equal(records[0].unstableEvents, 1);
  assert.equal(records[1].t, second.t);
  assert.equal(records[1].unstableEvents, 2);
});

test('JSONL: ogni riga è JSON valido indipendente (non un array unico)', async () => {
  await postSession(validSession());
  await postSession(validSession());
  const lines = readLines();
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `riga non valida: ${line}`);
  }
});

// --- Health check locale (bonus, a costo zero: verifica il conteggio righe) ---

test('rotta API inesistente restituisce un problema JSON, non una pagina HTML', async () => {
  const res = await testFetch(`${baseUrl}/api/calib/not-a-real-endpoint`);
  await assertProblem(res, 404, 'endpoint_not_found');
});

test('/health riporta sessionLines coerente col numero di sessioni scritte', async () => {
  await postSession(validSession());
  await postSession(validSession());
  const res = await testFetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.status, 'ok');
  assert.equal(json.sessionLines, 2);
});

test('/health su file inesistente riporta sessionLines 0 (non 500)', async () => {
  const res = await testFetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.sessionLines, 0);
});

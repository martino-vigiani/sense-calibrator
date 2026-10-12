'use strict';

// Quote della cartella dei report diagnostici, con tetti piccoli: quota
// globale del giorno (report e byte), tetto sul numero di file, avviso nel log
// all'80%. La configurazione si legge al require del server, quindi questo
// file gira in un processo suo (node --test ne lancia uno per file).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-diagnostics-quota-'));
const DIAG_DIR = path.join(TMP_DIR, 'diagnostics');
const FIXTURES = require('./contract/diagnostics-v1.fixtures.json');
const SMALL = FIXTURES.valid[1].report; // ~575 byte salvato
const LARGE = FIXTURES.valid[0].report; // ~1.9 KB
process.env.DATA_PATH = path.join(TMP_DIR, 'sessions.jsonl');
process.env.DATA_V2_PATH = path.join(TMP_DIR, 'events-v2.jsonl');
process.env.DIAG_DIR = DIAG_DIR;
process.env.DIAG_DAILY_MAX_REPORTS = '3';
process.env.DIAG_DAILY_MAX_BYTES = '2400';
process.env.DIAG_MAX_FILES = '5';
process.env.DIAG_IP_DAY_MAX = '2';
process.env.DIAG_DIR_LIMIT = String(1024 * 1024);
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const { app, cleanupDiagnostics } = require('./server');
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
  cleanupDiagnostics();
});

// Un IP diverso a ogni richiesta: la quota per IP (3 all'ora) non c'entra.
function postReport(body = SMALL) {
  ipCounter += 1;
  return testFetch(`${baseUrl}/api/calib/v2/diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.40.${ipCounter >> 8}.${ipCounter & 0xff}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const reports = () => (fs.existsSync(DIAG_DIR) ? fs.readdirSync(DIAG_DIR).filter(n => n.startsWith('SC-')) : []);
const DAY = 86_400_000;

// Un report già salvato `daysAgo` giorni fa (mtime alla mezzanotte UTC, come
// li scrive il server).
function oldReport(name, daysAgo, bytes = 600) {
  fs.mkdirSync(DIAG_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIAG_DIR, name);
  fs.writeFileSync(file, 'x'.repeat(bytes));
  const t = (Math.floor(Date.now() / DAY) * DAY - daysAgo * DAY) / 1000;
  fs.utimesSync(file, t, t);
}

test('quota del giorno, in report: da IP diversi, poi 507 con Retry-After fino a mezzanotte UTC', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await postReport()).status, 201, `report ${i + 1}`);
  const res = await postReport();
  assert.equal(res.status, 507);
  const problem = await res.json();
  assert.equal(problem.code, 'storage_capacity_reached');
  assert.match(problem.detail, /daily capacity/);
  const retry = Number(res.headers.get('retry-after'));
  const toMidnight = Math.ceil((Math.floor(Date.now() / DAY) * DAY + DAY - Date.now()) / 1000);
  assert.ok(retry > 0 && Math.abs(retry - toMidnight) <= 2, `${retry} vs ${toMidnight}`);
  assert.equal(reports().length, 3);
  // Prima del parse: un body malformato riceve lo stesso 507, non un 400.
  assert.equal((await postReport('{')).status, 507);
});

test('quota del giorno, in byte: il report che la supererebbe non si scrive', async () => {
  assert.equal((await postReport()).status, 201);
  assert.equal((await postReport()).status, 201);
  // ~1.15 KB scritti: il report da ~1.9 KB supererebbe i 2400 byte.
  const res = await postReport(LARGE);
  assert.equal(res.status, 507);
  assert.match((await res.json()).detail, /daily capacity/);
  assert.equal(reports().length, 2);
  // Uno piccolo ci sta ancora.
  assert.equal((await postReport()).status, 201);
});

test('la quota del giorno sopravvive a un riavvio (si ricostruisce dai mtime) e non conta i giorni prima', async () => {
  oldReport('SC-AAAAAAAA.json', 1);
  oldReport('SC-AAAAAAAB.json', 2);
  for (let i = 0; i < 2; i++) assert.equal((await postReport()).status, 201);
  cleanupDiagnostics(); // come all'avvio
  assert.equal((await postReport()).status, 201, 'the reports of earlier days do not count');
  assert.equal((await postReport()).status, 507, 'the three of today do, after the rescan too');
});

test('tetto sul numero di file → 507 senza Retry-After; la pulizia lo libera', async () => {
  for (let i = 0; i < 5; i++) oldReport(`SC-AAAAAAA${'ABCDE'[i]}.json`, 10 + i, 10);
  cleanupDiagnostics();
  const res = await postReport();
  assert.equal(res.status, 507);
  assert.equal(res.headers.get('retry-after'), null);
  assert.match((await res.json()).detail, /configured capacity/);
  assert.equal(reports().length, 5);
  // Un file oltre i 180 giorni se ne va e libera un posto.
  oldReport('SC-AAAAAAAA.json', 181, 10);
  cleanupDiagnostics();
  assert.equal(reports().length, 4);
  assert.equal((await postReport()).status, 201);
});

test('log all\'80% del tetto (file o byte), una volta finché non scende', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    for (let i = 0; i < 3; i++) oldReport(`SC-AAAAAAA${'ABC'[i]}.json`, 5, 10);
    cleanupDiagnostics();
    assert.deepEqual(warnings, [], '3 of 5 files');
    assert.equal((await postReport()).status, 201);
    assert.equal(warnings.length, 1, '4 of 5 files');
    assert.match(warnings[0], /diagnostics store above 80% of its cap: .* 4 of 5 files/);
    cleanupDiagnostics();
    assert.equal(warnings.length, 1, 'once while it stays high');
    fs.rmSync(DIAG_DIR, { recursive: true, force: true });
    cleanupDiagnostics();
    oldReport('SC-AAAAAAAA.json', 5, 900 * 1024);
    cleanupDiagnostics();
    assert.equal(warnings.length, 2, 'again after dropping below, by bytes this time');
    assert.match(warnings[1], /0\.9 of 1\.0 MB, 1 of 5 files/);
  } finally {
    console.warn = original;
  }
});

test('tetto per IP sulle 24 ore: un indirizzo non esaurisce da solo la quota globale', async () => {
  const post = () => testFetch(`${baseUrl}/api/calib/v2/diagnostics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.41.0.1' },
    body: JSON.stringify(SMALL),
  });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  // Terzo invio entro l'ora: la quota oraria (3) lo permetterebbe, quella del giorno per IP (2) no.
  const res = await post();
  assert.equal(res.status, 429);
  assert.match((await res.json()).detail, /2 each day/);
  assert.ok(Number(res.headers.get('retry-after')) > 3600);
  assert.equal(reports().length, 2);
  // Un altro indirizzo usa ancora la quota globale.
  assert.equal((await postReport()).status, 201);
});

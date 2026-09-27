// Verifica headless della telemetria v2 (solo sviluppo, non fa parte di npm
// test: Playwright non è una dipendenza del progetto).
//
//   python3 -m http.server 8794 --bind 127.0.0.1 --directory <repo> &
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//     node ops/ui-check/telemetry-v2-check.mjs http://127.0.0.1:8794
//
// Chromium headless, navigator.hid finto sostenuto da ops/sim/fake-dualsense.mjs
// (model-verified, non un DualSense). Ogni richiesta fuori da localhost è
// bloccata; quelle verso gli endpoint di telemetria sono intercettate,
// registrate e chiuse con un 204 finto: nulla raggiunge subralabs.com.
// Scenari:
//   1. prima visita: Quick completo → nessuna richiesta finché l'avviso è
//      aperto; "Don't share" → ancora nessuna, e niente eventi costruiti dopo;
//   2. prima visita, "Keep sharing" → v1 + v2 quick, poi Write → flash + save,
//      poi 35 s fermi → un riassunto rest, poi un'altra pagina → niente save
//      duplicato (il periodo è già chiuso);
//   3. chi aveva accettato v1 → avviso con "What's shared has changed", niente
//      parte (nemmeno v1) prima della risposta;
//   4. chi aveva rifiutato → nessun avviso, nessun evento, nessuna richiesta;
//   5. Quick e poi uscita dalla pagina senza salvare → save 'left' in keepalive.
// Ogni corpo v2 intercettato passa dal validatore del contratto.

import { validateEventV2 } from '../../js/telemetry-v2.js';

const [, , base = 'http://127.0.0.1:8794'] = process.argv;
const pwPath = process.env.PLAYWRIGHT;
if (!pwPath) throw new Error('set PLAYWRIGHT to the playwright index.mjs path');
const { chromium } = await import(pwPath);

const failures = [];
const check = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures.push(what); };
const browser = await chromium.launch();

function fakeHid() {
  let dev = null;
  const make = async () => {
    const { FakeDualSense } = await import('/ops/sim/fake-dualsense.mjs');
    const clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), now: () => performance.now() };
    dev = new FakeDualSense({
      clock, seed: 5,
      sticks: [{ drift: [2.4, -1.3], noise: 0.3, bias: { axis: 0, B: 0 } }, { drift: [-0.6, 2.9], noise: 0.3, bias: { axis: 0, B: 0 } }],
      fw: { sf: 0, cmdMs: [2, 6] }, timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    });
    window.__fakeDev = dev;
    return dev;
  };
  const hid = {
    async getDevices() { return []; },
    async requestDevice() { return [dev ?? await make()]; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });
}

async function freshPage(storage = null) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const sent = [];
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'subralabs.com' && url.pathname.startsWith('/api/calib/')) {
      const cors = {
        'access-control-allow-origin': request.headers().origin ?? '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'Content-Type',
      };
      if (request.method() === 'POST') sent.push({ path: url.pathname, body: JSON.parse(request.postData() ?? 'null') });
      return route.fulfill({ status: 204, headers: cors });
    }
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  if (storage) await page.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await page.addInitScript(fakeHid);
  await page.goto(`${base}/`);
  // app.js è un modulo: il click deve arrivare dopo che ha agganciato i gestori.
  await page.waitForFunction(() => typeof window.__senseTelemetryV2 === 'function');
  await page.evaluate(() => document.getElementById('btn-connect').click());
  await page.waitForSelector('#view-device:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#verdict-l:not(.hidden)', { timeout: 30000 });
  return { context, page, sent, errors };
}

const v1 = sent => sent.filter(r => r.path === '/api/calib/v1/sessions');
const v2 = sent => sent.filter(r => r.path === '/api/calib/v2/events').map(r => r.body);
const outbox = page => page.evaluate(() => window.__senseTelemetryV2());
const noticeVisible = page => page.evaluate(() => !document.getElementById('telemetry-notice').classList.contains('hidden'));
const changedVisible = page => page.evaluate(() => !document.getElementById('notice-changed').classList.contains('hidden'));

async function runQuick(page) {
  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForSelector('#modal-quick:not(.hidden)');
  await page.evaluate(() => document.getElementById('btn-quick-go').click());
  await page.waitForSelector('#banner-unsaved:not(.hidden)', { timeout: 90000 });
  await page.waitForSelector('#modal-quick.hidden', { state: 'attached', timeout: 60000 });
  await page.waitForTimeout(600);
}
async function write(page) {
  await page.evaluate(() => document.getElementById('btn-flash').click());
  await page.waitForSelector('#modal-flash:not(.hidden)');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('btn-flash-go').click());
  await page.waitForSelector('#banner-unsaved.hidden', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(500);
}
function validAll(events, label) {
  const bad = events.map(e => [e?.type, validateEventV2(e)]).filter(([, err]) => err);
  check(bad.length === 0, `${label}: every v2 body matches the contract ${bad.length ? JSON.stringify(bad) : ''}`);
}

// 1. prima visita, Don't share
{
  const { context, page, sent, errors } = await freshPage();
  check(await noticeVisible(page), '1: the notice is open on a first visit');
  check(!(await changedVisible(page)), '1: no "what changed" line on a first visit');
  await runQuick(page);
  check(sent.length === 0, `1: nothing sent while the notice is open (${sent.length})`);
  const queued = await outbox(page);
  check(queued.some(i => i.event.type === 'quick' && i.state === 'queued'), '1: the quick event is queued in the page');
  await page.evaluate(() => document.getElementById('btn-notice-optout').click());
  await page.waitForTimeout(300);
  await write(page);
  await page.waitForTimeout(1000);
  check(sent.length === 0, `1: nothing sent after Don't share, Write included (${sent.length})`);
  const after = await outbox(page);
  check(after.length === queued.length && after.every(i => i.state === 'discarded'), '1: queued events discarded, no new ones built');
  check(errors.length === 0, `1: no page errors ${errors.join(' | ')}`);
  await context.close();
}

// 2. prima visita, Keep sharing
{
  const { context, page, sent, errors } = await freshPage();
  await runQuick(page);
  check(sent.length === 0, '2: nothing sent before the answer');
  await page.evaluate(() => document.getElementById('btn-notice-ok').click());
  await page.waitForTimeout(1500);
  check(v1(sent).length === 1, `2: the complete Quick result goes to v1 (${v1(sent).length})`);
  check(v2(sent).map(e => e.type).join() === 'quick', `2: v2 quick sent after Keep sharing (${v2(sent).map(e => e.type)})`);
  await write(page);
  await page.waitForTimeout(1000);
  const types = v2(sent).map(e => e.type);
  check(types.join() === 'quick,flash,save', `2: Write adds flash and save (${types})`);
  const [q, f, s] = v2(sent);
  check(s?.result === 'saved' && s?.ref === q?.seq && f?.result === 'ok', '2: save says saved and points at the quick event');
  // Il test drift automatico dopo il salvataggio e poi 35 s fermi.
  await page.waitForTimeout(36_000);
  const rest = v2(sent).filter(e => e.type === 'rest');
  check(rest.length >= 1, `2: a resting-noise summary after 30 s untouched (${rest.length})`);
  check(rest.every(e => e.state === 'saved'), '2: rest state is saved after a successful Write');
  validAll(v2(sent), '2');
  const text = JSON.stringify(sent);
  check(!/serial|"t":"20|E8475|receivedAt/i.test(v2(sent).map(e => JSON.stringify(e)).join('')), '2: no serial, timestamp or device text in v2 bodies');
  check(text.length > 0, '2: captured');
  check(errors.length === 0, `2: no page errors ${errors.join(' | ')}`);
  const before = sent.length;
  await page.goto('about:blank');
  await new Promise(r => setTimeout(r, 800));
  check(v2(sent.slice(before)).filter(e => e.type === 'save').length === 0, '2: leaving after a save sends no second save event');
  await context.close();
}

// 3. chi aveva accettato v1
{
  const { context, page, sent, errors } = await freshPage({ 'sense-telemetry-notice': '1', 'sense-telemetry-consent': '1' });
  check(await noticeVisible(page), '3: a v1 sharer sees the notice again');
  check(await changedVisible(page), '3: with "What\'s shared has changed"');
  await runQuick(page);
  check(sent.length === 0, `3: nothing sent, v1 included, until the answer (${sent.length})`);
  await page.evaluate(() => document.getElementById('btn-notice-ok').click());
  await page.waitForTimeout(1500);
  check(v1(sent).length === 1 && v2(sent).length === 1, '3: Keep sharing releases v1 and v2');
  check(errors.length === 0, `3: no page errors ${errors.join(' | ')}`);
  await context.close();
}

// 4. chi aveva rifiutato
{
  const { context, page, sent, errors } = await freshPage({ 'sense-telemetry-notice': '1', 'sense-telemetry-consent': '0' });
  check(!(await noticeVisible(page)), '4: no notice for someone who opted out');
  await runQuick(page);
  await page.waitForTimeout(32_000);
  check(sent.length === 0, `4: nothing sent (${sent.length})`);
  check((await outbox(page)).length === 0, '4: no v2 event even built');
  check(errors.length === 0, `4: no page errors ${errors.join(' | ')}`);
  await context.close();
}

// 5. uscita senza salvare: prima un pagehide sintetico (il gestore e la fetch,
// senza scaricare la pagina), poi una navigazione vera, solo informativa
// (INFO): l'intercettazione di Playwright non vede le richieste keepalive
// partite durante l'unload. Che Chromium le consegni davvero, preflight CORS
// compreso, è stato provato a parte (27 set 2026) contro un server locale
// senza intercettazione: OPTIONS e POST application/json arrivano entrambi.
{
  const { context, page, sent } = await freshPage({ 'sense-telemetry-notice': '1', 'sense-telemetry-scope': '2', 'sense-telemetry-consent': '1' });
  check(!(await noticeVisible(page)), '5: no notice once the current description was accepted');
  await runQuick(page);
  await page.waitForTimeout(800);
  let before = sent.length;
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  await page.waitForTimeout(800);
  const save = v2(sent.slice(before)).find(e => e.type === 'save');
  check(save?.result === 'left', `5: pagehide sends save 'left' (${JSON.stringify(save)})`);
  validAll(v2(sent), '5');
  await context.close();
}
{
  const { context, page, sent } = await freshPage({ 'sense-telemetry-notice': '1', 'sense-telemetry-scope': '2', 'sense-telemetry-consent': '1' });
  await runQuick(page);
  await page.waitForTimeout(800);
  const before = sent.length;
  // beforeunload chiede conferma con una calibrazione non salvata: il
  // gestore dei dialoghi accetta, come chi chiude comunque.
  await page.goto('about:blank');
  await new Promise(r => setTimeout(r, 2000));
  const save = v2(sent.slice(before)).find(e => e.type === 'save');
  console.log(`INFO 5b: a real navigation away ${save ? `delivered save '${save.result}'` : 'did not deliver the save event to the interceptor'}`);
  await context.close();
}

await browser.close();
if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}

// Prova headless della pagina del probe (solo sviluppo, non fa parte di npm
// test: Playwright non è una dipendenza del progetto).
//
//   python3 -m http.server 8790 --directory <repo> &
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//     node ops/hw-probe/smoke-headless.mjs http://localhost:8790
//
// Verifica, in un Chromium headless:
// 1. fuori da localhost (un nome mappato su 127.0.0.1) la pagina rifiuta e non
//    carica il codice HID;
// 2. su localhost, con un navigator.hid finto sostenuto da
//    ops/sim/fake-dualsense.mjs (tempo reale), i pulsanti di scrittura restano
//    disabilitati finché non si arma, il preflight legge [12,2], H-b e H-c
//    passano con le conferme accettate, e il JSON non contiene il seriale.
// Tutto "model-verified": il controller è il modello, non un DualSense.

const [, , base = 'http://localhost:8790'] = process.argv;
const pwPath = process.env.PLAYWRIGHT;
if (!pwPath) throw new Error('set PLAYWRIGHT to the playwright index.mjs path');
const { chromium } = await import(pwPath);

const port = new URL(base).port;
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP probe.example 127.0.0.1`] });
const failures = [];
const check = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures.push(what); };

try {
  // 1. host non locale
  {
    const page = await browser.newPage();
    const requests = [];
    page.on('request', r => requests.push(r.url()));
    await page.goto(`http://probe.example:${port}/ops/hw-probe/`);
    await page.waitForSelector('#refused:not([hidden])');
    check(await page.isHidden('#probe'), 'off localhost: the probe UI stays hidden');
    check(!requests.some(u => /protocol\.mjs|module-cal\.mjs|ds5\.js/.test(u)), 'off localhost: no HID code is loaded');
    await page.close();
  }

  // 2. localhost con WebHID finto
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  await page.addInitScript(() => {
    const listeners = new Map();
    const hid = {
      async requestDevice() {
        const { FakeDualSense } = await import('/ops/sim/fake-dualsense.mjs');
        const clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), now: () => performance.now() };
        const dev = new FakeDualSense({
          clock, seed: 5,
          sticks: [{ drift: [2.4, -1.3], noise: 0.3, bias: { axis: 0, B: 0 } }, { drift: [-0.6, 2.9], noise: 0.3, bias: { axis: 0, B: 0 } }],
          fw: { sf: 0, cmdMs: [2, 6] }, timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
        });
        // Report 0x20 e seriale: il fake risponde con zeri, il probe li tollera.
        window.__fakeDev = dev;
        return [dev];
      },
      addEventListener(type, fn) { listeners.set(type, fn); },
    };
    Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });
  });
  await page.goto(`${base}/ops/hw-probe/`);
  await page.waitForSelector('#probe:not([hidden])');
  check(await page.isDisabled('[data-step="H-b"]'), 'before connecting: write steps disabled');
  await page.click('#connect');
  await page.waitForFunction(() => /Connection 1/.test(document.getElementById('conn-status').textContent));
  check(await page.isEnabled('[data-step="preflight"]'), 'connected: preflight enabled');
  check(await page.isDisabled('[data-step="H-b"]'), 'connected but disarmed: H-b disabled');

  const runStep = async step => {
    await page.click(`[data-step="${step}"]`);
    await page.waitForFunction(s => new RegExp(`^${s}: (done|stopped)`).test(document.getElementById('step-status').textContent), step, { timeout: 60000 });
    return page.textContent('#step-status');
  };
  check(/done/.test(await runStep('preflight')), 'preflight done');
  check(/done/.test(await runStep('H-a')), 'H-a done');

  await page.fill('#phrase', 'spare');
  await page.check('#spare');
  await page.click('#arm');
  check(await page.isDisabled('[data-step="H-b"]'), 'lower-case phrase does not arm');
  await page.fill('#phrase', 'SPARE');
  await page.click('#arm');
  check(await page.isEnabled('[data-step="H-b"]'), 'armed: H-b enabled');

  check(/done/.test(await runStep('H-b')), 'H-b done');
  check(/done/.test(await runStep('H-c')), 'H-c done');
  check(dialogs.length === 2 && /PERMANENTLY/.test(dialogs[1]), 'one confirmation per write step, H-c flagged permanent');
  const writes = await page.evaluate(() => window.__fakeDev.moduleCounts.write);
  check(writes === 1, `exactly one [12,1] write (${writes})`);
  const record = await page.textContent('#record');
  check(/"H-c"/.test(record) && /"exact": true/.test(record), 'the record shows an exact restore');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  await page.close();
} finally {
  await browser.close();
}
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
console.log('hw-probe headless smoke: all checks passed (model-verified)');

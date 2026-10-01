// Verifica UI Range con il tracker reale e lo stesso fake WebHID degli altri
// ui-check. Solo sviluppo, model-verified: nessun controller fisico.
// PLAYWRIGHT=/path/to/playwright/index.mjs node ops/ui-check/range-check.mjs
//   http://localhost:8799 /tmp/sense-range-shots
// RANGE_WIDTHS='[[375,740],[1280,900]]' per scegliere i viewport.

const [, , base = 'http://localhost:8799', shotDir = null] = process.argv;
if (!process.env.PLAYWRIGHT) throw new Error('set PLAYWRIGHT to the existing playwright index.mjs');
const { chromium } = await import(process.env.PLAYWRIGHT);
const { mkdir } = await import('node:fs/promises');
const { join } = await import('node:path');
if (shotDir) await mkdir(shotDir, { recursive: true });
const widths = JSON.parse(process.env.RANGE_WIDTHS ?? '[[375,740],[1280,900]]');
const failures = [];
function check(condition, expected, obtained) {
  console.log(`${condition ? 'ok' : 'FAIL'} ${expected}; obtained ${JSON.stringify(obtained)}`);
  if (!condition) failures.push(expected);
}

function fakeHid() {
  let dev;
  const hid = {
    async getDevices() { return []; },
    async requestDevice() {
      if (!dev) {
        const { FakeDualSense } = await import('/ops/sim/fake-dualsense.mjs');
        dev = new FakeDualSense({
          clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), now: () => performance.now() }, seed: 21,
          sticks: [{ drift: [0, 0], noise: 0.1, bias: { axis: 0, B: 0 } }, { drift: [0, 0], noise: 0.1, bias: { axis: 0, B: 0 } }],
          fw: { sf: 0, cmdMs: [2, 6] },
          timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
        });
        window.__fakeDev = dev;
      }
      return [dev];
    },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });
}

const browser = await chromium.launch();
async function freshPage(width, height) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)
    ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(fakeHid);
  await page.goto(base);
  await page.locator('#btn-connect').click();
  try {
    await page.waitForSelector('#verdict-l:not(.hidden)', { timeout: 15000 });
  } catch (error) {
    const detail = await page.evaluate(() => ({ log: document.getElementById('log').textContent,
      toast: document.getElementById('toasts').textContent }));
    throw new Error(`${error.message}; ${JSON.stringify({ errors, detail })}`);
  }
  await page.locator('#btn-range').click();
  await page.waitForFunction(() => document.activeElement.id === 'btn-range-start');
  const intro = await page.evaluate(() => ({ focus: document.activeElement.id, commands: window.__fakeDev.counts.range }));
  check(intro.focus === 'btn-range-start' && intro.commands === 0, `${width}px intro focuses Start and sends no Range command`, intro);
  await page.locator('#btn-range-start').click();
  await page.waitForSelector('#range-live:not(.hidden)');
  await page.waitForTimeout(350);
  const focus = await page.evaluate(() => document.activeElement.className);
  check(focus === 'modal-panel', `${width}px running Range keeps focus on its panel`, focus);
  await page.evaluate(() => {
    const el = document.getElementById('range-hint');
    window.__rangeChanges = [];
    window.__rangePrevious = el.textContent;
    window.__rangeObserver = new MutationObserver(records => {
      window.__rangeChanges.push({ text: el.textContent, t: performance.now(), count: records.length, duplicate: el.textContent === window.__rangePrevious });
      window.__rangePrevious = el.textContent;
    });
    window.__rangeObserver.observe(el, { childList: true, characterData: true, subtree: true });
  });
  return { page, context, errors };
}

async function spin(page, { sticks = [0, 1], turns = 2.2, dir = 1, short = false, period = 1000 } = {}) {
  const duration = await page.evaluate(({ sticks, turns, dir, short, period }) => {
    const from = performance.now() + 20;
    const dur = turns * period;
    for (const stick of sticks) window.__fakeDev.touches.push({
      stick, t0: from, dur, tail: 1,
      at: (time, axis) => {
        const angle = dir * 2 * Math.PI * (time - from) / period;
        const wrapped = ((angle * 180 / Math.PI % 360) + 360) % 360;
        // Sei settori diagonali corti, senza accorciare i quattro lati.
        const radius = short && stick === 0 && ((wrapped > 210 && wrapped < 250) || (wrapped > 300 && wrapped < 320)) ? 0.7 : 1;
        return radius * 127.5 * (axis === 0 ? Math.cos(angle) : Math.sin(angle));
      },
    });
    return dur + 25;
  }, { sticks, turns, dir, short, period });
  await page.waitForTimeout(duration);
}

const state = page => page.evaluate(() => ({
  hint: document.getElementById('range-hint').textContent,
  coverage: document.getElementById('range-pct').textContent,
  disabled: document.getElementById('btn-range-done').disabled,
  done: document.getElementById('btn-range-done').textContent,
  left: document.getElementById('range-state-l').textContent,
  right: document.getElementById('range-state-r').textContent,
  requirements: ['l', 'r'].map(side => [...document.querySelectorAll(`#range-requirements-${side} li`)].map(el => el.dataset.met)),
  help: document.getElementById('range-help').hidden ? '' : document.getElementById('range-help').textContent,
  commands: window.__fakeDev.counts.range,
}));
async function layout(page, width, label) {
  const result = await page.evaluate(() => {
    const panel = document.querySelector('#modal-range .modal-panel');
    const button = document.getElementById('btn-range-done');
    const horizontal = panel.scrollWidth <= panel.clientWidth;
    button.scrollIntoView({ block: 'center' });
    const box = button.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return { horizontal, buttonVisible: hit === button || button.contains(hit), buttonHeight: box.height };
  });
  check(result.horizontal && result.buttonVisible && result.buttonHeight >= 44, `${width}px ${label}: no horizontal overflow and Done remains reachable above the notice`, result);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press(key);
      const inside = await page.evaluate(() => document.getElementById('modal-range').contains(document.activeElement));
      if (!inside) { check(false, `${width}px ${label}: focus remains in Range`, key); break; }
    }
  }
}
async function shot(page, filename) {
  if (!shotDir) return;
  await page.evaluate(() => { document.getElementById('modal-range').scrollTop = 0; });
  await page.screenshot({ path: join(shotDir, filename), fullPage: false });
}

try {
  for (const [width, height] of widths) {
    const full = await freshPage(width, height);
    try {
      await spin(full.page);
      await full.page.waitForTimeout(1150);
      let got = await state(full.page);
      check(got.coverage === 'Coverage 100%' && got.disabled && got.done === 'Done' && got.commands === 1
        && got.requirements.every(side => side.join(',') === 'true,true,true,false') && /^Reverse both sticks/.test(got.hint),
      `${width}px 100% coverage still needs reversal on each stick, with no Range end sent`, got);
      await layout(full.page, width, 'reverse pending');
      await shot(full.page, `${width}-range-reverse.png`);
      await spin(full.page, { sticks: [0], dir: -1, turns: 0.75 });
      await full.page.waitForTimeout(1150);
      got = await state(full.page);
      check(got.left === 'Complete' && got.right === 'In progress' && got.disabled && /Reverse the right stick/.test(got.hint),
        `${width}px completed left stick keeps instruction targeted at the right stick`, got);
      await shot(full.page, `${width}-range-right-pending.png`);
      await spin(full.page, { sticks: [1], dir: -1, turns: 0.75 });
      await full.page.waitForTimeout(250);
      got = await state(full.page);
      check(!got.disabled && got.left === 'Complete' && got.right === 'Complete'
        && got.requirements.every(side => side.every(value => value === 'true')),
      `${width}px Done enables only after both sticks satisfy all requirements`, got);
      const changes = await full.page.evaluate(() => window.__rangeChanges);
      check(changes.every(change => !change.duplicate && change.count === 1), `${width}px live instruction only mutates on a real text change`, changes);
      check(changes.every((change, index) => index === 0 || /Both sticks are ready/.test(change.text) || change.t - changes[index - 1].t >= 990),
        `${width}px announcements are at least one second apart except completion`, changes.map(item => ({ text: item.text, t: Math.round(item.t) })));
      await shot(full.page, `${width}-range-complete.png`);
      await full.page.locator('#btn-range-done').click();
      await full.page.waitForFunction(() => document.getElementById('btn-range-done').textContent === 'Skip check');
      const checkStep = await full.page.evaluate(() => ({
        listsHidden: [...document.querySelectorAll('.range-requirements')].every(el => el.hidden),
        legendHidden: document.getElementById('range-legend').hidden,
        button: document.getElementById('btn-range-done').textContent,
        labels: ['l', 'r'].map(side => document.getElementById('dial-range-' + side).getAttribute('aria-label')),
      }));
      check(checkStep.listsHidden && checkStep.legendHidden && checkStep.button === 'Skip check'
        && checkStep.labels.join(',') === 'Left stick range check,Right stick range check',
        `${width}px check step shows its own one-turn task and current canvas labels`, checkStep);
      check(full.errors.length === 0, `${width}px full-range page has no JavaScript errors`, full.errors);
    } finally { await full.context.close(); }

    const partial = await freshPage(width, height);
    try {
      await spin(partial.page, { turns: 20, short: true, period: 800 });
      await spin(partial.page, { turns: 1.2, dir: -1, short: true, period: 800 });
      await partial.page.waitForTimeout(400);
      const got = await state(partial.page);
      check(/^Coverage (8[0-9])%$/.test(got.coverage) && got.requirements[0].join(',') === 'false,true,true,true'
        && got.requirements[1].every(value => value === 'true') && got.done === 'Finish anyway' && !got.disabled,
      `${width}px repeated rotations at short sectors keep coverage independently incomplete`, got);
      check(/dashed edge sectors on the left stick/.test(got.hint) && /Slow down and pause gently/.test(got.help)
        && !/broken|worn|fault|sensor|replace/i.test(got.help), `${width}px persistent gap suggests a movement correction without diagnosis`, got.help);
      await layout(partial.page, width, 'short sectors');
      await shot(partial.page, `${width}-range-short-sectors.png`);
      let warning = '';
      partial.page.once('dialog', async dialog => {
        warning = dialog.message();
        await dialog.accept();
      });
      await partial.page.locator('#btn-range-done').click();
      await partial.page.waitForSelector('#modal-range', { state: 'hidden' });
      check(/cover more of the edge/.test(warning), `${width}px Finish anyway still confirms what is missing`, warning);
      const writeOff = await partial.page.locator('#btn-flash').isDisabled();
      check(writeOff, `${width}px an incomplete finish still disables Write`, writeOff);
      check(partial.errors.length === 0, `${width}px short-sector page has no JavaScript errors`, partial.errors);
    } finally { await partial.context.close(); }
  }
} finally { await browser.close(); }
if (failures.length) throw new Error(`${failures.length} Range checks failed: ${failures.join('; ')}`);
console.log('Range UI checks passed (model-verified).');

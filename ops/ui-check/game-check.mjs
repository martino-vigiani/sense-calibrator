// Verifica headless del test di precisione v4 (WS8). Solo sviluppo, non fa
// parte di npm test: Playwright non è una dipendenza del progetto.
//
//   python3 -m http.server 8871 --directory <repo> &
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//     node ops/ui-check/game-check.mjs http://localhost:8871 [cartella-screenshot]
//
// In un Chromium headless con un navigator.hid finto (ops/sim/fake-dualsense.mjs)
// il cui stick è mosso da uno script (tocchi, flick, giri: "fake stick feed"):
// 1. il test si apre dall'hook __senseGameOpen e si percorre da tastiera
//    (Enter su Start, Tab fino a Skip/Retry, Run test again, Esc), con il fuoco
//    sempre nel modale;
// 2. ogni fase mostra istruzione, perché dell'attesa, segnapassi, e i due
//    numeri finali; il confronto prima/dopo usa la chiave salata del seriale;
// 3. un buco nei report mostra "Interrupted" e Retry riprende la prova;
// 4. screenshot di ogni fase a 1280 e 375 px.
// Ogni richiesta fuori da localhost è bloccata. Il controller è il modello
// (model-verified), non un DualSense.

const [, , base = 'http://localhost:8871', shotDir = null] = process.argv;
const pwPath = process.env.PLAYWRIGHT;
if (!pwPath) throw new Error('set PLAYWRIGHT to the playwright index.mjs path');
const { chromium } = await import(pwPath);
const fs = await import('node:fs');
const path = await import('node:path');
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

const failures = [];
const check = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures.push(what); };

const browser = await chromium.launch();

function fakeHid() {
  let dev = null;
  const make = async () => {
    const { FakeDualSense } = await import('/ops/sim/fake-dualsense.mjs');
    const clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), now: () => performance.now() };
    // sinistro 2 passi fuori centro, destro al pavimento (byte 127/128)
    dev = new FakeDualSense({
      clock, seed: 9,
      sticks: [{ drift: [-2.6, -0.5], noise: 0.3, bias: { axis: 0, B: 0 } }, { drift: [-0.5, -0.5], noise: 0.3, bias: { axis: 0, B: 0 } }],
      fw: { sf: 0, cmdMs: [2, 6] }, timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    });
    window.__fakeDs = dev;
    return dev;
  };
  // Script degli stick (LSB, sommati al riposo): tocchi con `at(t, ax)`.
  window.__stick = {
    jitter(ms) {
      const t0 = performance.now();
      for (const stick of [0, 1]) dev.touches.push({ stick, t0, dur: ms, tail: 1, at: (t, ax) => 9 * Math.sin(t / (ax ? 31 : 23) + stick) });
    },
    flick(dir, { guided = false, sticks = [0, 1] } = {}) {
      const v = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] }[dir];
      const t0 = performance.now();
      for (const stick of sticks) {
        if (guided) {
          dev.touches.push({ stick, t0, dur: 460, tail: 1, at: (t, ax) => v[ax] * 130 * (t < t0 + 140 ? 1 : Math.max(0, 1 - (t - t0 - 140) / 320)) });
        } else {
          dev.touches.push({ stick, t0, dur: 130, tail: 16, at: (t, ax) => v[ax] * 130 });
        }
      }
    },
    roll(ms, lap = 1500) {
      const t0 = performance.now();
      for (const stick of [0, 1]) {
        const sign = stick ? -1 : 1;
        dev.touches.push({ stick, t0, dur: ms, tail: 20, at: (t, ax) => {
          const th = sign * ((t - t0) / lap) * 2 * Math.PI;
          const c = Math.cos(th), s = Math.sin(th);
          const rr = 131 / Math.max(Math.abs(c), Math.abs(s)) ** 0.12;
          return (ax ? s : c) * rr * Math.min(1, (t - t0) / 150);
        } });
      }
    },
    // report fermi per `ms` (buco USB): il fake smette di emettere e riparte
    gap(ms) {
      dev.stopped = true;
      setTimeout(() => { dev.stopped = false; dev.schedule(); }, ms);
    },
    recenter() { dev.sticks[0].rest = [-0.5, -0.5]; },
  };
  const hid = {
    async getDevices() { return []; },
    async requestDevice() { return [dev ?? await make()]; },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(Navigator.prototype, 'hid', { get: () => hid, configurable: true });
}

async function freshPage(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'no-preference' });
  await context.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    return host === 'localhost' || host === '127.0.0.1' ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.addInitScript(fakeHid);
  await page.goto(base + '/');
  // l'avviso telemetria resta: il test non deve dipendere dalla sua chiusura
  await page.evaluate(() => document.getElementById('btn-connect').click());
  await page.waitForSelector('#view-device:not(.hidden)', { timeout: 15000 });
  await page.waitForSelector('#verdict-l:not(.hidden)', { timeout: 30000 });
  return { page, context, errors };
}

const shot = async (page, name) => {
  if (!shotDir) return;
  // Il pannello a 375 px scorre dentro il modale: lì si fotografa la vista.
  const tall = await page.evaluate(() => {
    const p = document.querySelector('#modal-game .modal-panel');
    return p.getBoundingClientRect().height > window.innerHeight;
  });
  if (tall) await page.screenshot({ path: path.join(shotDir, name) });
  else await page.locator('#modal-game .modal-panel').screenshot({ path: path.join(shotDir, name) });
};
const activeId = page => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'BODY';
  return a.id ? '#' + a.id : '.' + String(a.className).split(' ')[0];
});
const inModal = page => page.evaluate(() => document.getElementById('modal-game').contains(document.activeElement));
const text = (page, id) => page.textContent('#' + id);
const phase = page => text(page, 'game-phase');
const waitPhase = (page, name, timeout = 15000) => page.waitForFunction(n => document.getElementById('game-phase').textContent === n, name, { timeout });
const waitInstr = (page, re, timeout = 15000) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('game-instr').textContent), re.source, { timeout });

// Tab (al massimo 12) fino al bottone voluto, sempre dentro il modale.
async function tabTo(page, id) {
  for (let i = 0; i < 12; i++) {
    if (await activeId(page) === '#' + id) return true;
    await page.keyboard.press('Tab');
    if (!(await inModal(page))) return false;
  }
  return (await activeId(page)) === '#' + id;
}

async function flickAll(page, { guidedFirst = false, shotAt = null, prefix } = {}) {
  for (let i = 0; i < 4; i++) {
    const dir = ['up', 'right', 'down', 'left'][i];
    await waitInstr(page, new RegExp(`\\b${dir}\\b.*\\(${i + 1} of 4\\)`));
    await page.waitForTimeout(250);
    if (guidedFirst && i === 0) {
      await page.evaluate(d => window.__stick.flick(d, { guided: true }), dir);
      await waitInstr(page, /looked guided/);
      check(true, `${prefix}: a guided release is refused with "That looked guided"`);
      if (shotAt === 'guided') await shot(page, `${prefix}-05-return-guided.png`);
      await page.waitForTimeout(300);
    }
    await page.evaluate(d => window.__stick.flick(d), dir);
    if (i === 2 && shotAt) {
      await page.waitForTimeout(450);
      await shot(page, `${prefix}-06-return-settle-dots.png`);
    }
    await page.waitForTimeout(400);
  }
}

async function run(width, height) {
  const prefix = String(width);
  const { page, context, errors } = await freshPage(width, height);
  try {
    // 1. apertura dall'hook dev, fuoco su Start
    await page.evaluate(() => window.__senseGameOpen());
    await page.waitForSelector('#modal-game:not(.hidden)');
    await page.waitForTimeout(450);
    check(await activeId(page) === '#btn-game-start', `${prefix}: initial focus on Start (${await activeId(page)})`);
    check(/about 15 seconds/.test(await text(page, 'game-instr')), `${prefix}: intro states the measured duration`);
    await shot(page, `${prefix}-01-intro.png`);

    // 2. pronto appena rilasci: mani sugli stick → attesa spiegata
    await page.evaluate(() => window.__stick.jitter(1800));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check(await inModal(page), `${prefix}: focus stays in the modal after Start hides (${await activeId(page)})`);
    check(await phase(page) === 'Center' && /Let go of both sticks/.test(await text(page, 'game-instr')), `${prefix}: ready state asks to let go`);
    const why = await text(page, 'game-why');
    check(/moving|settle|rest/.test(why), `${prefix}: the wait says why (${why})`);
    check(await page.isVisible('#game-handsoff'), `${prefix}: hands-off meter visible`);
    check(await page.getAttribute('#game-steps li:nth-child(1)', 'aria-current') === 'step', `${prefix}: step 1 is current`);
    await shot(page, `${prefix}-02-ready-moving.png`);

    // 3. Center parte da solo quando gli stick si fermano
    await waitInstr(page, /Hands off/);
    await page.waitForTimeout(1300);
    await shot(page, `${prefix}-03-center.png`);

    // 4. Return: bersaglio acceso, un rilascio accompagnato rifiutato, 4 flick
    await waitPhase(page, 'Return');
    check(await page.isVisible('#btn-game-skip'), `${prefix}: Skip visible during Return`);
    await page.waitForTimeout(300);
    await shot(page, `${prefix}-04-return-aim.png`);
    await flickAll(page, { guidedFirst: true, shotAt: 'guided', prefix });

    // 5. Range: anelli che si riempiono
    await waitPhase(page, 'Range');
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__stick.roll(6000));
    await page.waitForTimeout(900);
    await shot(page, `${prefix}-07-range-filling.png`);
    await page.waitForSelector('#game-report:not(.hidden)', { timeout: 20000 });
    await page.waitForTimeout(500);
    check(await activeId(page) === '.game-overall', `${prefix}: focus moves to the score (${await activeId(page)})`);
    const nums = await page.$$eval('.game-overall-num', els => els.map(e => e.textContent));
    check(nums.length === 2, `${prefix}: two headline numbers (${nums.join(', ')})`);
    const verdict = await page.textContent('.game-verdict');
    check(/left stick rests .*off center/i.test(verdict), `${prefix}: one plain sentence names the off-center stick (${verdict})`);
    check(/First result/.test(await page.textContent('.game-compare')), `${prefix}: first run has no previous result`);
    await shot(page, `${prefix}-08-report-first.png`);

    // 6. "dopo la calibrazione": stick centrato, di nuovo da tastiera
    await page.evaluate(() => window.__stick.recenter());
    check(await tabTo(page, 'btn-game-retry'), `${prefix}: Tab reaches "Run test again"`);
    await page.keyboard.press('Enter');
    await waitInstr(page, /Hands off/);
    await waitPhase(page, 'Return', 15000);
    // Skip da tastiera: Return non misurato, mai 0
    check(await tabTo(page, 'btn-game-skip'), `${prefix}: Tab reaches "Skip this check"`);
    await page.keyboard.press('Enter');
    await waitPhase(page, 'Range');
    await page.evaluate(() => window.__stick.roll(6000));
    await page.waitForSelector('#game-report:not(.hidden)', { timeout: 20000 });
    await page.waitForTimeout(400);
    const report = await page.textContent('#game-report');
    check(/Return Not measured/.test(report), `${prefix}: skipped Return reads "Not measured"`);
    check(/Previous result earlier today/.test(report) && /better/.test(report), `${prefix}: before/after comparison marks the recentered stick better`);
    const stored = await page.evaluate(() => localStorage.getItem('senseGameLastScore.v4'));
    const serial = await page.evaluate(() => document.getElementById('device-sub').textContent);
    check(stored && !/Virtual|serial/i.test(stored), `${prefix}: stored result carries no serial`);
    check(!!serial, `${prefix}: device line present (${serial})`);
    await shot(page, `${prefix}-09-report-compare.png`);

    // 7. buco nei report durante Center → Interrupted → Retry da tastiera
    await tabTo(page, 'btn-game-retry');
    await page.keyboard.press('Enter');
    await waitInstr(page, /Hands off/);
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__stick.gap(400));
    await waitInstr(page, /Interrupted/);
    check(/stopped sending data/.test(await text(page, 'game-why')), `${prefix}: interruption says why`);
    await page.waitForTimeout(500);
    await shot(page, `${prefix}-10-interrupted.png`);
    check(await tabTo(page, 'btn-game-resume'), `${prefix}: Tab reaches Retry`);
    await page.keyboard.press('Enter');
    await waitInstr(page, /Hands off|Let go/);
    check(true, `${prefix}: Retry resumes the check`);

    // 8. Esc chiude il test
    await page.keyboard.press('Escape');
    await page.waitForSelector('#modal-game.hidden', { state: 'attached', timeout: 3000 });
    check(true, `${prefix}: Escape closes the precision test`);
    check(errors.length === 0, `${prefix}: no page errors${errors.length ? ' (' + errors.join(' | ') + ')' : ''}`);
  } catch (e) {
    check(false, `${prefix}: ${e.message.split('\n')[0]}`);
    await shot(page, `${prefix}-zz-failure.png`).catch(() => {});
  } finally {
    await context.close();
  }
}

try {
  await run(1280, 800);
  await run(375, 740);
} finally {
  await browser.close();
}
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
console.log('WS8 headless precision test check: all checks passed (model-verified controller)');

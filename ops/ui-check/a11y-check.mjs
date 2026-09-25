// Verifica headless di WS6 (solo sviluppo, non fa parte di npm test:
// Playwright non è una dipendenza del progetto).
//
//   python3 -m http.server 8793 --directory <repo> &
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//     node ops/ui-check/a11y-check.mjs http://localhost:8793 [cartella-screenshot]
//
// Per ogni larghezza (375, 1280, 1440), in un Chromium headless con un
// navigator.hid finto sostenuto da ops/sim/fake-dualsense.mjs e l'avviso
// telemetria visibile (localStorage vuoto):
// 1. nessun bottone principale di un modale è coperto dall'avviso
//    (elementFromPoint al centro del bottone);
// 2. il fuoco iniziale cade dove deve (azione, Cancel, o il pannello) e resta
//    nel modale per 20 Tab e 20 Shift+Tab;
// 3. il fuoco non cade su BODY quando il bottone attivo viene disabilitato o
//    nascosto (rapida in corsa, Start del gioco);
// 4. contrasto non testuale ≥3:1 calcolato sugli stili risolti.
// Ogni richiesta fuori da localhost è bloccata: l'avviso non viene mai
// risolto con "Keep sharing" e nulla può partire verso l'endpoint vero.
// Il controller è il modello (model-verified), non un DualSense.

const [, , base = 'http://localhost:8793', shotDir = null] = process.argv;
const pwPath = process.env.PLAYWRIGHT;
if (!pwPath) throw new Error('set PLAYWRIGHT to the playwright index.mjs path');
const { chromium } = await import(pwPath);
const fs = await import('node:fs');
const path = await import('node:path');
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });

const WIDTHS = [[375, 740], [1280, 800], [1440, 900]];
const failures = [];
const check = (cond, what) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failures.push(what); };

const browser = await chromium.launch();

function fakeHid() {
  const listeners = new Map();
  let dev = null;
  const make = async () => {
    const { FakeDualSense } = await import('/ops/sim/fake-dualsense.mjs');
    const clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), now: () => performance.now() };
    dev = new FakeDualSense({
      clock, seed: 5,
      sticks: [{ drift: [2.4, -1.3], noise: 0.3, bias: { axis: 0, B: 0 } }, { drift: [-0.6, 2.9], noise: 0.3, bias: { axis: 0, B: 0 } }],
      fw: { sf: 0, cmdMs: [2, 6] }, timing: { period: 4, jitter: 0.3, gapProb: 0, gapMs: [30, 200] },
    });
    return dev;
  };
  const hid = {
    async getDevices() { return []; },
    async requestDevice() { return [dev ?? await make()]; },
    addEventListener(type, fn) { listeners.set(type, fn); },
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
  // Hero, prima della connessione: colonne risolte della striscia dei passi e
  // spazio vuoto a destra dell'ultimo passo.
  const hero = await page.evaluate(() => {
    const strip = document.querySelector('.steps-strip');
    const cols = getComputedStyle(strip).gridTemplateColumns.split(' ').length;
    const last = strip.lastElementChild.getBoundingClientRect().right;
    return { cols, gap: Math.round(strip.getBoundingClientRect().right - last) };
  });
  await page.evaluate(() => document.getElementById('btn-connect').click());
  await page.waitForSelector('#view-device:not(.hidden)', { timeout: 15000 });
  // fine del test drift automatico: i badge compaiono
  await page.waitForSelector('#verdict-l:not(.hidden)', { timeout: 30000 });
  return { page, context, errors, hero };
}

const shot = async (page, name) => {
  if (!shotDir) return;
  await page.screenshot({ path: path.join(shotDir, name), fullPage: false });
};

// Id dell'elemento attivo, o una descrizione se non ne ha.
const activeDesc = page => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return 'BODY';
  if (a.id) return '#' + a.id;
  return a.className ? '.' + String(a.className).split(' ')[0] : a.tagName;
});
const focusInside = (page, modalId) => page.evaluate(id => {
  const a = document.activeElement;
  return !!a && a !== document.body && document.getElementById(id).contains(a);
}, modalId);

async function coveredButtons(page, modalId) {
  return page.evaluate(id => {
    const modal = document.getElementById(id);
    const out = [];
    for (const btn of modal.querySelectorAll('.modal-actions button, .game-head button')) {
      if (!btn.checkVisibility()) continue;
      btn.scrollIntoView({ block: 'center' });
      const r = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!(hit === btn || btn.contains(hit))) out.push(`${btn.id} ← ${hit?.id || hit?.className || hit?.tagName}`);
    }
    return out;
  }, modalId);
}

async function tabCycle(page, modalId, label) {
  let escaped = [];
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(key);
      if (!(await focusInside(page, modalId))) escaped.push(`${key}#${i + 1}→${await activeDesc(page)}`);
    }
  }
  check(escaped.length === 0, `${label}: focus stays in the modal over 20 Tab + 20 Shift+Tab${escaped.length ? ' (' + escaped.slice(0, 3).join(', ') + ')' : ''}`);
}

async function modalCase(width, height, { name, open, modalId, expectFocus, after }) {
  const { page, context, errors } = await freshPage(width, height);
  const label = `${width}px ${name}`;
  try {
    check(await page.isVisible('#telemetry-notice'), `${label}: telemetry notice is showing`);
    await open(page);
    await page.waitForSelector(`#${modalId}:not(.hidden)`);
    await page.waitForTimeout(450); // animazione d'entrata + rAF del fuoco
    const covered = await coveredButtons(page, modalId);
    check(covered.length === 0, `${label}: no modal button covered by the notice${covered.length ? ' (' + covered.join('; ') + ')' : ''}`);
    const first = await activeDesc(page);
    check(expectFocus.includes(first), `${label}: initial focus on ${expectFocus.join(' or ')} (got ${first})`);
    await shot(page, `${width}-${name}.png`);
    await tabCycle(page, modalId, label);
    if (after) await after(page, label);
    check(errors.length === 0, `${label}: no page errors${errors.length ? ' (' + errors.join(' | ') + ')' : ''}`);
  } finally {
    await context.close();
  }
}

const clickId = id => page => page.evaluate(i => document.getElementById(i).click(), id);

try {
  for (const [width, height] of WIDTHS) {
    // vista dispositivo con avviso, dettaglio verdetto, zoom
    {
      const { page, context, errors, hero } = await freshPage(width, height);
      check(width < 700 || (hero.cols === 4 && hero.gap <= 1), `${width}px: steps strip has 4 columns and no empty fifth (${hero.cols} cols, ${hero.gap}px after the last)`);
      const exp = await page.evaluate(() => [...document.querySelectorAll('[data-experimental]')].map(el => el.checkVisibility()));
      check(exp.every(v => !v), `${width}px: experimental rows and tabs hidden`);
      const detail = await page.textContent('#verdict-l-detail');
      check(/^x [+−]\d+\.\d% · y [+−]\d+\.\d% · noise/.test(detail) && await page.isVisible('#verdict-l-detail'), `${width}px: verdict detail visible as text (${detail})`);
      const scheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      check(scheme === 'light', `${width}px: color-scheme light (${scheme})`);
      await shot(page, `${width}-device-notice.png`);
      await page.evaluate(() => document.getElementById('btn-zoom-l').click());
      await page.waitForTimeout(300);
      check(await page.getAttribute('#btn-zoom-l', 'aria-pressed') === 'true', `${width}px: zoom toggle pressed`);
      await page.locator('.grid-sticks').scrollIntoViewIfNeeded();
      if (shotDir) await page.locator('.grid-sticks').screenshot({ path: path.join(shotDir, `${width}-dials-zoom.png`) });
      // bordo del bottone secondario ≥3:1 sulla card
      const ratio = await page.evaluate(() => {
        const parse = s => s.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
        const lum = rgb => { const c = rgb.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
        const cr = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const btn = document.getElementById('btn-wizard');
        return cr(parse(getComputedStyle(btn).borderTopColor), parse(getComputedStyle(btn.closest('.card')).backgroundColor));
      });
      check(ratio >= 3, `${width}px: secondary button edge ${ratio.toFixed(2)}:1 on the card`);
      check(errors.length === 0, `${width}px device: no page errors${errors.length ? ' (' + errors.join(' | ') + ')' : ''}`);
      await context.close();
    }

    await modalCase(width, height, {
      name: 'quick', modalId: 'modal-quick', open: clickId('btn-quick'), expectFocus: ['#btn-quick-go'],
      after: async (page, label) => {
        await page.evaluate(() => document.getElementById('btn-quick-go').focus());
        await page.keyboard.press('Enter');
        await page.waitForTimeout(600);
        check(await focusInside(page, 'modal-quick'), `${label}: focus stays in the modal while the run disables the buttons (${await activeDesc(page)})`);
        await shot(page, `${width}-quick-running.png`);
        await tabCycle(page, 'modal-quick', `${label} running`);
        // fine della rapida (modello): il banner "unsaved" compare
        await page.waitForSelector('#banner-unsaved:not(.hidden)', { timeout: 60000 });
        await page.waitForSelector('#modal-quick.hidden', { timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(400);
        // anello di fuoco bianco sul banner scuro
        await page.keyboard.press('Tab');
        await page.evaluate(() => document.getElementById('btn-flash').focus({ focusVisible: true }));
        const ring = await page.evaluate(() => {
          const btn = document.getElementById('btn-flash');
          return { outline: getComputedStyle(btn).outlineColor, visible: btn.matches(':focus-visible') };
        });
        check(!ring.visible || /255, 255, 255/.test(ring.outline), `${label}: white focus ring on the dark banner (${ring.outline}, focus-visible ${ring.visible})`);
        if (shotDir) await page.locator('#banner-unsaved').screenshot({ path: path.join(shotDir, `${width}-banner-focus.png`) });
        // modale di scrittura: mai confermato, solo aperto e ispezionato
        await page.evaluate(() => document.getElementById('btn-flash').click());
        await page.waitForSelector('#modal-flash:not(.hidden)');
        await page.waitForTimeout(450);
        const covered = await coveredButtons(page, 'modal-flash');
        check(covered.length === 0, `${width}px flash: no modal button covered by the notice${covered.length ? ' (' + covered.join('; ') + ')' : ''}`);
        const first = await activeDesc(page);
        check(first === '#btn-flash-cancel', `${width}px flash: initial focus on Cancel (got ${first})`);
        await shot(page, `${width}-flash.png`);
        await tabCycle(page, 'modal-flash', `${width}px flash`);
        await page.evaluate(() => document.getElementById('btn-flash-cancel').click());
      },
    });

    await modalCase(width, height, { name: 'wizard', modalId: 'modal-wizard', open: clickId('btn-wizard'), expectFocus: ['#btn-wizard-next'] });

    // Passo introduttivo del range: nessun comando, fuoco su Start, Cancel presente.
    await modalCase(width, height, { name: 'range-intro', modalId: 'modal-range', open: clickId('btn-range'), expectFocus: ['#btn-range-start'] });

    await modalCase(width, height, {
      name: 'range', modalId: 'modal-range',
      open: async page => {
        await clickId('btn-range')(page);
        await page.waitForSelector('#modal-range:not(.hidden)');
        await clickId('btn-range-start')(page);
        await page.waitForSelector('#btn-range-start', { state: 'hidden' });
      },
      expectFocus: ['.modal-panel'],
      // #range-hint è role="status": ogni mutazione può essere riletta, quindi
      // il numero di mutazioni deve coincidere con i cambi di testo reali.
      after: async (page, label) => {
        const m = await page.evaluate(() => new Promise(resolve => {
          const el = document.getElementById('range-hint');
          let mutations = 0, changes = 0, last = el.textContent;
          const seen = new Set([last]);
          const obs = new MutationObserver(records => {
            mutations += records.length;
            if (el.textContent !== last) { changes++; last = el.textContent; seen.add(last); }
          });
          obs.observe(el, { childList: true, characterData: true, subtree: true });
          setTimeout(() => { obs.disconnect(); resolve({ mutations, changes, distinct: seen.size }); }, 4000);
        }));
        check(m.mutations === m.changes, `${label}: #range-hint mutated only on real changes (${m.mutations} mutations, ${m.changes} changes, ${m.distinct} distinct strings in 4 s)`);
      },
    });

    await modalCase(width, height, {
      name: 'game', modalId: 'modal-game', open: clickId('btn-game'), expectFocus: ['#btn-game-start'],
      after: async (page, label) => {
        await page.evaluate(() => document.getElementById('btn-game-start').focus());
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        check(await focusInside(page, 'modal-game'), `${label}: focus stays in the modal after Start hides itself (${await activeDesc(page)})`);
        const name = await page.evaluate(() => document.getElementById(document.getElementById('modal-game').getAttribute('aria-labelledby')).textContent);
        check(name === 'Precision test', `${label}: dialog name stays "Precision test" during the test (${name})`);
        await shot(page, `${width}-game-running.png`);
      },
    });
  }
} finally {
  await browser.close();
}
if (failures.length) { console.error(`${failures.length} check(s) failed`); process.exit(1); }
console.log('WS6 headless a11y check: all checks passed (model-verified controller)');

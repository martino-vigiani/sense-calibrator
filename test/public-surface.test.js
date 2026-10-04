import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexPath = new URL('../index.html', import.meta.url);
const cssPath = new URL('../css/style.css', import.meta.url);
const socialCardPath = new URL('../paper/assets/social-card-v2.png', import.meta.url);

test('the public search surface stays focused on stick drift calibration', async () => {
  const html = await readFile(indexPath, 'utf8');
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  const jsonLdSource = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)?.[1];
  const heroAndFaq = html.match(/<section id="view-hero"[\s\S]*?<\/section>\s*<\/section>/)?.[0];

  assert.equal(title, 'Fix PS5 Stick Drift from Your Browser | Sense Calibrator');
  assert.ok(jsonLdSource, 'JSON-LD block should exist');
  assert.doesNotMatch(JSON.stringify(JSON.parse(jsonLdSource)), /sensitivity|gameplay|play test/i);
  assert.ok(heroAndFaq, 'hero and FAQ should exist');
  assert.doesNotMatch(heroAndFaq, /sensitivity|gameplay|play test/i);
});

test('experimental tools are hidden unless preview mode removes the gate', async () => {
  const html = await readFile(indexPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

  assert.match(html, /data-tool="sensitivity" data-experimental hidden/);
  assert.match(html, /data-tool="playtest" data-experimental hidden/);
  assert.match(html, /id="modal-sensitivity"[^>]*data-experimental hidden/);
  assert.match(html, /id="modal-playtest"[^>]*data-experimental hidden/);
  assert.match(app, /LOCAL_PREVIEW_HOSTS\.has\(location\.hostname\)/);
  assert.match(app, /new URLSearchParams\(location\.search\)\.has\('preview'\)/);
});

test('the social preview uses the current 1200 by 630 asset', async () => {
  const html = await readFile(indexPath, 'utf8');
  const image = await readFile(socialCardPath);

  assert.equal((html.match(/paper\/assets\/social-card-v2\.png/g) ?? []).length, 3);
  assert.equal(image.toString('ascii', 1, 4), 'PNG');
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
});

// L'attributo `hidden` da solo perde contro `.action { display: flex }`:
// serve la regola globale, altrimenti le righe sperimentali compaiono in produzione.
test('the hidden attribute beats class display rules, so experimental rows stay hidden', async () => {
  const html = await readFile(indexPath, 'utf8');
  const css = await readFile(cssPath, 'utf8');

  assert.match(css, /(^|\n)\s*\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  assert.match(html, /class="action action-sensitivity" data-experimental hidden/);
  assert.match(html, /class="action action-playtest" data-experimental hidden/);
});

function zIndexOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[2];
  assert.ok(block, `missing CSS rule: ${selector}`);
  return Number(block.match(/z-index:\s*(\d+)/)?.[1]);
}

test('the telemetry notice sits below modals and goes inert while one is open', async () => {
  const css = await readFile(cssPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');

  assert.equal(zIndexOf(css, '.notice'), 45);
  assert.ok(zIndexOf(css, '.notice') < zIndexOf(css, '.modal'), 'notice must not cover modal buttons');
  assert.ok(zIndexOf(css, '.topbar') < zIndexOf(css, '.notice'));
  const inert = app.match(/function updateBackgroundInert\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(inert, 'updateBackgroundInert should exist');
  for (const target of [/querySelector\('header'\)/, /querySelector\('main'\)/, /querySelector\('footer'\)/, /\$\('telemetry-notice'\)/])
    assert.match(inert, new RegExp(`${target.source}\\?\\.toggleAttribute\\('inert', hasModal\\)`));
});

test('the precision test intro lists the phases the game actually runs', async () => {
  const html = await readFile(indexPath, 'utf8');
  const { GAME_PHASES } = await import('../js/game.js');
  const intro = html.match(/<ol class="game-trials">([\s\S]*?)<\/ol>/)?.[1];
  assert.ok(intro, 'game intro list should exist');

  const listed = [...intro.matchAll(/<b>([^<:]+):<\/b>/g)].map(match => match[1]);
  assert.deepEqual(listed, ['Center', 'Return', 'Range']);
  assert.deepEqual(listed, [...GAME_PHASES]);
  // anche il segnapassi in alto usa gli stessi nomi, nello stesso ordine
  const steps = html.match(/<ol id="game-steps"[^>]*>([\s\S]*?)<\/ol>/)?.[1];
  assert.deepEqual([...steps.matchAll(/<li[^>]*>([^<]+)<\/li>/g)].map(m => m[1]), [...GAME_PHASES]);
});

/* ---------------- WS6: accessibilità (WCAG AA) ---------------- */

// Rapporto di contrasto WCAG 2.x dalla luminanza relativa.
function luminance(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(n.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function cssToken(css, name) {
  const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `missing token --${name}`);
  return value;
}
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[2] ?? null;
}
function tagOf(html, id) {
  const tag = html.match(new RegExp(`<[a-z0-9]+\\b[^>]*\\bid="${id}"[^>]*>`))?.[0];
  assert.ok(tag, `missing element #${id}`);
  return tag;
}

test('the page declares a light colour scheme, in the markup and in CSS', async () => {
  const html = await readFile(indexPath, 'utf8');
  const css = await readFile(cssPath, 'utf8');
  assert.match(html, /<meta name="color-scheme" content="light">/);
  assert.match(ruleBody(css, ':root'), /color-scheme:\s*light/);
});

test('the steps strip has one grid column per step', async () => {
  const html = await readFile(indexPath, 'utf8');
  const css = await readFile(cssPath, 'utf8');
  const steps = html.match(/<ol class="steps-strip"[^>]*>([\s\S]*?)<\/ol>/)?.[1];
  const count = (steps.match(/<li>/g) ?? []).length;
  assert.equal(count, 4);
  assert.match(ruleBody(css, '.steps-strip'), new RegExp(`grid-template-columns:\\s*repeat\\(${count},\\s*1fr\\)`));
});

test('status text is announced through live regions, errors through a separate alert region', async () => {
  const html = await readFile(indexPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  for (const id of ['quick-msg', 'wizard-msg', 'game-instr', 'range-hint'])
    assert.match(tagOf(html, id), /role="status"/, `#${id} should be a status region`);
  const alerts = tagOf(html, 'alerts');
  assert.match(alerts, /role="alert"/);
  assert.match(alerts, /class="sr-only"/);
  assert.doesNotMatch(tagOf(html, 'toasts'), /role="alert"/);
  // Gli errori di scrittura e il controller avvelenato passano dalla regione alert.
  assert.match(app, /Error while saving: \$\{error\.message\}`, 5000, \{ alert: true \}/);
  assert.match(app, /toast\(POISONED_MESSAGE, 8000, \{ alert: true \}\)/);
  // I pallini del wizard sono aria-hidden: il passo arriva come testo.
  assert.match(tagOf(html, 'wizard-dots'), /aria-hidden="true"/);
  assert.match(tagOf(html, 'wizard-step'), /class="sr-only"/);
  assert.match(app, /`Step \$\{Math\.min\(active, WIZARD_STEPS\)\} of \$\{WIZARD_STEPS\}`/);
});

test('verdict details are visible text, not a title tooltip', async () => {
  const html = await readFile(indexPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  for (const side of ['l', 'r']) {
    assert.match(html, new RegExp(`id="verdict-${side}" class="verdict hidden"></div>\\s*<p id="verdict-${side}-detail" class="verdict-detail mono">`));
  }
  assert.doesNotMatch(app, /badge\.title\s*=/);
  assert.match(app, /\$\(`\$\{el\}-detail`\)\.textContent = /);
});

test('every stick dial canvas is exposed as an image with a label', async () => {
  const html = await readFile(indexPath, 'utf8');
  for (const id of ['dial-l', 'dial-r', 'dial-wiz-l', 'dial-wiz-r', 'dial-range-l', 'dial-range-r', 'game-dial-l', 'game-dial-r']) {
    const tag = tagOf(html, id);
    assert.match(tag, /role="img"/, `#${id} needs role="img"`);
    assert.match(tag, /aria-label="[^"]+"/, `#${id} needs a label`);
  }
});

test('the precision test dialog has a stable name and focuses the result', async () => {
  const html = await readFile(indexPath, 'utf8');
  const game = await readFile(new URL('../js/game.js', import.meta.url), 'utf8');
  // #game-phase cambia testo a ogni prova: il nome del dialogo no.
  assert.match(tagOf(html, 'modal-game'), /aria-labelledby="game-dialog-title"/);
  assert.match(html, /<h2 id="game-dialog-title" class="sr-only">Precision test<\/h2>/);
  assert.match(game, /<div class="game-overall" tabindex="-1"[^>]*>/);
  assert.match(game, /elReport\.querySelector\('\.game-overall'\)\?\.focus\(/);
});

test('progress bars expose progressbar semantics without animated updates', async () => {
  const html = await readFile(indexPath, 'utf8');
  const css = await readFile(cssPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  for (const bar of [/<div class="progress"[^>]*><i id="quick-bar">/, /<div class="progress"[^>]*><i id="range-bar">/, /<div id="game-progress"[^>]*>/]) {
    const tag = html.match(bar)?.[0];
    assert.ok(tag, `missing ${bar}`);
    assert.match(tag, /role="progressbar"/);
    assert.match(tag, /aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"/);
    assert.match(tag, /aria-label="[^"]+"/);
  }
  // La barra del test drift è ridondante con il suo testo live.
  assert.match(tagOf(html, 'drift-progress'), /aria-hidden="true"/);
  // Regressione: una transizione sulla larghezza ritarda il progresso della misura live.
  assert.match(ruleBody(css, '.progress i'), /transition:\s*none\s*(?:!important\s*)?;/);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}\s*$/)?.[1];
  assert.match(reduced, /\.progress i \{ transition: none !important; \}/);
  assert.match(app, /bar\.setAttribute\('aria-valuenow', now\)/);
});

test('modals keep the focus: panel fallback, visible-only trap, autofocus on the action', async () => {
  const html = await readFile(indexPath, 'utf8');
  const css = await readFile(cssPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const panels = html.match(/<div class="modal-panel[^"]*"[^>]*>/g);
  assert.equal(panels.length, 7);
  for (const panel of panels) assert.match(panel, /tabindex="-1"/);
  assert.match(ruleBody(css, '.modal-panel:focus'), /outline:\s*none/);
  for (const id of ['btn-quick-go', 'btn-wizard-next', 'btn-game-start'])
    assert.match(tagOf(html, id), /data-autofocus/, `#${id} should take the initial focus`);
  // La rapida non apre più sul checkbox della telemetria.
  assert.doesNotMatch(tagOf(html, 'telemetry-consent'), /data-autofocus/);
  // Nel modale flash il default resta Cancel (WS5 mette l'attributo quando serve).
  assert.doesNotMatch(tagOf(html, 'btn-flash-go'), /data-autofocus/);
  assert.match(app, /typeof el\.checkVisibility === 'function'/);
  const trap = app.match(/if \(e\.key === 'Tab' && activeModal\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(trap, 'Tab trap should exist');
  assert.match(trap, /visibleFocusables\(activeModal\)/);
  assert.match(trap, /focusPanel\(activeModal\)/);
});

test('non-text contrast reaches 3:1 on component edges, dots and dial guides', async () => {
  const css = await readFile(cssPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const white = '#ffffff';
  const bg = cssToken(css, 'bg');
  const edge = cssToken(css, 'edge');
  assert.ok(contrast(edge, white) >= 3, `--edge on white: ${contrast(edge, white).toFixed(2)}`);
  assert.ok(contrast(edge, bg) >= 3, `--edge on --bg: ${contrast(edge, bg).toFixed(2)}`);
  // Il canvas non legge le variabili CSS: MID deve essere lo stesso valore.
  const mid = app.match(/const MID = '(#[0-9a-f]{6})'/i)?.[1];
  assert.equal(mid.toLowerCase(), '#8f8f8a');
  assert.equal(mid.toLowerCase(), edge.toLowerCase());
  assert.match(ruleBody(css, '.btn-secondary'), /border-color:\s*var\(--edge\)/);
  assert.match(ruleBody(css, '.wizard-dots i'), /box-shadow:\s*inset 0 0 0 1\.5px var\(--edge\)/);
  const amber = ruleBody(css, '.handsoff[data-level="amber"]::before')?.match(/#[0-9a-f]{6}/i)?.[0];
  const green = ruleBody(css, '.handsoff[data-level="green"]::before')?.match(/#[0-9a-f]{6}/i)?.[0];
  const red = ruleBody(css, '.handsoff[data-level="red"]::before')?.match(/#[0-9a-f]{6}/i)?.[0];
  for (const [name, color] of [['amber', amber], ['green', green], ['red', red]])
    assert.ok(contrast(color, white) >= 3, `hands-off ${name} ${color}: ${contrast(color, white).toFixed(2)}`);
  // Il testo resta AA.
  for (const token of ['ink', 'ink-2', 'ink-3']) {
    assert.ok(contrast(cssToken(css, token), white) >= 4.5, `--${token} on white`);
    assert.ok(contrast(cssToken(css, token), bg) >= 4.5, `--${token} on --bg`);
  }
});

test('the focus ring turns white on dark surfaces', async () => {
  const css = await readFile(cssPath, 'utf8');
  const rule = css.match(/\.banner \.btn:focus-visible,\s*\.action-sensitivity \.btn:focus-visible,\s*\.action-playtest \.btn:focus-visible \{([^}]*)\}/)?.[1];
  assert.ok(rule, 'dark-surface focus rule should exist');
  assert.match(rule, /outline-color:\s*#fff/);
  assert.ok(contrast('#ffffff', cssToken(css, 'ink')) >= 3);
});

test('the dials offer a ×10 center zoom as a pressed-state toggle', async () => {
  const html = await readFile(indexPath, 'utf8');
  const app = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  for (const side of ['l', 'r']) {
    const tag = tagOf(html, `btn-zoom-${side}`);
    assert.match(tag, /type="button"/);
    assert.match(tag, /aria-pressed="false"/);
    assert.match(tag, new RegExp(`aria-controls="dial-${side}"`));
  }
  assert.match(app, /const DIAL_ZOOM = 10;/);
  // L'anello tratteggiato dello zoom è il confine del verdetto, dalla tabella unica.
  assert.match(app, /import \{[^}]*\bCENTERED_MAX\b[^}]*\} from '\.\/calib\/lattice\.js';/);
  assert.match(app, /\(CENTERED_MAX \/ 100\) \* k/);
});

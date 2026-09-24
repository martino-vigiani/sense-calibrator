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
  const game = await readFile(new URL('../js/game.js', import.meta.url), 'utf8');
  const intro = html.match(/<ol class="game-trials">([\s\S]*?)<\/ol>/)?.[1];
  assert.ok(intro, 'game intro list should exist');

  const listed = [...intro.matchAll(/<b>([^<:]+):<\/b>/g)].map(match => match[1]);
  // L'ultimo titolo ('Precision test') è quello di reset, non una prova.
  const phases = [...game.matchAll(/elPhase\.textContent = '([^']+)'/g)]
    .map(match => match[1])
    .filter(title => title !== 'Precision test');
  assert.deepEqual(listed, ['Center', 'Reach', 'Snap-back']);
  assert.deepEqual(listed, phases);
});

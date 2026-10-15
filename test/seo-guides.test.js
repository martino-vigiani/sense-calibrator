import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootUrl = new URL('..', import.meta.url);
const rootPath = fileURLToPath(rootUrl);

// Audit SEO 15/10: titolo col brand davanti (quasi tutti i click sono brand) e
// niente promessa di un fix nel titolo né nell'H1.
const HOMEPAGE_TITLE = 'Sense Calibrator: PS5 Stick Drift Test &amp; DualSense Calibration';

const GUIDES = [
  {
    path: 'guides/ps5-controller-stick-drift-test/index.html',
    url: 'https://martino-vigiani.github.io/sense-calibrator/guides/ps5-controller-stick-drift-test/',
    title: 'PS5 Controller Stick Drift Test Online | Sense Calibrator',
    description:
      'Free online PS5 controller stick drift test for a standard DualSense. Plug it in by USB in desktop Chrome or Edge and read the resting offset and noise of each stick.',
    h1: 'PS5 controller stick drift test online',
    card: 'PS5 controller stick drift test online',
    faq: true,
  },
  {
    path: 'guides/calibrate-dualsense-controller/index.html',
    url: 'https://martino-vigiani.github.io/sense-calibrator/guides/calibrate-dualsense-controller/',
    title: 'DualSense Calibration Online for PS5 Sticks | Sense Calibrator',
    description:
      'Calibrate a standard PS5 DualSense online in desktop Chrome or Edge over USB. When calibration can correct stick drift, Quick vs Guided, and how saving works.',
    h1: 'DualSense calibration online: how to calibrate the sticks',
    card: 'DualSense calibration online',
    faq: true,
  },
  {
    path: 'guides/ps5-stick-drift-fix/index.html',
    url: 'https://martino-vigiani.github.io/sense-calibrator/guides/ps5-stick-drift-fix/',
    title: 'PS5 Stick Drift Fix: Calibration or Repair? | Sense Calibrator',
    description:
      'Match your PS5 stick drift symptom to the right fix: when DualSense calibration helps, when a game deadzone is only a stopgap, and when the stick needs repair.',
    h1: 'PS5 stick drift fix:<br>calibration or repair?',
    card: 'PS5 stick drift fix: calibration or repair?',
    faq: true,
  },
  {
    path: 'guides/sense-calibrator-vs-dualshock-tools/index.html',
    url: 'https://martino-vigiani.github.io/sense-calibrator/guides/sense-calibrator-vs-dualshock-tools/',
    title: 'Sense Calibrator vs dualshock-tools.github.io for PS5 DualSense',
    description:
      'An honest comparison with dualshock-tools (dualshock-tools.github.io), the established browser tool for PS5 controller calibration: what each supports and when to use which.',
    h1: 'Sense Calibrator vs dualshock-tools',
    card: 'Sense Calibrator vs dualshock-tools',
    faq: true,
  },
];

const guideDir = (guide) => dirname(guide.path).split('/').pop();

// H10 (power-off senza Write) non è verificato: le pagine pubbliche non lo promettono.
const POWER_OFF_PROMISE = /should (?:discard|revert|return it|be lost)/i;

const EXPERIMENTAL = /sensitivity|gameplay|playtest|play\s+test|polling\s+rate|input\s+latency|hall\s*effect/i;

function matchAll(html, pattern) {
  return [...html.matchAll(pattern)].map((match) => match[1]);
}

function jsonLdBlocks(html) {
  return matchAll(html, /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g);
}

test('every guide page exists as a static file', async () => {
  for (const guide of GUIDES) {
    const info = await stat(new URL(guide.path, rootUrl));
    assert.ok(info.isFile(), `${guide.path} should be a file`);
  }
});

test('each guide has one unique title, description, h1 and canonical', async () => {
  const seen = { titles: new Set(), descriptions: new Set(), h1s: new Set(), canonicals: new Set() };

  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');
    const titles = matchAll(html, /<title>([^<]+)<\/title>/g);
    const descriptions = matchAll(html, /<meta name="description" content="([^"]+)">/g);
    const h1s = matchAll(html, /<h1>(.+?)<\/h1>/g);
    const canonicals = matchAll(html, /<link rel="canonical" href="([^"]+)">/g);

    assert.equal(titles.length, 1, `${guide.path} should have exactly one title`);
    assert.equal(descriptions.length, 1, `${guide.path} should have exactly one meta description`);
    assert.equal(h1s.length, 1, `${guide.path} should have exactly one h1`);
    assert.equal(canonicals.length, 1, `${guide.path} should have exactly one canonical`);

    assert.equal(titles[0], guide.title, `${guide.path} title`);
    assert.equal(descriptions[0], guide.description, `${guide.path} description`);
    assert.equal(h1s[0], guide.h1, `${guide.path} h1`);
    assert.equal(canonicals[0], guide.url, `${guide.path} canonical`);

    seen.titles.add(titles[0]);
    seen.descriptions.add(descriptions[0]);
    seen.h1s.add(h1s[0]);
    seen.canonicals.add(canonicals[0]);
  }

  assert.equal(seen.titles.size, GUIDES.length, 'guide titles must be distinct');
  assert.equal(seen.descriptions.size, GUIDES.length, 'guide descriptions must be distinct');
  assert.equal(seen.h1s.size, GUIDES.length, 'guide h1s must be distinct');
  assert.equal(seen.canonicals.size, GUIDES.length, 'guide canonicals must be distinct');
});

test('guide pages are indexable and open metadata uses absolute URLs', async () => {
  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');

    assert.doesNotMatch(html, /noindex/i, `${guide.path} must stay indexable`);
    assert.match(html, /<meta name="robots" content="index, follow/);
    assert.match(html, /<meta property="og:url" content="https:\/\/martino-vigiani\.github\.io\/sense-calibrator\//);
    assert.match(html, /<meta property="og:image" content="https:\/\/martino-vigiani\.github\.io\/sense-calibrator\/paper\/assets\/social-card-v2\.png">/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(html, /<meta name="twitter:image" content="https:\/\/martino-vigiani\.github\.io\/sense-calibrator\/paper\/assets\/social-card-v2\.png">/);
  }
});

test('each guide carries parseable minimal JSON-LD with no fabricated metadata', async () => {
  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');
    const blocks = jsonLdBlocks(html);

    assert.equal(blocks.length, 1, `${guide.path} should have exactly one JSON-LD block`);
    const data = JSON.parse(blocks[0]);
    const types = (data['@graph'] ?? []).map((node) => node['@type']);

    assert.ok(types.includes('WebPage'), `${guide.path} should describe a WebPage`);
    assert.ok(types.includes('BreadcrumbList'), `${guide.path} should describe its breadcrumb`);

    const serialized = JSON.stringify(data);
    assert.doesNotMatch(serialized, /"dateModified"|"datePublished"|"author"|"review"|"aggregateRating"/);
  }
});

test('every canonical guide URL is published in the sitemap with a lastmod', async () => {
  const sitemap = await readFile(new URL('sitemap.xml', rootUrl), 'utf8');

  for (const guide of GUIDES) {
    const entry = new RegExp(`<loc>${guide.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>\\s*<lastmod>(\\d{4}-\\d{2}-\\d{2})</lastmod>`);
    assert.match(sitemap, entry, `${guide.url} should be in sitemap.xml with a lastmod date`);
  }
});

test('the homepage title and core positioning stay as decided', async () => {
  const html = await readFile(new URL('index.html', rootUrl), 'utf8');

  assert.equal(matchAll(html, /<title>([^<]+)<\/title>/g)[0], HOMEPAGE_TITLE);
  assert.equal(
    matchAll(html, /<link rel="canonical" href="([^"]+)">/g)[0],
    'https://martino-vigiani.github.io/sense-calibrator/',
  );
  assert.match(html, /<h1>Test PS5 stick drift\.<br>Then recalibrate\.<\/h1>/);
  for (const tag of ['og:title', 'twitter:title']) {
    const attr = tag.startsWith('og:') ? 'property' : 'name';
    assert.match(html, new RegExp(`<meta ${attr}="${tag}" content="${HOMEPAGE_TITLE}">`), tag);
  }
  assert.match(html, /<link rel="modulepreload" href="js\/app\.js">/);
  assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
  assert.match(html, /<meta name="description" content="Test and recalibrate a standard PS5 DualSense for stick drift from desktop Chrome or Edge over USB\. Free, open source and no install\.">/);
});

test('the homepage visibly links to every guide inside the landing view', async () => {
  const html = await readFile(new URL('index.html', rootUrl), 'utf8');
  const hero = html.match(/<section id="view-hero"[\s\S]*?<\/section>\s*<\/section>/)?.[0];

  assert.ok(hero, 'the homepage landing view should exist');
  for (const guide of GUIDES) {
    const dir = dirname(guide.path);
    assert.match(hero, new RegExp(`href="${dir}/"`), `homepage should link to ${dir}/`);
    assert.ok(hero.includes(`<b>${guide.card}</b>`), `homepage card for ${dir}`);
  }
});

test('experimental tools stay out of public SEO content', async () => {
  const html = await readFile(new URL('index.html', rootUrl), 'utf8');
  const guidesSection = html.match(/<section class="guides"[\s\S]*?<\/section>/)?.[0];
  const sitemap = await readFile(new URL('sitemap.xml', rootUrl), 'utf8');

  assert.ok(guidesSection, 'the homepage guides section should exist');
  assert.doesNotMatch(guidesSection, EXPERIMENTAL);

  for (const guide of GUIDES) {
    const page = await readFile(new URL(guide.path, rootUrl), 'utf8');
    assert.doesNotMatch(page, EXPERIMENTAL, `${guide.path} should not mention experimental tools`);
  }

  assert.doesNotMatch(sitemap, /sensitivity|playtest|play-test/i);
});

test('guide asset and navigation paths resolve to repository files', async () => {
  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');
    const base = dirname(resolve(rootPath, guide.path));
    const refs = [...matchAll(html, /(?:href|src)="([^"]+)"/g)]
      .filter((ref) => !/^(?:https?:|mailto:|data:|#)/.test(ref));

    assert.ok(refs.length >= 4, `${guide.path} should reference local assets and navigation`);
    for (const ref of refs) {
      const target = ref.split('#')[0];
      const info = await stat(resolve(base, target));
      assert.ok(info.isFile() || info.isDirectory(), `${ref} in ${guide.path} should resolve`);
    }
  }
});

test('every guide links to every other guide and back to the tool', async () => {
  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');

    for (const other of GUIDES.filter((g) => g !== guide)) {
      assert.match(html, new RegExp(`href="\\.\\./${guideDir(other)}/"`), `${guide.path} should link to ${guideDir(other)}`);
    }
    assert.match(html, /href="\.\.\/\.\.\/"/, `${guide.path} should link back to the tool`);
    assert.match(html, /href="\.\.\/\.\.\/css\/style\.css"/, `${guide.path} should use the shared stylesheet`);
  }
});

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// FAQ in JSON-LD solo se identica al testo visibile: niente risposte nascoste ai lettori.
function assertFaqMatchesPage(html, label) {
  const data = JSON.parse(jsonLdBlocks(html)[0]);
  const nodes = data['@graph'] ?? [data];
  const faq = nodes.find((node) => node['@type'] === 'FAQPage');
  assert.ok(faq, `${label} should carry FAQPage data`);
  assert.ok(faq.mainEntity.length >= 3, `${label} FAQ should have several questions`);
  const visible = stripTags(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  for (const item of faq.mainEntity) {
    assert.ok(visible.includes(item.name), `${label}: question not visible: ${item.name}`);
    assert.ok(visible.includes(item.acceptedAnswer.text), `${label}: answer not visible: ${item.name}`);
  }
}

test('FAQ structured data matches the visible questions and answers', async () => {
  assertFaqMatchesPage(await readFile(new URL('index.html', rootUrl), 'utf8'), 'index.html');
  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');
    const hasFaq = /"@type": "FAQPage"/.test(html);
    assert.equal(hasFaq, guide.faq, `${guide.path} FAQPage presence`);
    if (guide.faq) assertFaqMatchesPage(html, guide.path);
  }
});

test('public pages do not promise that a power-off reverts an unsaved calibration', async () => {
  const home = await readFile(new URL('index.html', rootUrl), 'utf8');
  const faq = home.match(/<section class="faq"[\s\S]*?<\/section>/)?.[0];
  assert.ok(faq);
  assert.doesNotMatch(faq, POWER_OFF_PROMISE);
  assert.doesNotMatch(jsonLdBlocks(home)[0], POWER_OFF_PROMISE);
  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');
    assert.doesNotMatch(html, POWER_OFF_PROMISE, guide.path);
  }
});

test('the comparison credits dualshock-tools and dates its third-party facts', async () => {
  const html = await readFile(new URL(GUIDES[3].path, rootUrl), 'utf8');
  assert.match(html, /href="https:\/\/github\.com\/dualshock-tools\/dualshock-tools\.github\.io"/);
  assert.match(html, /href="https:\/\/dualshock-tools\.github\.io\/"/);
  assert.match(html, /THIRD_PARTY_NOTICES\.md/);
  assert.match(html, /checked on 12 October 2026/);
  assert.match(html, /not affiliated with dualshock-tools/);
});

// Revisione 12/10: la FAQ del test drift elencava solo Mild e Marked drift.
// Le etichette vengono dai badge di GRID_TABLE (quelli che il test drift
// mostra), sia nella FAQ visibile sia nel JSON-LD.
test('the drift test FAQ names every drift badge the tool shows, with its band', async () => {
  const { GRID_TABLE } = await import('../js/calib/lattice.js');
  const html = await readFile(new URL('guides/ps5-controller-stick-drift-test/index.html', rootUrl), 'utf8');
  const answer = 'Larger offsets are labeled Mild drift (below 3.5%), Marked drift (below 15%) or Severe drift (15% or more)';
  assert.equal(html.split(answer).length - 1, 2, 'visible FAQ and JSON-LD carry the same answer');
  const badges = GRID_TABLE.map(row => row.badge).filter(b => /drift/i.test(b));
  assert.deepEqual(badges, ['Mild drift', 'Marked drift', 'Severe drift']);
  const bands = Object.fromEntries(GRID_TABLE.map(row => [row.badge, row.max]));
  assert.equal(bands['Mild drift'], 3.5);
  assert.equal(bands['Marked drift'], 15);
});

// Revisione 12/10: l'avviso di dualshock-tools era parafrasato più morbido
// dell'originale, e "far more GitHub stars and forks" non aveva numeri né data.
test('the dualshock-tools comparison quotes its drift warning and dates its GitHub numbers', async () => {
  const html = await readFile(new URL('guides/sense-calibrator-vs-dualshock-tools/index.html', rootUrl), 'utf8');
  assert.ok(html.includes('“This utility cannot fix stick drift.”'));
  assert.ok(html.includes('“but it may also make the problem worse, with no way to undo it.”'));
  assert.doesNotMatch(html, /drift caused by worn parts/);
  assert.doesNotMatch(html, /far more GitHub stars/);
  assert.match(html, /on 12 October 2026 its GitHub repository had \d+ stars and \d+ forks, against \d+ and \d+ for Sense Calibrator/);
});

// Audit SEO 15/10: l'unica query non-brand reale cerca dualshock-tools.github.io.
test('the homepage links to the dualshock-tools comparison with descriptive text', async () => {
  const html = await readFile(new URL('index.html', rootUrl), 'utf8');
  assert.match(html, /<a [^>]*href="guides\/sense-calibrator-vs-dualshock-tools\/"[^>]*>Coming from dualshock-tools\? See how they compare<\/a>/);
});

test('the drift fix guide has a symptom table, a deadzone section and a repair section', async () => {
  const html = await readFile(new URL('guides/ps5-stick-drift-fix/index.html', rootUrl), 'utf8');
  for (const id of ['symptoms', 'deadzone', 'repair', 'faq']) {
    assert.match(html, new RegExp(`<h2 id="${id}">`), `section #${id}`);
  }
  assert.match(html, /<table>[\s\S]*Pinned[\s\S]*<\/table>/);
});

// GitHub Pages serve 404.html a ogni profondità: link assoluti, mai indicizzata.
test('the 404 page is noindex, styled, links home and to every guide, and stays out of the sitemap', async () => {
  const html = await readFile(new URL('404.html', rootUrl), 'utf8');
  const sitemap = await readFile(new URL('sitemap.xml', rootUrl), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<link rel="stylesheet" href="\/sense-calibrator\/css\/style\.css">/);
  assert.match(html, /<a class="btn btn-primary" href="\/sense-calibrator\/">Run the drift test<\/a>/);
  for (const guide of GUIDES) {
    assert.match(html, new RegExp(`href="/sense-calibrator/guides/${guideDir(guide)}/"`), guideDir(guide));
  }
  const refs = matchAll(html, /(?:href|src)="([^"]+)"/g).filter((ref) => !/^(?:https?:|mailto:|data:|#)/.test(ref));
  for (const ref of refs) {
    assert.ok(ref.startsWith('/sense-calibrator/'), `${ref} must be absolute`);
    const info = await stat(resolve(rootPath, ref.replace('/sense-calibrator/', '')));
    assert.ok(info.isFile() || info.isDirectory(), `${ref} should resolve`);
  }
  assert.doesNotMatch(sitemap, /404/);
});

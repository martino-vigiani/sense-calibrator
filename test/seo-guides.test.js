import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const rootUrl = new URL('..', import.meta.url);
const rootPath = fileURLToPath(rootUrl);

const HOMEPAGE_TITLE = 'Fix PS5 Stick Drift from Your Browser | Sense Calibrator';

const GUIDES = [
  {
    path: 'guides/ps5-controller-stick-drift-test/index.html',
    url: 'https://martino-vigiani.github.io/sense-calibrator/guides/ps5-controller-stick-drift-test/',
    title: 'PS5 Controller Stick Drift Test | Sense Calibrator',
    description:
      'Run a free PS5 controller stick drift test on a standard DualSense over USB in Chrome or Edge. Read the resting offset and signal noise from your browser.',
    h1: 'PS5 controller stick drift test',
    other: 'calibrate-dualsense-controller',
  },
  {
    path: 'guides/calibrate-dualsense-controller/index.html',
    url: 'https://martino-vigiani.github.io/sense-calibrator/guides/calibrate-dualsense-controller/',
    title: 'How to Calibrate a DualSense Controller | Sense Calibrator',
    description:
      'Learn when DualSense calibration can correct stick drift, how Quick and Guided calibration differ, and how to keep a calibration saved in controller memory.',
    h1: 'How to calibrate a DualSense controller',
    other: 'ps5-controller-stick-drift-test',
  },
];

const EXPERIMENTAL = /sensitivity|gameplay|playtest|play\s+test|polling\s+rate|input\s+latency|hall\s*effect/i;

function matchAll(html, pattern) {
  return [...html.matchAll(pattern)].map((match) => match[1]);
}

function jsonLdBlocks(html) {
  return matchAll(html, /<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/g);
}

test('both guide pages exist as static files', async () => {
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
    const h1s = matchAll(html, /<h1>([^<]+)<\/h1>/g);
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

test('both canonical guide URLs are published in the sitemap with a lastmod', async () => {
  const sitemap = await readFile(new URL('sitemap.xml', rootUrl), 'utf8');

  for (const guide of GUIDES) {
    const entry = new RegExp(`<loc>${guide.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>\\s*<lastmod>(\\d{4}-\\d{2}-\\d{2})</lastmod>`);
    assert.match(sitemap, entry, `${guide.url} should be in sitemap.xml with a lastmod date`);
  }
});

test('the homepage title and core positioning stay unchanged', async () => {
  const html = await readFile(new URL('index.html', rootUrl), 'utf8');

  assert.equal(matchAll(html, /<title>([^<]+)<\/title>/g)[0], HOMEPAGE_TITLE);
  assert.equal(
    matchAll(html, /<link rel="canonical" href="([^"]+)">/g)[0],
    'https://martino-vigiani.github.io/sense-calibrator/',
  );
  assert.match(html, /<h1>Fix PS5 stick drift\.<br>From your browser\.<\/h1>/);
  assert.match(html, /<meta name="description" content="Test and recalibrate a standard PS5 DualSense for stick drift from desktop Chrome or Edge over USB\. Free, open source and no install\.">/);
});

test('the homepage visibly links to both guides inside the landing view', async () => {
  const html = await readFile(new URL('index.html', rootUrl), 'utf8');
  const hero = html.match(/<section id="view-hero"[\s\S]*?<\/section>\s*<\/section>/)?.[0];

  assert.ok(hero, 'the homepage landing view should exist');
  for (const guide of GUIDES) {
    const dir = dirname(guide.path);
    assert.match(hero, new RegExp(`href="${dir}/"`), `homepage should link to ${dir}/`);
  }
  assert.match(hero, />PS5 controller stick drift test</);
  assert.match(hero, />Calibrate a DualSense controller</);
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

test('the two guides cross-link to each other and back to the tool', async () => {
  for (const guide of GUIDES) {
    const html = await readFile(new URL(guide.path, rootUrl), 'utf8');

    assert.match(html, new RegExp(`href="\.\./${guide.other}/"`), `${guide.path} should link to the other guide`);
    assert.match(html, /href="\.\.\/\.\.\/"/, `${guide.path} should link back to the tool`);
    assert.match(html, /href="\.\.\/\.\.\/css\/style\.css"/, `${guide.path} should use the shared stylesheet`);
  }
});

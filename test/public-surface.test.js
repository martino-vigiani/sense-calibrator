import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexPath = new URL('../index.html', import.meta.url);
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

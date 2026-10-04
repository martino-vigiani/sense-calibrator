import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

// Il probe R1 (ops/hw-probe) scrive la calibrazione in modo grezzo con
// 0x80 [12,1]. Non deve mai entrare nel codice pubblicato (piano C0-13): questi
// test tengono js/ senza il payload e la pagina di ricerca fuori dal sito.

const root = new URL('../', import.meta.url);

async function filesUnder(dir, keep) {
  const out = [];
  for (const entry of await readdir(new URL(dir, root), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = `${entry.parentPath ?? entry.path}/${entry.name}`;
    if (keep(path)) out.push(path);
  }
  return out;
}

// [12,1] in ogni forma plausibile: decimale, esadecimale, con o senza spazi.
const WRITE_PAYLOAD = [
  /\[\s*12\s*,\s*1\s*[,\]]/,
  /\[\s*0x0?c\s*,\s*(0x0?)?1\s*[,\]]/i,
  /0x0?c\s*,\s*0x0?1\b/i,
];
const PROBE_NAMES = /hw-probe|writeModuleCal|writeFinetuneData|encodeModuleWrite/;

test('the write-payload patterns are not vacuous: they match the probe itself', async () => {
  const src = await readFile(new URL('ops/hw-probe/module-cal.mjs', root), 'utf8');
  assert.ok(WRITE_PAYLOAD.some(re => re.test(src)));
  for (const sample of ['[12, 1, lo, hi]', '[12,1]', '[0x0c, 0x01, 0]', '[0xC,1]', 'send(0x80, 0x0c, 0x01)'])
    assert.ok(WRITE_PAYLOAD.some(re => re.test(sample)), sample);
  // La lettura [12,2] e numeri vicini non sono il payload di scrittura.
  for (const sample of ['[12, 10]', '[112, 1]', '[2,12,1]', '[12, 2]', '0x0ce6'])
    assert.equal(WRITE_PAYLOAD.some(re => re.test(sample)), false, sample);
});

test('shipped js/** carries no [12,1] payload and never reaches the probe', async () => {
  const files = await filesUnder('js', p => /\.(m?js)$/.test(p));
  assert.ok(files.length >= 5, `${files.length} files under js/`);
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    for (const re of WRITE_PAYLOAD) assert.doesNotMatch(src, re, `${file} contains a [12,1] payload`);
    assert.doesNotMatch(src, PROBE_NAMES, `${file} references the research probe`);
    assert.doesNotMatch(src, /from\s+['"][^'"]*ops\//, `${file} imports from ops/`);
  }
});

test('no public page, guide or sitemap links to the probe', async () => {
  const pages = [
    new URL('index.html', root).pathname,
    new URL('sitemap.xml', root).pathname,
    ...await filesUnder('guides', p => /\.(html|xml)$/.test(p)),
    ...await filesUnder('css', p => p.endsWith('.css')),
  ];
  for (const file of pages) {
    const src = await readFile(file, 'utf8');
    assert.doesNotMatch(src, /hw-probe|\/ops\//, `${file} links to ops/`);
  }
});

test('the probe is excluded from the Pages build, requests no indexing and cannot talk to the network', async () => {
  // Audit SEO 2026-10-04: robots nel sottopercorso non esclude file dalla build.
  // Questa guardia verifica il sorgente; l'artefatto Pages richiede un controllo dopo la build.
  const pagesConfig = await readFile(new URL('_config.yml', root), 'utf8');
  const exclusions = pagesConfig.match(/^exclude:[ \t]*\r?\n((?:[ \t]+[^\n]*(?:\n|$))*)/m)?.[1] ?? '';
  assert.match(exclusions, /^[ \t]+-[ \t]+ops\/?[ \t]*(?:#.*)?$/m, 'Pages exclude must contain ops/');
  const robots = await readFile(new URL('robots.txt', root), 'utf8');
  assert.match(robots, /^Disallow: \/sense-calibrator\/ops\/$/m, 'fallback robots path must include the project prefix');
  const html = await readFile(new URL('ops/hw-probe/index.html', root), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex, nofollow[^"]*">/);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(csp, 'CSP meta');
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
});

test('the probe checks the host before loading any HID code', async () => {
  const src = await readFile(new URL('ops/hw-probe/probe.mjs', root), 'utf8');
  const staticImports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
  assert.deepEqual(staticImports, ['./safety.mjs']);
  const guard = src.indexOf('isLocalProbeHost(location.hostname)');
  const firstDynamic = src.indexOf('import(');
  assert.ok(guard > 0 && firstDynamic > guard, 'host check comes before every dynamic import');
});

test('the probe never unlocks NVS or flashes', async () => {
  const files = await filesUnder('ops/hw-probe', p => /\.(m?js|html)$/.test(p));
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    assert.doesNotMatch(src, /nvsUnlock|\.flash\(|\[\s*3\s*,\s*2\s*[,\]]/, file);
  }
});

// Registratore diagnostico nella pagina vera (js/app.js nell'harness DOM-stub,
// DualSense virtuale, registratore e validatore reali; fetch, Blob e URL sono
// sostituiti dal test): cosa registra durante una Quick, i rilasci e uno
// scollegamento, che il report rispetti il contratto senza orari né seriale,
// l'invio solo dopo la conferma, e il pannello accessibile.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';
import { validateDiagnostics, DIAGNOSTICS_ENDPOINT } from '../js/diag/recorder.js';

const DRIFTING = [[3.2, -0.3], [-0.1, 0.4]];

async function setup({ drift = DRIFTING, seed = 11, ...load } = {}) {
  const clock = new VClock();
  const A = makeDevice(clock, { seed, drift });
  const h = await loadApp({ clock, authorized: [A], ...load });
  await h.advance(5000);
  return { h, A, clock };
}
// JSON di andata e ritorno: gli oggetti del contesto vm hanno un altro realm.
const report = h => JSON.parse(JSON.stringify(h.window.__senseDiagnostics()));
async function quick(h) {
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  await h.advance(400);
}
// Un flick dello stick `stick` (0 sinistro, 1 destro) e il ritorno a molla.
async function flick(h, A, clock, { stick = 0, amp = [110, 0] } = {}) {
  A.touches.push({ stick, t0: clock.now() + 50, dur: 200, tail: 40, amp });
  await h.advance(1500);
}
async function openAndStart(h) {
  await h.click('btn-diag-open');
  await h.click('btn-diag-start');
  // Il primo rilascio si riconosce solo dopo un primo punto fermo (300 ms).
  await h.advance(500);
}
// Conta le scritture di testo su un elemento (per le regioni live).
function countWrites(el) {
  const writes = [];
  let value = el.textContent;
  Object.defineProperty(el, 'textContent', {
    get: () => value,
    set: v => { writes.push(v); value = v; },
    configurable: true,
  });
  return writes;
}

test('the footer link opens the panel without starting anything; Close keeps a recording going', async () => {
  const { h } = await setup();
  assert.equal(h.visible('diag-panel'), false);
  assert.equal(h.$('btn-diag-open').getAttribute('aria-expanded'), 'false');
  await h.click('btn-diag-open');
  assert.equal(h.visible('diag-panel'), true);
  assert.equal(h.$('btn-diag-open').getAttribute('aria-expanded'), 'true');
  assert.equal(h.doc.activeElement, h.$('diag-panel'), 'the panel takes the focus');
  assert.equal(h.$('diag-status').textContent, 'Not recording.');
  assert.equal(h.$('btn-diag-download').disabled, true);
  assert.equal(h.$('btn-diag-send').disabled, true);
  assert.equal(h.window.__senseDiagnostics(), null);
  await h.click('btn-diag-start');
  await h.click('btn-diag-close');
  assert.equal(h.visible('diag-panel'), false);
  assert.equal(h.doc.activeElement, h.$('btn-diag-open'), 'focus returns to the footer link');
  await h.advance(3000);
  assert.equal(report(h).stop, 'recording');
  assert.ok(report(h).trace.length >= 2, 'still recording with the panel closed');
});

test('a Quick, releases and an unplug: everything lands in one valid report, with relative times only', async () => {
  const { h, A, clock } = await setup();
  // Un seriale noto, per controllare che non esca mai.
  h.eval("deviceInfo.serial = 'E1SERIAL4242'; deviceInfo.color = 'Cosmic Red';");
  await openAndStart(h);
  assert.equal(h.$('diag-status').textContent, 'Recording. It stops by itself after 30 minutes.');
  assert.equal(h.visible('btn-diag-stop'), true);
  assert.equal(h.visible('btn-diag-start'), false);

  await quick(h);
  await flick(h, A, clock, { stick: 0 });
  await flick(h, A, clock, { stick: 1, amp: [0, -110] });
  // Lo stick sinistro ora si ferma altrove (usura): il rilascio lo dice.
  A.sticks[0].rest = [6, 2];
  await flick(h, A, clock, { stick: 0 });
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.advance(2000);
  await h.click('btn-diag-stop');

  const r = report(h);
  assert.equal(validateDiagnostics(r), null);
  assert.equal(r.stop, 'user');
  const types = r.events.map(e => e.type);
  assert.deepEqual(types.slice(0, 2), ['connect', 'nv'], 'starting state of the connected controller');
  assert.deepEqual(r.events[0], { t: 0, type: 'connect', board: r.events[0].board, fw: r.events[0].fw });
  const quickStart = r.events.findIndex(e => e.type === 'start' && e.op === 'quick');
  const quickEnd = r.events.findIndex(e => e.type === 'calib' && e.event.type === 'quick');
  assert.ok(quickStart > 0 && quickEnd > quickStart, 'quick start, then its result');
  const q = r.events[quickEnd].event;
  assert.equal(q.sid, '00000000', 'its own sid, never the telemetry visit');
  assert.ok(q.beforeAxes && q.afterAxes, 'before/after per axis');
  assert.ok(types.includes('unsaved'), 'the calibration became unsaved');
  assert.ok(types.includes('drift'), 'drift test results');
  assert.equal(types.at(-1), 'disconnect');
  // Rilasci: tre; il riposo sinistro passa da (3.2, -0.3) a (6, 2) LSB fisici,
  // quindi l'ultimo arrivo si sposta di ~(+2.8, +2.3) LSB.
  assert.equal(r.landings.length, 3, JSON.stringify(r.landings));
  assert.deepEqual(r.landings.map(l => l.stick), ['left', 'right', 'left']);
  assert.ok(r.landings.every(l => l.peak > 50));
  const dx = r.landings[2].landAxes[0] - r.landings[0].landAxes[0];
  const dy = r.landings[2].landAxes[1] - r.landings[0].landAxes[1];
  assert.ok(dx > 2 && dx < 3.6 && dy > 1.5 && dy < 3.1, `left landing moved by (${dx}, ${dy}) LSB`);
  assert.equal(r.summary.left.count, 2);
  assert.equal(r.summary.right.count, 1);
  // Traccia a 1 Hz: una riga per secondo, tempi in ms dall'inizio.
  assert.ok(r.trace.length >= 8);
  for (let i = 1; i < r.trace.length; i++) assert.ok(r.trace[i].t - r.trace[i - 1].t >= 1000);
  assert.ok(r.trace.every(row => row.n > 100 && row.n < 400), 'about 250 reports per second, never the raw reports');
  // Nessun orario, nessun seriale, nessun colore.
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /\d{4}-\d{2}-\d{2}/, 'no date');
  assert.doesNotMatch(json, /T\d{2}:\d{2}/, 'no time of day');
  assert.ok(!json.includes('E1SERIAL4242') && !json.includes('4242"'), 'no serial');
  assert.ok(!json.includes('Cosmic'), 'no color');
  assert.ok(r.durMs < 60_000 && r.events.every(e => e.t <= r.durMs + 1));
  // Il pannello mostra i rilasci e il grafico.
  assert.match(h.$('diag-landings').innerHTML, /<tr>/);
  assert.match(h.$('diag-chart').innerHTML, /^<svg /);
  assert.match(h.$('diag-chart').getAttribute('aria-label'), /3 releases marked/);
  assert.match(h.$('diag-summary').textContent, /^Left: 2 releases/);
  assert.match(h.$('diag-status').textContent, /^Stopped after 1 minute\. Download it or send it/);
  assert.equal(h.doc.activeElement, h.$('btn-diag-download'), 'Stop hands the focus to the next step');
});

test('recording works with sharing off, sends nothing by itself and never touches the consent', async () => {
  const { h, A, clock } = await setup({ storage: { 'sense-telemetry-consent': '0' } });
  const calls = [];
  h.window.fetch = async (...args) => { calls.push(args); return { ok: true, status: 201, json: async () => ({ code: 'SC-AAAAAAAA' }) }; };
  await openAndStart(h);
  await quick(h);
  await flick(h, A, clock);
  const r = report(h);
  assert.ok(r.events.some(e => e.type === 'calib' && e.event.type === 'quick'), 'the Quick result is recorded');
  assert.equal(h.uploadsV2.length, 0);
  assert.equal(calls.length, 0, 'nothing leaves without Send');
  assert.equal(h.store.get('sense-telemetry-consent'), '0');
  assert.equal(h.window.__senseTelemetryV2().length, 0, 'no telemetry event is built');
});

// Il `save` del report rimanda agli eventi del report: ref è il seq di un
// evento `calib` che sta nel report, sessions quanti ce ne sono nel periodo.
const calibOf = (r, type) => r.events.filter(e => e.type === 'calib' && e.event.type === type).map(e => e.event);

test('the save event in the report counts and points to calibrations in the report, with sharing off', async () => {
  const { h, A } = await setup({ storage: { 'sense-telemetry-consent': '0' } });
  await openAndStart(h);
  await quick(h);
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.advance(2000);
  const r = report(h);
  assert.equal(validateDiagnostics(r), null);
  const [q] = calibOf(r, 'quick');
  const [save] = calibOf(r, 'save');
  assert.ok(q && q.committed, 'a committed Quick');
  assert.equal(save.result, 'disconnected');
  assert.equal(save.ref, q.seq);
  assert.equal(save.sessions, 1);
});

test('with sharing on, the report keeps its own numbering, and its calibration values are the telemetry ones', async () => {
  const { h, A } = await setup();
  await quick(h); // prima della registrazione: telemetria seq 0
  await openAndStart(h);
  A.sticks[0].rest = [6, 2];
  await quick(h);
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.advance(2000);
  const r = report(h);
  assert.equal(validateDiagnostics(r), null);
  const quicks = calibOf(r, 'quick');
  const [save] = calibOf(r, 'save');
  assert.equal(quicks.length, 1);
  assert.equal(save.ref, quicks[0].seq, 'ref is a seq in the report');
  assert.equal(save.sessions, 1, 'only the calibration recorded in the report');
  const sent = h.uploadsV2;
  const telQuick = sent.filter(e => e.type === 'quick').at(-1);
  const telSave = sent.find(e => e.type === 'save');
  assert.equal(telSave.ref, telQuick.seq);
  assert.equal(telSave.sessions, 2);
  assert.notEqual(telQuick.seq, quicks[0].seq, 'the two numberings differ here');
  // Stessi valori della telemetria, solo sid e seq cambiano: un report si può
  // abbinare alla telemetria della stessa visita (docs/PRIVACY.md, modale).
  const strip = ({ sid, seq, ...rest }) => rest;
  assert.notEqual(quicks[0].sid, telQuick.sid);
  assert.deepEqual(strip(quicks[0]), strip(JSON.parse(JSON.stringify(telQuick))));
});

test('the copy says what leaves and when: the panel intro and the send dialog', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const intro = html.match(/<p class="diag-intro">([^<]*)<\/p>/)?.[1] ?? '';
  assert.match(intro, /Nothing is sent unless you press Send\.$/);
  const dialog = html.slice(html.indexOf('id="modal-diag-send"'), html.indexOf('id="btn-diag-send-go"'));
  assert.match(dialog, /the report can be matched to this visit&rsquo;s telemetry/);
  const privacy = fs.readFileSync(new URL('../docs/PRIVACY.md', import.meta.url), 'utf8');
  assert.doesNotMatch(privacy, /can't be linked/);
  assert.match(privacy, /a report can be matched to that visit's telemetry events/);
});

test('Send shows what will go, opens on Cancel, and posts only after the explicit confirmation', async () => {
  const { h, A, clock } = await setup();
  const calls = [];
  h.window.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 201, json: async () => ({ code: 'SC-ABCDEFG2' }) };
  };
  await openAndStart(h);
  await flick(h, A, clock);
  await h.advance(60_000);
  await h.click('btn-diag-stop');
  const consent = h.store.get('sense-telemetry-consent');

  await h.click('btn-diag-send');
  await h.advance(50);
  assert.equal(h.visible('modal-diag-send'), true);
  // Il fuoco iniziale su Cancel (data-autofocus) lo verificano
  // test/public-surface.test.js e ops/ui-check/a11y-check.mjs: serve il layout.
  assert.match(h.$('diag-send-what').textContent, /^About \d+ KB: 1 minute of recording, \d+ events?, 1 release and \d+ one-second resting positions\.$/);
  // Cancel e Esc non mandano nulla.
  await h.click('btn-diag-send-cancel');
  await h.advance(300);
  assert.equal(h.visible('modal-diag-send'), false);
  await h.click('btn-diag-send');
  await h.advance(50);
  h.keydown('Escape');
  await h.advance(300);
  assert.equal(h.visible('modal-diag-send'), false);
  assert.equal(calls.length, 0);

  await h.click('btn-diag-send');
  await h.advance(50);
  await h.run(h.click('btn-diag-send-go'));
  await h.advance(300);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DIAGNOSTICS_ENDPOINT);
  assert.equal(DIAGNOSTICS_ENDPOINT, 'https://subralabs.com/api/calib/v2/diagnostics');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(validateDiagnostics(body), null);
  assert.deepEqual(body, report(h), 'the confirmed report is the one sent');
  assert.equal(h.visible('modal-diag-send'), false);
  assert.equal(h.visible('diag-sent'), true);
  assert.match(h.$('diag-sent').innerHTML, /<code>SC-ABCDEFG2<\/code>/);
  assert.match(h.$('diag-sent').innerHTML, /issues\/new\?template=bug-report\.yml&amp;diagnostic-code=SC-ABCDEFG2/);
  assert.match(h.$('diag-status').textContent, /Sent: code SC-ABCDEFG2\./);
  assert.equal(h.store.get('sense-telemetry-consent'), consent, 'the telemetry setting does not change');
});

test('a refused send says why, keeps the report and never retries by itself', async () => {
  const { h } = await setup();
  let status = 429;
  const calls = [];
  h.window.fetch = async () => { calls.push(status); return { ok: false, status, json: async () => ({}) }; };
  await openAndStart(h);
  await h.advance(3000);
  await h.click('btn-diag-send');
  await h.advance(50);
  await h.run(h.click('btn-diag-send-go'));
  await h.advance(50);
  assert.equal(h.visible('modal-diag-send'), true);
  assert.match(h.$('diag-send-msg').textContent, /Too many reports from this connection in the last hour/);
  assert.equal(h.$('btn-diag-send-go').textContent, 'Try again');
  assert.equal(h.$('btn-diag-send-go').disabled, false);
  status = 507;
  await h.run(h.click('btn-diag-send-go'));
  await h.advance(50);
  assert.match(h.$('diag-send-msg').textContent, /report store is full/);
  assert.equal(h.$('btn-diag-send-go').disabled, true, 'a full store is not retried');
  await h.advance(120_000);
  assert.deepEqual(calls, [429, 507]);
  // Senza fetch (rete assente): un messaggio, nessuna eccezione.
  delete h.window.fetch;
  await h.click('btn-diag-send-cancel');
  await h.advance(300);
  await h.click('btn-diag-send');
  await h.advance(50);
  await h.run(h.click('btn-diag-send-go'));
  assert.match(h.$('diag-send-msg').textContent, /Couldn’t reach the server/);
});

test('Download JSON saves the same valid report, with no date in the file name', async () => {
  const { h } = await setup();
  const saved = [];
  h.window.Blob = class { constructor(parts, opts) { saved.push({ text: parts.join(''), type: opts.type }); } };
  h.window.URL = { createObjectURL: () => 'blob:diag', revokeObjectURL: () => {} };
  const anchors = [];
  const create = h.doc.createElement;
  h.doc.createElement = tag => { const el = create(tag); if (tag === 'a') anchors.push(el); return el; };
  await openAndStart(h);
  await h.advance(4000);
  await h.click('btn-diag-download');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, 'application/json');
  const file = JSON.parse(saved[0].text);
  assert.equal(validateDiagnostics(file), null);
  assert.equal(file.stop, 'recording');
  assert.equal(anchors[0].download, 'sense-calibrator-diagnostics.json');
});

test('the recording stops by itself at 30 minutes, even with no controller sending reports', async () => {
  const { h, A } = await setup();
  await openAndStart(h);
  await h.advance(2000);
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.advance(30 * 60_000 + 2000);
  const r = report(h);
  assert.equal(r.stop, 'time-limit');
  assert.equal(r.durMs, 30 * 60_000);
  assert.equal(validateDiagnostics(r), null);
  assert.equal(h.$('diag-status').textContent, 'Stopped at the 30-minute limit. Download it or send it to the developer.');
  assert.equal(h.visible('btn-diag-stop'), false);
  // Riconnettere non riapre la registrazione.
  const B = makeDevice(h.clock, { seed: 3 });
  h.hid.authorized.push(B);
  h.hid.fire('connect', B);
  await h.advance(3000);
  assert.equal(report(h).events.filter(e => e.type === 'connect').length, 1);
});

test('the status live region does not chatter: counters go to plain text', async () => {
  const { h, A, clock } = await setup();
  await h.click('btn-diag-open');
  const writes = countWrites(h.$('diag-status'));
  await h.click('btn-diag-start');
  await h.advance(500);
  for (let i = 0; i < 4; i++) await flick(h, A, clock);
  await h.advance(10_000);
  assert.deepEqual(writes, ['Recording. It stops by itself after 30 minutes.']);
  assert.match(h.$('diag-elapsed').textContent, /^0:\d\d recorded · 4 releases · \d+ events$/);
});

test('a new recording asks before discarding one that was not sent', async () => {
  const { h } = await setup();
  await openAndStart(h);
  await h.advance(2000);
  await h.click('btn-diag-stop');
  h.confirmAnswer = false;
  await h.click('btn-diag-start');
  assert.equal(report(h).stop, 'user', 'kept');
  h.confirmAnswer = true;
  await h.click('btn-diag-start');
  assert.equal(report(h).stop, 'recording');
  assert.equal(h.$('btn-diag-start').textContent, 'Start a new recording');
});

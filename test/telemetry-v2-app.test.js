// Telemetria v2 nella pagina vera (js/app.js nell'harness DOM-stub, DualSense
// virtuale, builder e validatore reali; solo fetch è sostituito): quali eventi
// nascono in ogni flusso, e che niente parta senza consenso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';
import { validateEventV2 } from '../js/telemetry-v2.js';
import { buildCalibrationUpload } from '../js/telemetry.js';

const DRIFTING = [[3.2, -0.3], [-0.1, 0.4]];

async function setup({ drift = DRIFTING, seed = 11, ...load } = {}) {
  const clock = new VClock();
  const A = makeDevice(clock, { seed, drift });
  const h = await loadApp({ clock, authorized: [A], ...load });
  await h.advance(5000);
  return { h, A };
}
// JSON di andata e ritorno: gli oggetti del contesto vm hanno un altro realm.
const outbox = h => JSON.parse(JSON.stringify(h.window.__senseTelemetryV2()));
// Upload v1 davvero accettati dal contratto v1 (lo stub dell'harness riceve
// ogni evento locale, il vero js/telemetry.js li filtra).
const v1Sent = h => h.uploads.filter(entry => buildCalibrationUpload(entry)).length;
const halfLsbAxes = xy => xy?.map(stick => stick.map(v => Math.max(-128, Math.min(128, Math.round(v * 2.55))))) ?? null;
function change(h, id, checked) {
  const box = h.$(id);
  box.checked = checked;
  box.dispatch('change');
}
const ofType = (h, type) => outbox(h).filter(item => item.event.type === type);
async function quick(h) {
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  await h.advance(400);
}
function pagehide(h) {
  for (const fn of h.windowListeners.get('pagehide') ?? []) fn({ type: 'pagehide', persisted: false });
}

// ------------------------------------------------------------------ consenso

test('first visit: nothing leaves the browser until Keep sharing, then v1 and v2 both go', async () => {
  const { h } = await setup({ telemetryNoticeSeen: false });
  assert.equal(h.visible('telemetry-notice'), true);
  assert.equal(h.visible('notice-changed'), false, 'a first visit has nothing that changed');
  await quick(h);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.uploadsV2.length, 0);
  const queued = ofType(h, 'quick');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].state, 'queued');
  await h.click('btn-notice-ok');
  await h.advance(50);
  assert.equal(v1Sent(h), 1, 'the complete Quick session on v1, unchanged');
  assert.deepEqual(h.uploadsV2.map(e => e.type), ['quick']);
  assert.equal(h.store.get('sense-telemetry-scope'), '4');
  assert.equal(h.store.get('sense-telemetry-consent'), '1');
  // da qui gli eventi partono subito
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));
  await h.advance(50);
  assert.deepEqual(h.uploadsV2.map(e => e.type), ['quick', 'flash', 'save']);
});

test("first visit: Don't share discards the queue, and no event is even built afterwards", async () => {
  const { h } = await setup({ telemetryNoticeSeen: false });
  await quick(h);
  await h.click('btn-notice-optout');
  await h.advance(50);
  assert.equal(h.uploads.length + h.uploadsV2.length, 0);
  assert.ok(outbox(h).every(item => item.state === 'discarded'));
  assert.equal(h.store.get('sense-telemetry-consent'), '0');
  const before = outbox(h).length;
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));
  await h.advance(60_000);
  assert.equal(outbox(h).length, before, 'no flash, save or rest event built with sharing off');
  assert.equal(h.uploads.length + h.uploadsV2.length, 0);
  assert.ok(h.toasts().some(t => /Nothing was sent/.test(t)));
});

test('a v1 sharer sees the notice again, with what changed, and even v1 waits for the answer', async () => {
  const { h } = await setup({
    telemetryNoticeSeen: false,
    storage: { 'sense-telemetry-notice': '1', 'sense-telemetry-consent': '1' },
  });
  assert.equal(h.visible('telemetry-notice'), true);
  assert.equal(h.visible('notice-changed'), true);
  await quick(h);
  assert.equal(h.uploads.length, 0, 'v1 held while the updated notice is open');
  assert.equal(h.uploadsV2.length, 0);
  await h.click('btn-notice-ok');
  await h.advance(50);
  assert.equal(v1Sent(h), 1);
  assert.deepEqual(h.uploadsV2.map(e => e.type), ['quick']);
});

for (const previousScope of ['2', '3']) test(`a scope ${previousScope} sharer sees the diagnostic description before anything leaves`, async () => {
  const { h } = await setup({
    telemetryNoticeSeen: false,
    storage: { 'sense-telemetry-notice': '1', 'sense-telemetry-scope': previousScope, 'sense-telemetry-consent': '1' },
  });
  assert.equal(h.visible('telemetry-notice'), true);
  assert.equal(h.visible('notice-changed'), true);
  await quick(h);
  assert.equal(h.uploads.length + h.uploadsV2.length, 0);
  await h.click('btn-notice-ok');
  await h.advance(50);
  assert.equal(h.store.get('sense-telemetry-scope'), '4');
  assert.equal(v1Sent(h), 1);
  assert.deepEqual(h.uploadsV2.map(e => e.type), ['quick']);
});

test("a v1 sharer who answers Don't share stops v1 as well and is told so", async () => {
  const { h } = await setup({
    telemetryNoticeSeen: false,
    storage: { 'sense-telemetry-notice': '1', 'sense-telemetry-consent': '1' },
  });
  await quick(h);
  await h.click('btn-notice-optout');
  await h.advance(50);
  assert.equal(h.uploads.length + h.uploadsV2.length, 0);
  assert.ok(h.toasts().some(t => /Sharing is off\. Nothing from this visit was sent/.test(t)));
  await quick(h);
  assert.equal(h.uploads.length + h.uploadsV2.length, 0);
});

test('someone who opted out of v1 is not asked again and nothing is built or sent', async () => {
  const { h } = await setup({
    telemetryNoticeSeen: false,
    storage: { 'sense-telemetry-notice': '1', 'sense-telemetry-consent': '0' },
  });
  assert.equal(h.visible('telemetry-notice'), false);
  await quick(h);
  await h.advance(70_000);
  assert.equal(outbox(h).length, 0);
  assert.equal(h.uploads.length + h.uploadsV2.length, 0);
});

test('unticking the footer box while the notice is open is the same as Don\'t share', async () => {
  const { h } = await setup({ telemetryNoticeSeen: false });
  await quick(h);
  change(h, 'telemetry-consent-footer', false);
  await h.advance(300);
  assert.equal(h.visible('telemetry-notice'), false);
  assert.equal(h.store.get('sense-telemetry-consent'), '0');
  assert.equal(h.uploads.length + h.uploadsV2.length, 0);
});

test('the v2 sid is its own random code, never the local SESSION_ID written to the local history', async () => {
  const { h } = await setup();
  await quick(h);
  await h.advance(50);
  const sid = h.uploadsV2[0].sid;
  assert.match(sid, /^[0-9a-f]{8}$/);
  assert.ok(h.sessions().length > 0);
  assert.ok(h.sessions().every(entry => entry.sid !== sid), 'never stored');
  assert.ok(![...h.store.values()].some(value => String(value).includes(sid)), 'not in any localStorage value');
});

test("ticking the Quick dialog's box turns sharing back on but leaves v2 waiting for the notice", async () => {
  const { h } = await setup({
    telemetryNoticeSeen: false,
    storage: { 'sense-telemetry-notice': '1', 'sense-telemetry-consent': '0' },
  });
  change(h, 'telemetry-consent', true);
  assert.equal(h.store.get('sense-telemetry-consent'), '1');
  assert.equal(h.store.has('sense-telemetry-scope'), false);
  await quick(h);
  await h.advance(50);
  assert.equal(v1Sent(h), 1, 'v1 as before');
  assert.equal(h.uploadsV2.length, 0);
  assert.ok(outbox(h).every(item => item.state === 'queued'));
});

test('ticking the footer box later accepts the current description and sends from then on', async () => {
  const { h } = await setup({
    telemetryNoticeSeen: false,
    storage: { 'sense-telemetry-notice': '1', 'sense-telemetry-consent': '0' },
  });
  change(h, 'telemetry-consent-footer', true);
  assert.equal(h.store.get('sense-telemetry-scope'), '4');
  await quick(h);
  await h.advance(50);
  assert.deepEqual(h.uploadsV2.map(e => e.type), ['quick']);
  assert.equal(v1Sent(h), 1);
});

// ------------------------------------------------------------------ flussi

test('Quick → Write: quick, flash and save events linked by seq, all valid', async () => {
  const { h } = await setup();
  await quick(h);
  await h.click('btn-flash');
  await h.run(h.click('btn-flash-go'));
  await h.advance(50);
  const events = h.uploadsV2;
  assert.deepEqual(events.map(e => e.type), ['quick', 'flash', 'save']);
  for (const e of events) assert.equal(validateEventV2(e), null);
  const [q, f, s] = events;
  assert.deepEqual(events.map(e => e.seq), [0, 1, 2]);
  assert.ok(events.every(e => e.sid === q.sid && /^[0-9a-f]{8}$/.test(e.sid)));
  assert.equal(q.committed, true);
  assert.equal(q.start, 'normal');
  assert.ok(['centered', 'within-1-step'].includes(q.outcome), q.outcome);
  assert.deepEqual([f.result, f.nv, f.attempt, f.lock], ['ok', 'locked', 1, 'allowed']);
  assert.deepEqual([s.result, s.ref, s.sessions, s.opens, s.reminderOpens, s.cancels, s.attempts, s.lastFlash],
    ['saved', q.seq, 1, 1, 0, 0, 1, 'ok']);
  const text = JSON.stringify(events);
  assert.doesNotMatch(text, /serial|"t":|E8475|DualSense/i);
});

test('Quick uploads signed half-LSB axes for the baseline, each pass, and the final reading', async () => {
  const { h } = await setup();

  await quick(h);

  const event = h.uploadsV2.find(e => e.type === 'quick');
  assert.ok(event, 'the Quick event should pass in-page validation and upload');
  // Regressione telemetry v2: il raggio per passata non conserva asse e segno.
  const local = h.sessions().filter(e => e.kind === 'quick').at(-1);
  assert.deepEqual(
    { before: event.beforeAxes, passes: event.passAxes, after: event.afterAxes },
    { before: halfLsbAxes(local.before.xy), passes: local.passXY.map(halfLsbAxes), after: halfLsbAxes(local.after.xy) },
    'the uploaded axes retain stick order, axis order, sign, and pass order',
  );
  assert.ok(event.beforeAxes[0][0] > 0 && event.beforeAxes[0][1] < 0);
  assert.deepEqual(event.verification, local.verification, 'existing verification readings reach the actual upload');
  assert.ok(event.verification.attempts.length > 0);
  assert.ok(event.verification.attempts.some(a => a.accepted));
});

test('Quick → Write → Cancel → disconnect: the save event says disconnected after one cancel', async () => {
  const { h, A } = await setup();
  await quick(h);
  await h.click('btn-save-reminder');
  await h.advance(300);
  await h.click('btn-flash-cancel');
  await h.advance(300);
  A.unplug();
  h.hid.fire('disconnect', A);
  await h.advance(50);
  const save = h.uploadsV2.find(e => e.type === 'save');
  assert.deepEqual([save.result, save.opens, save.reminderOpens, save.cancels, save.attempts, save.lastFlash],
    ['disconnected', 0, 1, 1, 0, null]);
  assert.equal(save.ref, h.uploadsV2.find(e => e.type === 'quick').seq);
});

test('Quick then leaving the page: the save event says left, sent right away', async () => {
  const { h } = await setup();
  await quick(h);
  const before = h.uploadsV2.length;
  pagehide(h);
  await h.advance(0);
  const save = h.uploadsV2.slice(before).find(e => e.type === 'save');
  assert.equal(save.result, 'left');
  assert.equal(save.lock, 'allowed');
  pagehide(h);
  await h.advance(0);
  assert.equal(h.uploadsV2.filter(e => e.type === 'save').length, 1, 'one save event per unsaved period');
});

test('a Quick that never starts (thumb held) is a quick event with no save period', async () => {
  const { h, A } = await setup();
  A.touches.push({ stick: 0, t0: h.clock.now(), dur: 120_000, amp: [40, 0], tail: 40 });
  await quick(h);
  await h.advance(100);
  const q = h.uploadsV2.filter(e => e.type === 'quick');
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].outcome, q[0].committed, q[0].passes], ['preflight', false, []]);
  pagehide(h);
  await h.advance(0);
  assert.equal(h.uploadsV2.filter(e => e.type === 'save').length, 0);
});

// ------------------------------------------------------------------ rumore a riposo

test('an untouched controller on a visible page yields rest summaries, at most one per 30 s window', async () => {
  const { h } = await setup();
  await h.advance(65_000);
  const rest = h.uploadsV2.filter(e => e.type === 'rest');
  assert.equal(rest.length, 2, `${rest.length}`);
  for (const e of rest) {
    assert.equal(validateEventV2(e), null);
    assert.equal(e.state, 'none');
    assert.equal(e.durS, 30);
    assert.ok(e.reports > 6000);
  }
  assert.equal(rest[0].ctx, 'drift', 'the first window overlaps the automatic drift test');
});

test('no rest summary while the tab is hidden, a dialog is open or a calibration runs', async () => {
  const { h } = await setup();
  h.setHidden(true);
  await h.advance(40_000);
  h.setHidden(false);
  assert.equal(h.uploadsV2.filter(e => e.type === 'rest').length, 0, 'hidden tab');
  await h.click('btn-quick');
  await h.advance(40_000);
  assert.equal(h.uploadsV2.filter(e => e.type === 'rest').length, 0, 'Quick dialog open');
  await h.click('btn-quick-cancel');
  await h.advance(35_000);
  const rest = h.uploadsV2.filter(e => e.type === 'rest');
  assert.equal(rest.length, 1, 'collects again once nothing is open');
});

test('after a Quick the rest summaries say the calibration is not saved yet', async () => {
  const { h } = await setup();
  await quick(h);
  await h.advance(70_000);
  const rest = h.uploadsV2.filter(e => e.type === 'rest');
  assert.ok(rest.length >= 1);
  assert.ok(rest.every(e => e.state === 'unsaved'));
});

// ------------------------------------------------------------------ guided e range

const CORNERS = [{ tx: -0.7, ty: -0.7 }, { tx: 0.7, ty: -0.7 }, { tx: -0.7, ty: 0.7 }, { tx: 0.7, ty: 0.7 }];
async function moveToCorner(h, dev, corner, ms = 400) {
  const t0 = h.clock.now() + 20;
  for (const stick of [0, 1]) dev.touches.push({ stick, t0, dur: ms, tail: 40, amp: [corner.tx * 120, corner.ty * 120] });
  await h.advance(ms + 250);
}

async function finishGuided(h, controller) {
  await h.click('btn-wizard');
  await h.run(h.click('btn-wizard-next'));
  for (const c of CORNERS) {
    await moveToCorner(h, controller, c);
    await h.run(h.click('btn-wizard-next'));
  }
  await h.advance(50);
}

test('a guided run: one guided event (done, step 5) that the save period points at', async () => {
  const { h, A } = await setup({ drift: [[14, -9], [-2, 3]], seed: 21 });
  await finishGuided(h, A);
  const g = h.uploadsV2.filter(e => e.type === 'guided');
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].outcome, g[0].step, g[0].committed, g[0].escaped, g[0].timeouts], ['done', 5, true, false, 0]);
  assert.ok(g[0].before[0] > 10 && g[0].after[0] < 2, `${g[0].before} → ${g[0].after}`);
  pagehide(h);
  await h.advance(0);
  const save = h.uploadsV2.find(e => e.type === 'save');
  assert.deepEqual([save.result, save.ref, save.sessions], ['left', g[0].seq, 1]);
});

test('audit 13: revoking sharing discards v2 sends already queued in the promise chain', async () => {
  const h = await loadApp();
  h.eval(`for (let i = 0; i < 3; i++)
    emitV2(ctx => buildFlashEvent(ctx, { result: 'ok', nv: { status: 'locked' }, attempt: 1, lock: 'allowed' }));
    setConsent(false); flushV2(false);`);
  await h.advance(0);
  assert.equal(h.uploadsV2.length, 0);
  assert.deepEqual(Array.from(h.window.__senseTelemetryV2(), e => e.state), ['discarded', 'discarded', 'discarded']);
  h.eval('setConsent(true)');
  await h.advance(0);
  assert.equal(h.uploadsV2.length, 0, 'reconsent does not revive pre-revocation events');
});

test('Guided uploads signed half-LSB axes before and after calibration', async () => {
  const { h, A } = await setup({ drift: [[14, -9], [-2, 3]], seed: 21 });

  await finishGuided(h, A);

  const event = h.uploadsV2.find(e => e.type === 'guided');
  assert.ok(event, 'the Guided event should pass in-page validation and upload');
  // Regressione telemetry v2: gli offset radiali non distinguono un asse negativo.
  const local = h.sessions().filter(e => e.kind === 'wizard').at(-1);
  assert.deepEqual(
    { before: event.beforeAxes, after: event.afterAxes },
    { before: halfLsbAxes(local.before.xy), after: halfLsbAxes(local.after.xy) },
    'the uploaded axes retain stick order, axis order, and sign',
  );
  assert.ok(event.beforeAxes[0][0] > 0 && event.beforeAxes[0][1] < 0);
});

test('a guided Start with a thumb on a stick sends no command and no guided event', async () => {
  const { h, A } = await setup();
  A.touches.push({ stick: 1, t0: h.clock.now(), dur: 60_000, tail: 40, at: t => 25 * Math.sin(t / 40) });
  await h.click('btn-wizard');
  await h.run(h.click('btn-wizard-next'));
  assert.equal(A.counts.begin, 0);
  assert.equal(h.uploadsV2.filter(e => e.type === 'guided').length, 0);
});

test('Range finished anyway: an incomplete range event, and the save period ends locked with its reason', async () => {
  const { h, A } = await setup();
  await h.run(h.click('btn-range'));
  await h.run(h.click('btn-range-start'));
  const from = h.clock.now() + 10;
  // un giro solo, in un verso, su entrambi gli stick: niente inversione
  for (const stick of [0, 1]) {
    A.touches.push({ stick, t0: from, dur: 1000, tail: 1, at: (t, ax) => {
      const a = 2 * Math.PI * (t - from) / 1000;
      return 127.5 * (ax === 0 ? Math.cos(a) : Math.sin(a));
    } });
  }
  await h.advance(18_000);
  h.window.confirm = () => true;
  await h.run(h.click('btn-range-done'));
  await h.advance(300);
  const r = h.uploadsV2.filter(e => e.type === 'range');
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].outcome, r[0].committed, r[0].allEdges], ['incomplete', true, true], 'every edge reached, but only one way round');
  assert.ok(r[0].turns.every(t => t >= 0.5 && t < 2), `${r[0].turns}`);
  assert.deepEqual(r[0].completion.reversed, [false, false]);
  assert.deepEqual(r[0].completion.missing, [['turns', 'reverse'], ['turns', 'reverse']]);
  assert.ok(r[0].completion.reverseTurns.every(t => t < 0.5));
  pagehide(h);
  await h.advance(0);
  const save = h.uploadsV2.find(e => e.type === 'save');
  assert.deepEqual([save.result, save.lock, save.reasons, save.ref], ['left', 'disabled', ['range-incomplete'], r[0].seq]);
});

// Il banner corto: meno di 50 parole, ogni categoria e il nuovo dato per
// asse nominati (Keep sharing accetta lo scope 4), "Details" verso il README.
test('the consent banner is short, names every v2 category and links the full description', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const notice = html.slice(html.indexOf('id="telemetry-notice"'), html.indexOf('class="notice-actions"'));
  const body = notice.slice(notice.indexOf('<p>')).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, "'").replace(/\s+/g, ' ').trim();
  const words = body.split(' ').length;
  assert.ok(words <= 48, `${words} words: ${body}`);
  for (const category of [/calibration results/, /saving/, /resting stick noise/]) assert.match(body, category);
  assert.match(body, /signed axis positions/);
  assert.match(body, /Quick stability/);
  assert.match(body, /missing Range checks/);
  assert.match(body, /No serial number or device ID/);
  assert.match(body, /nothing from this visit has been sent yet/);
  assert.match(notice, /href="https:\/\/github\.com\/martino-vigiani\/sense-calibrator#telemetry--privacy"[^>]*>Details</);
  assert.match(notice, /id="notice-changed"[^>]*><b>What&rsquo;s shared has changed\.<\/b>/);
});

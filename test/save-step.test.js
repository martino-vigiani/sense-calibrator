// Il passo "Write to memory" dopo una calibrazione. Dal test con un DualSense
// vero: l'unico invito a salvare era un banner in fondo alla pagina e veniva
// mancato. Qui si fissano la posizione (subito sotto l'esito), il promemoria
// fisso, l'annuncio unico e il fatto che l'evidenza non renda mai cliccabile
// un Write bloccato. Il layout vero (scroll, impulso) è verificato in
// Chromium headless, non qui.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';
import {
  SAVE_CTA_TEXT, guidedOutcomeView, outcomeHtml, quickOutcomeView, rangeOutcomeView, saveCtaFor, unsavedLostView, writeLockFor,
} from '../js/ui/outcome.js';

const read = p => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const tagOf = (html, id) => html.match(new RegExp(`<[^>]*\\bid="${id}"[^>]*>`))?.[0] ?? '';

test('the save step sits right after the outcome panel, before the sticks and the actions', async () => {
  const html = await read('index.html');
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('calib-outcome') > 0 && at('banner-unsaved') > at('calib-outcome'));
  assert.ok(at('banner-unsaved') < html.indexOf('class="grid-sticks"'), 'above the dials');
  assert.ok(at('banner-unsaved') < html.indexOf('class="card actions-card"'), 'no longer below every action');
  // Nessun altro elemento tra l'esito e il passo di salvataggio.
  const between = html.slice(html.indexOf('</div>', at('calib-outcome')), html.lastIndexOf('<', at('banner-unsaved')));
  assert.doesNotMatch(between.replace(/<!--[\s\S]*?-->/g, ''), /<(div|section|p)\b/);
  const step = html.slice(at('banner-unsaved'), html.indexOf('</section>', at('banner-unsaved')));
  assert.match(step, /id="save-step-title"[^>]*>Save it to the controller</);
  assert.match(step, />Last step</);
  assert.match(step, /id="btn-flash"[^>]*>Write to memory</);
  assert.match(step, /id="banner-lock"/);
  // H10 non è verificato: il testo resta attenuato.
  assert.match(step, /should be lost when the controller turns off/);
  assert.match(tagOf(html, 'banner-unsaved'), /aria-labelledby="save-step-title"/);
  assert.match(tagOf(html, 'save-step-live'), /role="status"/);
  assert.match(tagOf(html, 'save-reminder'), /class="save-reminder hidden"/);
  assert.match(tagOf(html, 'btn-save-reminder'), /type="button"/);
});

test('the attention cue plays once and never under reduced motion; the reminder sits under modals', async () => {
  const css = await read('css/style.css');
  assert.match(css, /\.save-step-cue \{ animation: saveCue [^;]* 1; \}/);
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.save-step-cue \{ animation: none !important; \}/);
  const reminder = css.match(/\.save-reminder \{[^}]*\}/)?.[0] ?? '';
  assert.match(reminder, /position: fixed/);
  assert.match(reminder, /z-index: 40/, 'below the modals (50), above page content');
  assert.match(reminder, /var\(--notice-space/, 'stacks above the telemetry notice');
  // Write spento: niente fondo nero pieno, il bottone è un contorno.
  assert.match(css, /\.save-step\[data-lock="disabled"\] \{[^}]*background: var\(--surface\)/);
  assert.match(css, /\.save-step\[data-lock="disabled"\] \.btn-primary:disabled \{[^}]*background: transparent/);
});

const DRIFTING = [[3.2, -0.3], [-0.1, 0.4]];
async function setup(drift = DRIFTING) {
  const clock = new VClock();
  const A = makeDevice(clock, { seed: 11, drift });
  const h = await loadApp({ clock, authorized: [A] });
  await h.advance(5000);
  return { h, A };
}

test('after Quick the save step is shown, announced once and reminded until a successful write', async () => {
  const { h } = await setup();
  assert.equal(h.visible('save-reminder'), false);
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(2500);
  // A modale aperto nessun promemoria: starebbe sopra il backdrop.
  assert.equal(h.visible('save-reminder'), false);
  await h.run(running);
  await h.advance(400);
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.visible('banner-unsaved'), true);
  assert.equal(h.$('banner-unsaved').dataset.lock, 'allowed');
  assert.equal(h.$('save-step-title').textContent, 'Save it to the controller');
  assert.match(h.$('save-step-numbers').textContent, /^Left [\d.]+% → [\d.]+%   ·   Right [\d.]+% → [\d.]+%$/, 'short before → after next to the button');
  assert.match(h.$('save-step-live').textContent, /^Last step: write the calibration/);
  assert.equal(h.$('btn-flash').disabled, false);
  // Senza IntersectionObserver (DOM finto) il promemoria resta finché unsaved.
  assert.equal(h.visible('save-reminder'), true);
  assert.equal(h.$('btn-save-reminder').textContent, 'Write to memory');
  // Il modale di Write non si apre da solo.
  assert.equal(h.visible('modal-flash'), false);

  // Una seconda rivelazione (altro commit) non annuncia di nuovo.
  h.$('save-step-live').textContent = 'probe';
  h.ctx.setUnsaved(true);
  await h.advance(50);
  assert.equal(h.$('save-step-live').textContent, 'probe', 'announced once per unsaved calibration');

  // Il promemoria apre lo stesso modale di Write, con le stesse guardie.
  await h.click('btn-save-reminder');
  await h.advance(50);
  assert.equal(h.visible('modal-flash'), true);
  assert.equal(h.visible('save-reminder'), false, 'hidden while a modal is open');
  await h.run(h.click('btn-flash-go'));
  await h.advance(400);
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.visible('banner-unsaved'), false);
  assert.equal(h.visible('save-reminder'), false, 'gone after a successful write');
  assert.equal(h.$('save-step-live').textContent, '');
});

test('with Write locked the save step says why and the reminder never opens the Write modal', async () => {
  const { h } = await setup([[0.2, -0.3], [-0.1, 0.4]]);
  h.eval(`showOutcome(quickOutcomeView({ outcome: 'catastrophic', worst: 22, beforeWorst: 3, bestWorst: 3, committed: true, session: {} }, { nvStatus: 'locked' }))`);
  h.ctx.setUnsaved(true);
  await h.advance(50);
  assert.equal(h.$('btn-flash').disabled, true);
  assert.equal(h.$('banner-unsaved').dataset.lock, 'disabled');
  assert.equal(h.$('save-step-kicker').textContent, 'Not ready to save');
  assert.equal(h.$('save-step-title').textContent, 'Saving is off for this result');
  assert.match(h.$('banner-lock').textContent, /^Write is off: .*15% or more/);
  assert.match(h.$('save-step-live').textContent, /Write is off/);
  assert.equal(h.$('btn-save-reminder').textContent, 'See why');
  assert.match(h.$('save-reminder-text').textContent, /Write is off/);
  await h.click('btn-save-reminder');
  await h.advance(50);
  assert.equal(h.visible('modal-flash'), false, 'a locked Write never opens');
  assert.equal(h.doc.activeElement, h.$('banner-unsaved'), 'focus goes to the reason, not to a disabled button');
});

test('a commit made while a modal is open is revealed when the modal closes', async () => {
  const { h } = await setup();
  await h.click('btn-flash'); // un modale qualunque aperto
  await h.advance(50);
  h.ctx.setUnsaved(true);
  await h.advance(50);
  assert.equal(h.$('save-step-live').textContent, '', 'not announced behind a modal');
  await h.click('btn-flash-cancel');
  await h.advance(400);
  assert.match(h.$('save-step-live').textContent, /^Last step/);
});

test('leaving the page with an unsaved calibration asks first', async () => {
  const { h } = await setup();
  h.ctx.setUnsaved(true);
  const unload = { preventDefault() { this.prevented = true; } };
  for (const fn of h.windowListeners.get('beforeunload')) fn(unload);
  assert.equal(unload.prevented, true);
});

// ---------------------------------------------------------------------------
// Telemetria v2 27/9–12/10: 49 periodi non salvati con Write libero e il
// modale mai aperto (48 col passo visto, mediana 114 s), chiusi staccando il
// controller o la pagina, quasi tutti dopo un esito buono. Invito nel pannello
// solo per un esito buono e salvabile; avviso all'uscita solo se c'è qualcosa
// di salvabile; al ricollegamento il pannello dice che non era stato salvato.

const off = (l, r) => ({ off: [l, r], noise: [0.2, 0.2], xy: [[l, 0], [r, 0]] });
const quickView = (outcome, worst, beforeWorst = 3.2) =>
  quickOutcomeView({ outcome, worst, beforeWorst, bestWorst: Math.min(worst, beforeWorst), committed: true, session: { before: off(beforeWorst, 0.555), after: off(worst, 0.555) } });

test('the outcome panel offers Write only after a good result that is unsaved and allowed', () => {
  const good = [
    quickView('centered', 0.555),
    quickView('within-1-step', 1.24),
    guidedOutcomeView({ before: off(5.1, 0.555), after: off(0.555, 0.555) }),
    rangeOutcomeView({}),
  ];
  for (const view of good) {
    assert.equal(view.tone, 'ok', view.title);
    const lock = writeLockFor({ center: view.center ?? null, range: view.range ?? null }).mode;
    assert.equal(lock, 'allowed', view.title);
    assert.equal(saveCtaFor({ view, unsaved: true, lockMode: lock }), true, view.title);
    assert.equal(saveCtaFor({ view, unsaved: false, lockMode: lock }), false, 'nothing to save');
    assert.equal(saveCtaFor({ view, unsaved: true, lockMode: 'guarded' }), false, 'a result to check is never pushed');
    assert.equal(saveCtaFor({ view, unsaved: true, lockMode: 'disabled' }), false);
    const html = outcomeHtml(view);
    assert.match(html, /<div class="outcome-save"><p>Not saved yet\./);
    assert.match(html, /class="btn btn-primary btn-sm" data-outcome-action="write">Write to memory</);
    assert.ok(html.indexOf('outcome-save') < (html.indexOf('outcome-actions') + 1 || Infinity), 'before the secondary actions');
  }
  // Esiti da controllare, cattivi o non verificati: nessun invito, mai.
  const notGood = [
    quickView('worn', 2.77), quickView('residual-deterministic', 2.77), quickView('lost-ground', 3.0),
    quickView('worse-than-start', 4.5, 1.24), quickView('catastrophic', 22), quickView('unverified', null),
    quickView('residual', 2.0),
    guidedOutcomeView({ before: off(1.24, 0.555), after: off(5.1, 0.555) }),
    rangeOutcomeView({ incomplete: true }),
    unsavedLostView(),
  ];
  for (const view of notGood) {
    assert.notEqual(view.tone, 'ok', view.title);
    assert.equal(saveCtaFor({ view, unsaved: true, lockMode: 'allowed' }), false, view.title);
    assert.doesNotMatch(outcomeHtml(view), /data-outcome-action="write"|outcome-save/, view.title);
  }
});

test('save copy stays honest: power-off "should", unplugging only as unconfirmed (H10, H11)', async () => {
  // "unplug" compare solo nella frase che dice che non è confermato.
  const unplugSentences = text => text.split(/(?<=[.:;])\s+/).filter(s => /unplug/i.test(s));
  for (const s of unplugSentences(SAVE_CTA_TEXT)) assert.match(s, /not confirmed|haven’t confirmed/, s);
  assert.match(SAVE_CTA_TEXT, /turning the controller off should discard it/);
  assert.doesNotMatch(SAVE_CTA_TEXT, /will (be )?(lost|discard)/i);
  const lost = unsavedLostView();
  for (const line of lost.lines) for (const s of unplugSentences(line)) assert.match(s, /haven’t confirmed/, s);
  assert.match(lost.lines.join(' '), /turning the controller off should/);
  assert.deepEqual(lost.actions, [], 'no new action: Write follows only a calibration from this connection');
  const step = (await read('index.html')).match(/<p class="save-step-text">([^<]*)<\/p>/)[1];
  for (const s of unplugSentences(step)) assert.match(s, /not confirmed/, s);
});

test('after a centered Quick the panel shows Write, which opens the same Write modal and counts as an open', async () => {
  const { h } = await setup();
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  await h.advance(400);
  assert.equal(h.peek().unsaved, true);
  assert.equal(h.eval('shownOutcomeView.tone'), 'ok', h.eval('shownOutcomeView.title'));
  const panel = h.$('calib-outcome');
  assert.equal(panel.dataset.save, 'on');
  assert.match(panel.innerHTML, /data-outcome-action="write"/);
  // Nessun modale si apre da solo.
  assert.equal(h.visible('modal-flash'), false);
  h.eval("runOutcomeAction('write')");
  await h.advance(50);
  assert.equal(h.visible('modal-flash'), true);
  assert.equal(h.eval('saveChapter.opens'), 1, 'v2 contract unchanged: counted as an open of the save step');
  await h.run(h.click('btn-flash-go'));
  await h.advance(400);
  assert.equal(h.peek().unsaved, false);
  assert.equal(panel.dataset.save, 'off', 'gone once saved');
});

test('a result to check or a locked Write never shows the panel button, and leaving does not ask', async () => {
  const { h } = await setup();
  const unload = () => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    for (const fn of h.windowListeners.get('beforeunload')) fn(e);
    return e.prevented;
  };
  assert.equal(unload(), false, 'nothing to lose');

  h.eval(`showOutcome(quickOutcomeView({ outcome: 'worse-than-start', worst: 3.0, beforeWorst: 1.24, bestWorst: 1.24, committed: true, session: {} }))`);
  h.ctx.setUnsaved(true);
  await h.advance(50);
  assert.equal(h.eval('currentWriteLock().mode'), 'guarded');
  assert.equal(h.$('calib-outcome').dataset.save, 'off');
  assert.equal(unload(), false, 'a guarded result is not pushed by an exit warning');

  h.eval(`showOutcome(quickOutcomeView({ outcome: 'catastrophic', worst: 22, beforeWorst: 3, bestWorst: 3, committed: true, session: {} }))`);
  await h.advance(50);
  assert.equal(h.eval('currentWriteLock().mode'), 'disabled');
  assert.equal(h.$('calib-outcome').dataset.save, 'off');
  assert.equal(unload(), false, 'Write is off: nothing to save');

  // Calibrazione in corso: l'avviso resta.
  h.eval('ops.beginOp()');
  assert.equal(unload(), true, 'busy still asks');
});

test('a good result shown while not unsaved, or after Write turns off, hides the panel button', async () => {
  const { h } = await setup();
  h.eval(`showOutcome(quickOutcomeView({ outcome: 'centered', worst: 0.555, beforeWorst: 3.2, bestWorst: 0.555, committed: true, session: {} }))`);
  await h.advance(50);
  assert.equal(h.$('calib-outcome').dataset.save, 'off', 'not unsaved');
  h.ctx.setUnsaved(true);
  await h.advance(50);
  assert.equal(h.$('calib-outcome').dataset.save, 'on');
  h.ctx.setRangeWriteLock('incomplete');
  await h.advance(50);
  assert.equal(h.eval('currentWriteLock().mode'), 'disabled');
  assert.equal(h.$('calib-outcome').dataset.save, 'off', 'follows the Write lock');
});

function withSerial(dev, serial) {
  const nvs = dev.nvsCommand.bind(dev);
  dev.nvsCommand = buf => {
    if (buf[0] === 1 && buf[1] === 19) {
      dev.nvResponse = [0x81, 1, 19, 2, ...new TextEncoder().encode(serial)];
      return;
    }
    nvs(buf);
  };
  return dev;
}
async function plug(h, clock, serial, seed) {
  const dev = withSerial(makeDevice(clock, { seed, drift: DRIFTING }), serial);
  h.hid.fire('connect', dev);
  await h.advance(2000);
  assert.equal(h.peek().ds5.device, dev);
  return dev;
}
const unplug = (h, dev) => { dev.unplug(); h.hid.fire('disconnect', dev); };
const SHOW_CENTERED = `showOutcome(quickOutcomeView({ outcome: 'centered', worst: 0.555, beforeWorst: 3.2, bestWorst: 0.555, committed: true, session: {} }))`;

test('unplugged with a savable calibration: the same controller comes back to a note, once', async () => {
  const clock = new VClock();
  const h = await loadApp({ clock });
  const A = await plug(h, clock, 'E8475C3A1B2F', 41);
  h.eval(SHOW_CENTERED);
  h.ctx.setUnsaved(true);
  await h.advance(50);
  const seenToasts = h.toasts().length;
  unplug(h, A);
  await h.advance(100);
  assert.ok(h.toasts().slice(seenToasts).some(t => /never written to memory/.test(t)), 'the disconnect toast is unchanged');

  // Un altro controller: la nota non è sua.
  const B = await plug(h, clock, 'A1B2C3D4E5F6', 42);
  assert.equal(h.visible('calib-outcome'), false);
  unplug(h, B);
  await h.advance(100);

  const A2 = await plug(h, clock, 'E8475C3A1B2F', 43);
  assert.equal(h.visible('calib-outcome'), true);
  assert.equal(h.eval('shownOutcomeView.kind'), 'lost-save');
  assert.match(h.$('calib-outcome').innerHTML, /The last calibration wasn’t saved/);
  assert.doesNotMatch(h.$('calib-outcome').innerHTML, /data-outcome-action="write"/, 'no Write after a reconnect');
  assert.equal(h.peek().unsaved, false);
  assert.equal(h.visible('banner-unsaved'), false);
  // Una volta sola.
  unplug(h, A2);
  await h.advance(100);
  await plug(h, clock, 'E8475C3A1B2F', 44);
  assert.equal(h.visible('calib-outcome'), false, 'shown once');
});

test('no reconnect note when the unsaved result could not be written anyway, or was saved', async () => {
  const clock = new VClock();
  const h = await loadApp({ clock });
  const A = await plug(h, clock, 'E8475C3A1B2F', 51);
  h.eval(`showOutcome(quickOutcomeView({ outcome: 'worse-than-start', worst: 3.0, beforeWorst: 1.24, bestWorst: 1.24, committed: true, session: {} }))`);
  h.ctx.setUnsaved(true);
  await h.advance(50);
  unplug(h, A);
  await h.advance(100);
  await plug(h, clock, 'E8475C3A1B2F', 52);
  assert.notEqual(h.eval('shownOutcomeView?.kind'), 'lost-save', 'guarded: the previous-result panel speaks, not this note');

  const clock2 = new VClock();
  const h2 = await loadApp({ clock: clock2 });
  const C = await plug(h2, clock2, 'C0FFEE123456', 53);
  h2.eval(SHOW_CENTERED);
  h2.ctx.setUnsaved(true);
  await h2.advance(50);
  await h2.run(h2.ctx.doFlash());
  await h2.advance(400);
  assert.equal(h2.peek().unsaved, false);
  unplug(h2, C);
  await h2.advance(100);
  await plug(h2, clock2, 'C0FFEE123456', 54);
  assert.equal(h2.visible('calib-outcome'), false, 'saved: nothing lost');
});

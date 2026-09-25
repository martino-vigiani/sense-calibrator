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

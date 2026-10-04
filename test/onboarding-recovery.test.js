// Regressioni UX del 2026-10-04: fallimenti di copia, chooser senza scelta e
// focus su una vista scomparsa. App reale, DOM e WebHID modello, tempo virtuale:
// verificano l'intento del JS, non layout o comportamento di un browser vero.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

async function loadOnboardingApp(options = {}) {
  const h = await loadApp(options);
  // Solo questi test modellano la discendenza: contiene esattamente i nodi
  // assegnati, indipendentemente dai controlli del gestore che si sta provando.
  for (const id of ['btn-connect', 'btn-copy-link', 'copy-link-url']) h.$('view-hero').appendChild(h.$(id));
  for (const id of ['btn-disconnect', 'drift-card']) h.$('view-device').appendChild(h.$(id));
  h.$('modal-quick').appendChild(h.$('btn-quick-cancel'));
  const outsideLink = h.doc.createElement('a');
  outsideLink.setAttribute('id', 'outside-navigation-link');
  outsideLink.setAttribute('href', 'guides/ps5-stick-drift-fix/');
  h.doc.body.appendChild(outsideLink);
  return { h, outsideLink };
}

async function manuallyConnectedApp() {
  const clock = new VClock();
  const dev = makeDevice(clock);
  const { h, outsideLink } = await loadOnboardingApp({ clock, chooser: [dev] });
  h.$('btn-connect').focus();
  await h.run(h.click('btn-connect'));
  return { h, dev, outsideLink };
}

test('a browser without WebHID keeps Connect disabled and exposes the desktop fallback', async () => {
  // Regressione UX: una CTA attiva portava a un'azione impossibile nel browser.
  const { h } = await loadOnboardingApp({ hidAvailable: false });
  let chooserCalls = 0;
  h.hid.requestDevice = async () => { chooserCalls += 1; return []; };

  await h.click('btn-connect');

  assert.equal(h.$('btn-connect').disabled, true);
  assert.equal(h.visible('unsupported'), true);
  assert.equal(h.doc.querySelector('.hero-cta').classList.contains('hidden'), true);
  assert.match(h.$('unsupported-title').textContent, /Chrome or Edge/);
  assert.equal(h.peek().ds5, null);
  assert.equal(chooserCalls, 0);
});

for (const failure of ['returns false', 'throws']) {
  test(`a failed clipboard and legacy copy expose a persistent selected URL: legacy copy ${failure}`, async () => {
    // Regressione UX: "Press and hold" indicava un URL presente solo in un toast.
    const { h } = await loadOnboardingApp({ hidAvailable: false, search: '?source=test#share' });
    const expectedUrl = h.window.location.href;
    h.ctx.navigator.clipboard.writeText = async () => { throw new Error('Clipboard permission denied'); };
    const copyCommands = [];
    h.doc.execCommand = command => {
      copyCommands.push(command);
      if (failure === 'throws') throw new Error('Legacy copy unavailable');
      return false;
    };

    await h.run(h.click('btn-copy-link'));
    await h.advance(3000); // Tempo virtuale: oltre il reset del bottone e del toast.

    const field = h.$('copy-link-url');
    assert.equal(field.hidden, false);
    assert.equal(field.value, expectedUrl);
    assert.equal(field.hasAttribute('readonly'), true);
    assert.equal(h.doc.activeElement?.id, field.id);
    assert.equal(field.selectionStart, 0);
    assert.equal(field.selectionEnd, expectedUrl.length);
    assert.deepEqual(copyCommands, ['copy']);
  });
}

test('a successful clipboard copy does not reveal the manual-copy field', async () => {
  const { h } = await loadOnboardingApp({ hidAvailable: false });
  const copied = [];
  h.ctx.navigator.clipboard.writeText = async url => { copied.push(url); };
  h.doc.execCommand = () => assert.fail('legacy copy is not needed after clipboard success');

  await h.run(h.click('btn-copy-link'));

  assert.deepEqual(copied, [h.window.location.href]);
  assert.equal(h.$('copy-link-url').hidden, true);
  assert.match(h.$('btn-copy-link').textContent, /copied/i);
});

test('an empty chooser replaces an old connection error with an announced recovery checklist', async () => {
  // Regressione UX: un chooser vuoto lasciava visibile l'errore del tentativo precedente.
  const { h } = await loadOnboardingApp();
  h.hid.requestDevice = async () => { throw Object.assign(new Error('Access denied'), { name: 'NotAllowedError' }); };
  await h.run(h.click('btn-connect'));
  assert.equal(h.visible('hero-error'), true, 'the preceding attempt really failed');
  h.hid.requestDevice = async () => [];

  await h.run(h.click('btn-connect'));

  assert.equal(h.visible('hero-error'), false);
  assert.equal(h.$('hero-error').innerHTML, '');
  assert.equal(h.visible('connect-help'), true);
  assert.equal(h.$('connect-help-status').getAttribute('role'), 'status');
  assert.match(h.$('connect-help-status').textContent, /no.*(?:controller|device).*select|didn['’]t select|no.*chosen/i);
  assert.match(h.$('connect-help-list').innerHTML, /data cable/);
  assert.equal(h.$('btn-connect').disabled, false, 'retry stays available');
});

test('an explicit successful connection moves focus from Connect to the drift card', async () => {
  // Regressione UX: la hero spariva lasciando il focus sul suo bottone nascosto.
  const clock = new VClock();
  const dev = makeDevice(clock);
  const { h } = await loadOnboardingApp({ clock, chooser: [dev] });
  h.$('btn-connect').focus();

  await h.run(h.click('btn-connect'));

  assert.equal(h.peek().ds5?.device, dev);
  assert.equal(h.visible('view-hero'), false);
  assert.equal(h.visible('view-device'), true);
  assert.equal(h.doc.activeElement?.id, 'drift-card');
  assert.equal(h.$('drift-card').getAttribute('tabindex'), '-1');
});

test('a user who moves focus outside the hero during connection keeps that focus', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock);
  const { h, outsideLink } = await loadOnboardingApp({ clock, chooser: [dev] });
  const open = dev.open.bind(dev);
  dev.opened = false;
  dev.open = async () => { outsideLink.focus(); return open(); };
  h.$('btn-connect').focus();

  await h.run(h.click('btn-connect'));

  assert.equal(h.peek().ds5?.device, dev);
  assert.equal(h.doc.activeElement?.id, outsideLink.id, 'connection must respect a newer focus choice');
});

test('disconnecting while focus is in the device view returns focus to Connect', async () => {
  // Regressione UX: il focus rimaneva nella vista del controller ormai nascosta.
  const { h } = await manuallyConnectedApp();
  h.$('btn-disconnect').focus();

  await h.run(h.click('btn-disconnect'));

  assert.equal(h.peek().ds5, null);
  assert.equal(h.visible('view-device'), false);
  assert.equal(h.visible('view-hero'), true);
  assert.equal(h.doc.activeElement?.id, 'btn-connect');
  assert.equal(h.$('btn-connect').disabled, false);
});

test('a physical disconnect closes the modal and restores Connect focus', async () => {
  // Stessa regressione quando HID scompare mentre il fuoco è nel modale.
  const { h, dev } = await manuallyConnectedApp();
  await h.click('btn-quick');
  h.$('btn-quick-cancel').focus();

  h.hid.fire('disconnect', dev);

  assert.equal(h.peek().ds5, null);
  assert.equal(h.visible('modal-quick'), false);
  assert.equal(h.doc.activeElement?.id, 'btn-connect');
});

test('an automatic connection preserves focus on content outside the hero', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock);
  const { h, outsideLink } = await loadOnboardingApp({ clock, authorized: [dev] });
  outsideLink.focus();

  await h.advance(1000);

  assert.equal(h.peek().ds5?.device, dev);
  assert.equal(h.visible('view-device'), true);
  assert.equal(h.doc.activeElement?.id, outsideLink.id);
});

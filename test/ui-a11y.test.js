import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

// WS6 sull'app reale nell'harness DOM-stub. Il DOM finto non calcola layout né
// risolve selettori dentro un elemento: la trappola del fuoco vera (Tab ×20 su
// ogni modale, bottoni coperti dall'avviso) è verificata in Chromium headless
// da ops/ui-check/a11y-check.mjs. Qui si fissano il cablaggio e i ripieghi.

async function connected() {
  const clock = new VClock();
  const dev = makeDevice(clock, { seed: 5, drift: [[2.4, -0.3], [-0.1, 0.4]] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(8000);
  return h;
}

test('the ×10 zoom toggles per dial, with pressed state and label', async () => {
  const h = await connected();
  await h.click('btn-zoom-l');
  assert.equal(h.$('btn-zoom-l').getAttribute('aria-pressed'), 'true');
  assert.match(h.$('dial-l').getAttribute('aria-label'), /zoomed ×10/);
  assert.equal(h.eval('dialL.zoom'), 10);
  assert.equal(h.eval('dialR.zoom ?? 1'), 1, 'the other dial is untouched');
  await h.advance(200); // il loop rAF disegna la vista zoomata senza errori
  await h.click('btn-zoom-l');
  assert.equal(h.$('btn-zoom-l').getAttribute('aria-pressed'), 'false');
  assert.equal(h.$('dial-l').getAttribute('aria-label'), 'Left stick position');
  assert.equal(h.eval('dialL.zoom'), 1);
});

test('the drift verdict detail is written as visible text', async () => {
  const h = await connected();
  assert.ok(h.peek().lastDriftResult, 'the automatic drift test should have finished');
  for (const side of ['l', 'r']) {
    assert.match(h.$(`verdict-${side}-detail`).textContent, /^x [+−]\d+\.\d% · y [+−]\d+\.\d% · noise \d+\.\d%$/);
    assert.equal(h.$(`verdict-${side}`).title, undefined);
  }
});

test('error toasts also go to the alert region, once, and are cleared with the toast', async () => {
  const h = await connected();
  h.eval(`toast('Error while saving: boom', 1000, { alert: true })`);
  assert.equal(h.$('alerts').textContent, 'Error while saving: boom');
  const shown = h.doc.appended.at(-1);
  assert.equal(shown.textContent, 'Error while saving: boom');
  assert.equal(shown.getAttribute('aria-hidden'), 'true', 'the visible toast must not be read twice');
  h.eval(`toast('Saved.', 1000)`);
  assert.equal(h.doc.appended.at(-1).getAttribute('aria-hidden'), null);
  assert.equal(h.$('alerts').textContent, 'Error while saving: boom', 'a polite toast does not touch the alert region');
  await h.advance(1100);
  assert.equal(h.$('alerts').textContent, '');
});

test('Tab never leaves an open modal, even with nothing focusable inside', async () => {
  const h = await connected();
  h.eval(`openModal('modal-range')`);
  await h.advance(50);
  const panel = h.$('modal-range').querySelector('.modal-panel');
  assert.equal(h.doc.activeElement, panel, 'with Done disabled the panel takes the focus');
  h.doc.activeElement = h.doc.body; // fuoco perso (bottone disabilitato)
  let prevented = false;
  for (const fn of h.doc.listeners.get('keydown') ?? []) fn({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.doc.activeElement, panel);
  h.eval(`closeModal('modal-range')`);
});

test('the wizard step is mirrored as text for the aria-hidden dots', async () => {
  const h = await connected();
  // Il DOM finto non ha figli per #wizard-dots: se ne montano sei e si
  // richiama la sincronizzazione che l'osservatore esegue nel browser.
  h.$('wizard-dots').children = Array.from({ length: 6 }, () => h.doc.createElement('i'));
  h.eval('wizardSetDots(0); syncWizardStep()');
  assert.equal(h.$('wizard-step').textContent, 'Not started');
  h.eval('wizardSetDots(3); syncWizardStep()');
  assert.equal(h.$('wizard-step').textContent, 'Step 3 of 5');
  h.eval('wizardSetDots(5); syncWizardStep()');
  assert.equal(h.$('wizard-step').textContent, 'Step 5 of 5');
});

// Conta le scritture su una proprietà di un elemento finto, così si misura
// quante volte una regione live viene riscritta (nel browser ogni scrittura è
// una mutazione, anche con lo stesso testo).
function countWrites(el, prop) {
  let value = el[prop];
  const log = [];
  Object.defineProperty(el, prop, {
    configurable: true,
    get: () => value,
    set: v => { value = String(v); log.push(value); },
  });
  return log;
}

test('#range-hint (role=status) is written only when its text changes', async () => {
  const h = await connected();
  await h.run(h.click('btn-range'));
  const writes = countWrites(h.$('range-hint'), 'textContent');
  await h.advance(4000); // stick a riposo: il tick gira ogni 120 ms, il testo non cambia
  const distinctChanges = writes.filter((w, i) => i === 0 || w !== writes[i - 1]).length;
  assert.ok(h.$('range-hint').textContent.startsWith('Missing: '), h.$('range-hint').textContent);
  assert.equal(writes.length, distinctChanges, `every write must change the text: ${JSON.stringify(writes)}`);
  assert.ok(writes.length <= 1, `a resting stick keeps the same hint, got ${writes.length} writes`);
  await h.advance(16000);
  await h.run(h.click('btn-range-done'));
});

// Rotazione di entrambi gli stick dalla mano del DualSense virtuale.
function rotate(h, dev, { turns, secPerTurn = 0.8, dir = 1, amp = 127.5, from = h.clock.now() + 10 }) {
  const dur = turns * secPerTurn * 1000;
  for (const stick of [0, 1]) {
    dev.touches.push({
      stick, t0: from, dur, tail: 1,
      at: (t, ax) => { const a = dir * 2 * Math.PI * (t - from) / (secPerTurn * 1000); return amp * (ax === 0 ? Math.cos(a) : Math.sin(a)); },
    });
  }
  return from + dur;
}

test('#range-hint on the range check step is written only when its text changes', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { seed: 21 });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.run(h.click('btn-range'));
  const e1 = rotate(h, dev, { turns: 2.2 });
  const e2 = rotate(h, dev, { turns: 1.2, dir: -1, from: e1 });
  await h.advance(e2 - h.clock.now() + 100);
  await h.run(h.click('btn-range-done'));
  assert.ok(h.peek().rangeCheck, 'on the check step');
  const turning = countWrites(h.$('range-hint'), 'textContent');
  const end = rotate(h, dev, { turns: 1.2 });
  await h.advance(end - h.clock.now() + 200);
  assert.equal(turning.length, turning.filter((w, i) => i === 0 || w !== turning[i - 1]).length, 'no identical rewrite while turning');
  assert.ok(turning.length <= Math.ceil((1.2 * 800 + 200) / 120) + 1, `throttled to the 120 ms tick, got ${turning.length}`);
  const resting = countWrites(h.$('range-hint'), 'textContent');
  await h.advance(2000); // stick a riposo, passo di verifica ancora aperto
  assert.match(h.$('range-hint').textContent, /^Circularity error/);
  assert.ok(resting.length <= 1, `a resting stick keeps the same check hint, got ${resting.length} writes`);
});

test('setLive skips identical text and identical HTML', async () => {
  const h = await connected();
  const el = h.$('quick-msg');
  const text = countWrites(el, 'textContent');
  const html = countWrites(el, 'innerHTML');
  h.eval(`setLive($('quick-msg'), 'Hold still')`);
  h.eval(`setLive($('quick-msg'), 'Hold still')`);
  assert.deepEqual(text, ['Hold still']);
  h.eval(`setLive($('quick-msg'), 'Pass <b>1</b>', { html: true })`);
  h.eval(`setLive($('quick-msg'), 'Pass <b>1</b>', { html: true })`);
  h.eval(`setLive($('quick-msg'), 'Pass <b>2</b>', { html: true })`);
  assert.deepEqual(html, ['Pass <b>1</b>', 'Pass <b>2</b>']);
});

test('game.js writes its live regions only when the text changes', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../js/game.js', import.meta.url), 'utf8');
  // La vista del test è ricalcolata a ogni frame: #game-instr e #game-why
  // (role="status") passano solo dal writer con il confronto.
  assert.match(src, /const setText = \(el, value\) => \{ if \(el && el\.textContent !== value\) el\.textContent = value; \};/);
  assert.doesNotMatch(src, /elInstr\.textContent\s*=/);
  assert.doesNotMatch(src, /elWhy\.textContent\s*=/);
});

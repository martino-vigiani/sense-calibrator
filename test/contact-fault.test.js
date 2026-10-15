import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTACT_DEFAULTS, createContactFaultDetector } from '../js/calib/contact-fault.js';
import { contactFaultView, deadzoneFor } from '../js/ui/contact-fault-view.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

// Contatto instabile: un asse che a riposo salta fra due livelli mentre
// l'altro asse dello stesso stick resta fermo. Le sorgenti qui sono sintetiche
// e ricalcano lo schema misurato su un DualSense vero (X sinistro 127 ↔ 130/131,
// gli altri assi immobili); la telemetria reale non entra nel repo.

const n = b => (b - 127.5) / 127.5;
const PERIOD = 4; // ms, ~250 Hz

// bytes(i) → [lx, ly, rx, ry]; gapEvery/gapMs inseriscono buchi nei report.
function feed(det, ms, bytes, { gapEvery = 0, gapMs = 0, t0 = 0 } = {}) {
  const out = [];
  let t = t0;
  for (let i = 0; t < t0 + ms; i++) {
    const [lx, ly, rx, ry] = bytes(i);
    out.push(...det.push({ lx: n(lx), ly: n(ly), rx: n(rx), ry: n(ry) }, t));
    t += PERIOD + (gapEvery && i % gapEvery === gapEvery - 1 ? gapMs : 0);
  }
  return { out, t };
}

// Generatore deterministico per il rumore di fondo.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const flipping = (lo, hi, every = 3) => i => [Math.floor(i / every) % 2 ? hi : lo, 128, 128, 128];

test('il rumore normale a riposo (126/127/128) non fa mai scattare il riconoscimento', () => {
  const r = rng(1);
  const det = createContactFaultDetector();
  const { out } = feed(det, 60_000, () => [126 + Math.floor(r() * 3), 128, 127 + Math.floor(r() * 2), 128]);
  assert.deepEqual(out, []);
  assert.deepEqual(det.findings(), []);
});

test('un asse che salta 127 ↔ 131 con l’altro fermo è confermato dopo due finestre', () => {
  const det = createContactFaultDetector();
  const { out } = feed(det, 3000, flipping(127, 131));
  assert.equal(out.length, 1, 'una sola conferma, alla seconda finestra');
  const [f] = out;
  assert.equal(f.stick, 'left');
  assert.equal(f.axis, 'x');
  assert.equal(f.windows, CONTACT_DEFAULTS.confirmWindows);
  assert.equal(f.jumpLsb, 4);
  assert.equal(f.spanLsb, 4);
  assert.equal(f.spanPct, 3.1);
  assert.ok(f.jumps >= 2 * CONTACT_DEFAULTS.minJumps);
  assert.equal(det.findings().length, 1);
});

test('una sola finestra positiva non basta: il difetto va confermato', () => {
  const det = createContactFaultDetector();
  let { out, t } = feed(det, 1000, flipping(127, 131));
  assert.deepEqual(out, []);
  ({ out } = feed(det, 30_000, () => [127, 128, 128, 128], { t0: t }));
  assert.deepEqual(out, []);
  assert.deepEqual(det.findings(), []);
});

test('le prove restano fra due raffiche separate: il difetto è intermittente', () => {
  const det = createContactFaultDetector();
  let { t } = feed(det, 1000, flipping(127, 131));
  ({ t } = feed(det, 20_000, () => [127, 128, 128, 128], { t0: t }));
  const { out } = feed(det, 1000, flipping(127, 131), { t0: t });
  assert.equal(out.length, 1, 'la seconda raffica, 20 s dopo, conferma');
});

test('un pollice sullo stick sposta anche l’altro asse: non è un contatto', () => {
  const r = rng(2);
  const det = createContactFaultDetector();
  let x = 127; let y = 128;
  const { out } = feed(det, 30_000, i => {
    if (i % 3 === 0) x = Math.max(122, Math.min(134, x + (r() < 0.5 ? -4 : 4)));
    y = Math.max(124, Math.min(132, y + (r() < 0.5 ? -1 : 1)));
    return [x, y, 128, 128];
  });
  assert.deepEqual(out, []);
});

test('un movimento ampio o uno stick tenuto lontano dal centro non contano', () => {
  const sweep = createContactFaultDetector();
  assert.deepEqual(feed(sweep, 10_000, i => [127 + Math.round(60 * Math.sin(i / 20)), 128, 128, 128]).out, []);
  const held = createContactFaultDetector();
  // Stick fermo al 40% che salta: oltre il raggio del 15% non si giudica.
  assert.deepEqual(feed(held, 10_000, flipping(178, 182)).out, []);
});

test('i salti di 1–2 LSB non sono salti: serve un gradino di almeno 3', () => {
  const det = createContactFaultDetector();
  assert.deepEqual(feed(det, 10_000, flipping(127, 129)).out, []);
});

test('un buco nei report oltre 100 ms riavvia la finestra', () => {
  const det = createContactFaultDetector();
  // Un buco ogni ~500 ms: nessuna finestra arriva a 1 s di report continui.
  assert.deepEqual(feed(det, 20_000, flipping(127, 131), { gapEvery: 120, gapMs: 150 }).out, []);
});

test('reset tiene le prove, clear le dimentica', () => {
  const det = createContactFaultDetector();
  feed(det, 3000, flipping(127, 131));
  det.reset();
  assert.equal(det.findings().length, 1);
  det.clear();
  assert.deepEqual(det.findings(), []);
});

test('un’ampiezza che cresce dopo la conferma viene riportata di nuovo', () => {
  const det = createContactFaultDetector();
  let { t } = feed(det, 3000, flipping(127, 131));
  const { out } = feed(det, 1100, i => [i % 6 < 3 ? 127 : 133, 128, 128, 128], { t0: t });
  assert.equal(out.length, 1);
  assert.equal(out[0].spanLsb, 6);
  assert.equal(out[0].spanPct, 4.7);
});

test('il testo descrive la misura, consiglia la deadzone e non promette la calibrazione', () => {
  assert.equal(deadzoneFor(4.7), 6);
  assert.equal(deadzoneFor(3.1), 5);
  assert.equal(contactFaultView([]), null);
  const view = contactFaultView([{ stick: 'left', axis: 'x', windows: 3, jumps: 400, jumpLsb: 4, spanLsb: 6, spanPct: 4.7 }]);
  assert.equal(view.title, 'Left stick: the horizontal axis jumps on its own');
  assert.match(view.html, /deadzone of at least 6% on this stick/);
  assert.match(view.html, /Calibration sets the center, so it can’t stop these jumps/);
  assert.doesNotMatch(view.html, /\bwill fix\b|\bguarantee/i);
  const two = contactFaultView([
    { stick: 'left', axis: 'x', windows: 3, jumps: 10, jumpLsb: 4, spanLsb: 4, spanPct: 3.1 },
    { stick: 'right', axis: 'y', windows: 2, jumps: 8, jumpLsb: 3, spanLsb: 5, spanPct: 3.9 },
  ]);
  assert.equal(two.title, 'Unstable stick contacts');
  assert.match(two.html, /at least 5% on these sticks/);
});

/* ------------------------------ app vera ------------------------------ */

// Contatto difettoso sull'X sinistro dal secondo 10 per 10 s: +4 LSB ogni 12 ms.
const contactFlip = { stick: 0, t0: 10_000, dur: 10_000, tail: 0, at: (t, ax) => (ax === 0 && Math.floor(t / 12) % 2 ? 4 : 0) };

test('app: un contatto che salta a riposo compare nel riquadro, senza comandi HID e senza telemetria', async () => {
  const clock = new VClock();
  const dev = makeDevice(clock, { seed: 11, schedule: [contactFlip] });
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(8000);
  assert.equal(h.visible('contact-fault'), false, 'prima dei salti il riquadro è nascosto');
  const commandsBefore = { ...dev.counts };
  await h.advance(6000);
  assert.equal(h.visible('contact-fault'), true);
  const html = h.$('contact-fault').innerHTML;
  assert.match(html, /Left stick: the horizontal axis jumps on its own/);
  assert.match(html, /deadzone of at least \d+%/);
  assert.deepEqual(dev.counts, commandsBefore, 'nessun comando verso il controller');
  assert.ok(h.sessions().some(e => e.kind === 'contact-fault' && e.stick === 'left' && e.axis === 'x'));
  assert.equal(h.uploadsV2?.some?.(e => e.type === 'contact-fault') ?? false, false);
});

test('app: un controller sano non mostra il riquadro e lo stacco lo azzera', async () => {
  const clock = new VClock();
  const healthy = makeDevice(clock, { seed: 12 });
  const h = await loadApp({ clock, authorized: [healthy] });
  await h.advance(30_000);
  assert.equal(h.visible('contact-fault'), false);

  const clock2 = new VClock();
  const faulty = makeDevice(clock2, { seed: 13, schedule: [contactFlip] });
  const h2 = await loadApp({ clock: clock2, authorized: [faulty] });
  await h2.advance(14_000);
  assert.equal(h2.visible('contact-fault'), true);
  await h2.run(h2.eval('teardown()'));
  assert.equal(h2.visible('contact-fault'), false, 'un altro controller non eredita il riscontro');
});

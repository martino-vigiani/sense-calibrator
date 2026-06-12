'use strict';

import { DS5, HID_FILTERS } from './ds5.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Soglie verdetto drift (% di deflessione massima a riposo)
const DRIFT_OK_MAX = 1.2;
const DRIFT_MILD_MAX = 3.5;
const DRIFT_TEST_MS = 2500;
// Il drift è un offset (anche grande) ma stabile: per distinguerlo dal tocco
// dell'utente si guarda l'escursione del segnale in una finestra breve,
// mai il valore assoluto.
const DRIFT_WINDOW = 30;        // campioni per finestra di stabilità (~120 ms)
const DRIFT_MOVE_SPREAD = 0.08; // escursione oltre cui è movimento, non drift
const DRIFT_MIN_STABLE = 0.4;   // frazione minima di campioni stabili
const DRIFT_MAX_RETRIES = 2;

// Calibrazione range
const RANGE_BINS = 36;
const RANGE_RADIUS_OK = 0.8;
const RANGE_UNLOCK_MS = 15000;

let ds5 = null;
let sticks = { lx: 0, ly: 0, rx: 0, ry: 0 };
let battery = null;
let unsaved = false;
let busy = false; // una calibrazione alla volta

/* ============================== log & toast ============================== */

const logEl = $('log');
function log(msg) {
  const ts = new Date().toLocaleTimeString('it-IT', { hour12: false });
  logEl.textContent += `${ts}  ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function toast(msg, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

/* ============================== dial canvas ============================== */

const INK = '#0a0a0a';
const GRID = '#e4e4e0';
const MID = '#c9c9c5';

class StickDial {
  constructor(canvas, { traceMode = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.traceMode = traceMode;
    this.trail = [];
    this.bins = new Array(RANGE_BINS).fill(0);
    this.x = 0;
    this.y = 0;
    const dpr = window.devicePixelRatio || 1;
    this.size = canvas.width; // dimensione logica dal markup
    canvas.width = this.size * dpr;
    canvas.height = this.size * dpr;
    this.ctx.scale(dpr, dpr);
  }

  push(x, y) {
    this.x = x;
    this.y = y;
    if (this.traceMode) {
      const r = Math.hypot(x, y);
      const bin = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * RANGE_BINS) % RANGE_BINS;
      if (r > this.bins[bin]) this.bins[bin] = r;
    } else {
      this.trail.push({ x, y });
      if (this.trail.length > 36) this.trail.shift();
    }
  }

  resetBins() { this.bins.fill(0); }

  coverage() {
    return this.bins.filter(v => v >= RANGE_RADIUS_OK).length / RANGE_BINS;
  }

  draw() {
    const { ctx, size } = this;
    const c = size / 2;
    const R = size / 2 - 14;
    ctx.clearRect(0, 0, size, size);

    // griglia
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c, R / 2, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
    ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
    ctx.stroke();

    // anello deadzone 5% di riferimento
    ctx.strokeStyle = MID;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.arc(c, c, R * 0.05 + 3, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]);

    if (this.traceMode) {
      // poligono dei massimi raggiunti
      ctx.beginPath();
      for (let i = 0; i < RANGE_BINS; i++) {
        const ang = (i + 0.5) / RANGE_BINS * 2 * Math.PI - Math.PI;
        const r = Math.min(this.bins[i], 1.05) * R;
        const px = c + Math.cos(ang) * r;
        const py = c + Math.sin(ang) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(10,10,10,0.08)';
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      // scia
      for (let i = 1; i < this.trail.length; i++) {
        const a = this.trail[i - 1];
        const b = this.trail[i];
        ctx.strokeStyle = `rgba(10,10,10,${(i / this.trail.length) * 0.35})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(c + a.x * R, c + a.y * R);
        ctx.lineTo(c + b.x * R, c + b.y * R);
        ctx.stroke();
      }
    }

    // punto corrente
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(c + this.x * R, c + this.y * R, 5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

const dialL = new StickDial($('dial-l'));
const dialR = new StickDial($('dial-r'));
const dialRangeL = new StickDial($('dial-range-l'), { traceMode: true });
const dialRangeR = new StickDial($('dial-range-r'), { traceMode: true });

/* ============================== render loop ============================== */

let lastReadout = 0;
function frame(ts) {
  dialL.push(sticks.lx, sticks.ly);
  dialR.push(sticks.rx, sticks.ry);
  dialL.draw();
  dialR.draw();

  if (ds5) {
    if (rangeSession) {
      dialRangeL.push(sticks.lx, sticks.ly);
      dialRangeR.push(sticks.rx, sticks.ry);
      dialRangeL.draw();
      dialRangeR.draw();
      updateRangeUI(ts);
    }

    if (ts - lastReadout > 100) {
      lastReadout = ts;
      const f = v => (v >= 0 ? '+' : '') + v.toFixed(3);
      $('ro-lx').textContent = f(sticks.lx);
      $('ro-ly').textContent = f(sticks.ly);
      $('ro-rx').textContent = f(sticks.rx);
      $('ro-ry').textContent = f(sticks.ry);
      $('ro-lo').textContent = (Math.hypot(sticks.lx, sticks.ly) * 100).toFixed(1) + '%';
      $('ro-ro').textContent = (Math.hypot(sticks.rx, sticks.ry) * 100).toFixed(1) + '%';
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ============================== connessione ============================== */

function setConnChip(connected) {
  $('conn-dot').classList.toggle('on', connected);
  $('chip-conn').classList.toggle('chip-on', connected);
  $('chip-conn-text').textContent = connected ? 'Collegato · USB' : 'Non collegato';
}

function showHeroError(html) {
  const el = $('hero-error');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function setNvChip(nv) {
  const el = $('chip-nvs');
  el.classList.remove('hidden', 'chip-warn', 'chip-on');
  if (!nv) { el.classList.add('hidden'); return; }
  if (nv.status === 'locked') { el.textContent = 'NVS protetta'; el.classList.add('chip-on'); }
  else if (nv.status === 'unlocked') { el.textContent = 'NVS sbloccata'; el.classList.add('chip-warn'); }
  else if (nv.status === 'pending_reboot') { el.textContent = 'Riavvio richiesto'; el.classList.add('chip-warn'); }
  else el.textContent = 'NVS ?';
}

function setBatteryChip() {
  const el = $('chip-battery');
  if (!battery) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = battery.charging ? `In carica · ${battery.level}%` : `Batteria ${battery.level}%`;
}

async function refreshNv() {
  if (!ds5) return;
  const nv = await ds5.queryNvStatus();
  setNvChip(nv);
  return nv;
}

async function connect() {
  if (!navigator.hid) {
    showHeroError('<b>WebHID non disponibile.</b> Usa Chrome o Edge: Safari e Firefox non supportano l’accesso ai dispositivi HID.');
    return;
  }
  try {
    const devices = await navigator.hid.requestDevice({ filters: HID_FILTERS });
    if (devices.length === 0) return;
    await adopt(devices[0]);
  } catch (error) {
    showHeroError(`<b>Connessione fallita.</b> ${esc(error.message || error)}`);
    log(`Errore connessione: ${error.message || error}`);
  }
}

async function adopt(device) {
  if (!device.opened) await device.open();
  const candidate = new DS5(device, log);

  if (candidate.isBluetooth()) {
    await candidate.close();
    showHeroError('<b>Controller in Bluetooth.</b> La calibrazione richiede il collegamento via <b>cavo USB</b>: collegalo e riprova.');
    return;
  }

  ds5 = candidate;
  log(`Collegato: ${device.productName}`);
  setConnChip(true);

  device.oninputreport = onInputReport;

  // info dispositivo (non bloccanti)
  const info = await ds5.getInfo();
  renderDeviceInfo(info);
  await refreshNv();

  $('view-hero').classList.add('hidden');
  $('view-device').classList.remove('hidden');
  $('hero-error').classList.add('hidden');

  // test drift automatico dopo un breve assestamento
  setTimeout(() => startDriftTest(true), 900);
}

function renderDeviceInfo(info) {
  $('device-sub').textContent = info.serial || 'numero di serie non disponibile';
  const rows = [];
  if (info.color) rows.push(['Colore', info.color]);
  if (info.board) rows.push(['Scheda', info.board]);
  if (info.buildDate) rows.push(['Firmware', info.buildDate]);
  if (info.fwversion) rows.push(['Versione', '0x' + info.fwversion.toString(16)]);
  $('device-info').innerHTML = rows
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');
}

function teardown(message = null) {
  ds5 = null;
  battery = null;
  rangeSession = null;
  driftTest = null;
  busy = false;
  setConnChip(false);
  setNvChip(null);
  setBatteryChip();
  setUnsaved(false);
  closeAllModals();
  $('view-device').classList.add('hidden');
  $('view-hero').classList.remove('hidden');
  if (message) toast(message);
}

async function disconnect() {
  if (ds5) {
    const d = ds5;
    ds5 = null;
    await d.close().catch(() => {});
  }
  teardown();
  log('Scollegato.');
}

/* ============================== input report ============================== */

let lastBattery = 0;
function onInputReport(event) {
  if (event.reportId !== 0x01 || event.data.byteLength < 4) return;
  const d = event.data;
  const n = v => (v - 127.5) / 127.5;
  sticks = {
    lx: n(d.getUint8(0)),
    ly: n(d.getUint8(1)),
    rx: n(d.getUint8(2)),
    ry: n(d.getUint8(3)),
  };

  if (driftTest) driftSample();

  const now = performance.now();
  if (now - lastBattery > 2000 && ds5) {
    lastBattery = now;
    battery = ds5.parseBattery(d);
    setBatteryChip();
  }
}

/* ============================== test drift ============================== */

let driftTest = null;

function cancelDriftTest() {
  if (!driftTest) return;
  driftTest = null;
  $('drift-card').dataset.state = 'idle';
  $('drift-progress').classList.add('hidden');
  $('drift-status').textContent = 'In attesa…';
}

function startDriftTest(auto = false) {
  if (!ds5 || busy) return;
  driftTest = {
    samples: [],
    deadline: performance.now() + DRIFT_TEST_MS,
    retries: 0,
    auto,
  };
  const card = $('drift-card');
  card.dataset.state = 'testing';
  $('drift-status').textContent = 'Test in corso — non toccare gli stick…';
  $('drift-progress').classList.remove('hidden');
  $('verdict-l').classList.add('hidden');
  $('verdict-r').classList.add('hidden');
  driftTick();
}

function driftSample() {
  driftTest.samples.push({ ...sticks });
}

// Classifica ogni campione come stabile o in movimento guardando l'escursione
// (max-min per asse) nella finestra dei DRIFT_WINDOW campioni precedenti.
// Un drift fermo, anche enorme, è stabile; una mano sullo stick no.
function extractStableSamples(samples) {
  const axes = ['lx', 'ly', 'rx', 'ry'];
  const stable = [];
  for (let i = DRIFT_WINDOW; i < samples.length; i++) {
    let spread = 0;
    for (const a of axes) {
      let min = Infinity, max = -Infinity;
      for (let j = i - DRIFT_WINDOW; j <= i; j++) {
        const v = samples[j][a];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      spread = Math.max(spread, max - min);
    }
    if (spread <= DRIFT_MOVE_SPREAD) stable.push(samples[i]);
  }
  const denom = samples.length - DRIFT_WINDOW;
  return { stable, fraction: denom > 0 ? stable.length / denom : 0 };
}

function driftTick() {
  if (!driftTest) return;
  const now = performance.now();
  const remaining = Math.max(0, driftTest.deadline - now);
  const pct = 100 - (remaining / DRIFT_TEST_MS) * 100;
  $('drift-progress').querySelector('i').style.width = pct + '%';

  if (remaining > 0) {
    requestAnimationFrame(driftTick);
    return;
  }

  if (driftTest.samples.length <= 50) {
    // nessun input report: probabile problema di collegamento
    finishDriftTest(null);
    $('drift-status').textContent = 'Nessun dato dal controller. Verifica il collegamento USB.';
    return;
  }

  const { stable, fraction } = extractStableSamples(driftTest.samples);

  if (fraction < DRIFT_MIN_STABLE) {
    if (driftTest.retries < DRIFT_MAX_RETRIES) {
      driftTest.retries += 1;
      driftTest.samples = [];
      driftTest.deadline = performance.now() + DRIFT_TEST_MS;
      $('drift-status').textContent = 'Movimento rilevato — nuovo tentativo: non toccare gli stick…';
      requestAnimationFrame(driftTick);
      return;
    }
    // Segnale in movimento continuo anche dopo i tentativi: diagnosi, non errore.
    const result = analyzeDrift(driftTest.samples);
    result.unstable = true;
    finishDriftTest(result);
    return;
  }

  finishDriftTest(analyzeDrift(stable.length > 50 ? stable : driftTest.samples));
}

function analyzeDrift(samples) {
  const mean = key => samples.reduce((a, s) => a + s[key], 0) / samples.length;
  const mlx = mean('lx'), mly = mean('ly'), mrx = mean('rx'), mry = mean('ry');
  const devs = stick => samples
    .map(s => Math.hypot(s[stick + 'x'] - (stick === 'l' ? mlx : mrx), s[stick + 'y'] - (stick === 'l' ? mly : mry)))
    .sort((a, b) => a - b);
  const p95 = arr => arr[Math.floor(arr.length * 0.95)];
  return {
    left: { offset: Math.hypot(mlx, mly) * 100, noise: p95(devs('l')) * 100 },
    right: { offset: Math.hypot(mrx, mry) * 100, noise: p95(devs('r')) * 100 },
  };
}

function verdictFor(stick) {
  if (stick.offset < DRIFT_OK_MAX) return { cls: 'v-ok', label: `Centrato · ${stick.offset.toFixed(1)}%` };
  if (stick.offset < DRIFT_MILD_MAX) return { cls: 'v-mild', label: `Drift lieve · ${stick.offset.toFixed(1)}%` };
  return { cls: 'v-bad', label: `Drift marcato · ${stick.offset.toFixed(1)}%` };
}

let lastDriftResult = null;

function finishDriftTest(result) {
  driftTest = null;
  const card = $('drift-card');
  card.dataset.state = 'idle';
  $('drift-progress').classList.add('hidden');
  if (!result) return;

  const prev = lastDriftResult;
  lastDriftResult = result;

  for (const [side, el] of [['left', 'verdict-l'], ['right', 'verdict-r']]) {
    const v = verdictFor(result[side]);
    const badge = $(el);
    badge.className = `verdict ${v.cls}`;
    badge.textContent = v.label;
    badge.classList.remove('hidden');
  }

  const worst = Math.max(result.left.offset, result.right.offset);
  const noisy = Math.max(result.left.noise, result.right.noise) > 1.5;
  let msg;
  if (result.unstable) {
    msg = 'Stick in movimento continuo durante il test. Se non li stavi toccando, il segnale è gravemente '
      + 'instabile (sensore usurato): la calibrazione del centro può attenuare ma non eliminare il problema.';
  } else if (worst < DRIFT_OK_MAX) {
    msg = 'Stick centrati correttamente. Nessuna calibrazione necessaria.';
  } else if (worst < DRIFT_MILD_MAX) {
    msg = 'Rilevato drift lieve. Una calibrazione rapida dovrebbe risolverlo.';
  } else {
    msg = 'Rilevato drift marcato. Consigliata la calibrazione rapida; se non basta, usa la guidata.';
  }
  if (noisy && !result.unstable) msg += ' Il segnale è instabile: il potenziometro potrebbe essere usurato.';
  if (prev && unsaved) {
    const before = Math.max(prev.left.offset, prev.right.offset);
    msg = `Offset massimo: prima ${before.toFixed(1)}% → ora ${worst.toFixed(1)}%. ` + msg;
  }
  $('drift-status').textContent = msg;
}

/* ============================== unsaved / flash ============================== */

function setUnsaved(v) {
  unsaved = v;
  $('banner-unsaved').classList.toggle('hidden', !v);
}

async function doFlash() {
  closeModal('modal-flash');
  if (!ds5) return;
  busy = true;
  try {
    await ds5.flash();
    const nv = await refreshNv();
    setUnsaved(false);
    if (nv?.status === 'pending_reboot') {
      toast('Salvato. Il controller richiede un riavvio: usa il pulsante "Riavvia".', 5000);
    } else {
      toast('Calibrazione salvata permanentemente nel controller.');
    }
    log('Flash completato.');
  } catch (error) {
    toast(`Errore durante il salvataggio: ${error.message}`, 5000);
    log(`Errore flash: ${error.message}`);
  } finally {
    busy = false;
  }
}

/* ============================== calibrazione rapida ============================== */

async function quickCalibrate() {
  if (!ds5 || busy) return;
  cancelDriftTest();
  busy = true;
  const bar = $('quick-bar');
  const msg = $('quick-msg');
  $('btn-quick-go').disabled = true;
  $('btn-quick-cancel').disabled = true;
  try {
    msg.innerHTML = 'Calibrazione in corso — <b>non toccare gli stick</b>…';
    bar.style.width = '10%';
    await sleep(800);
    await ds5.calibBegin();
    bar.style.width = '25%';
    for (let i = 0; i < 5; i++) {
      await sleep(120);
      await ds5.calibSample();
      bar.style.width = (25 + (i + 1) * 12) + '%';
    }
    await sleep(200);
    await ds5.calibEnd();
    bar.style.width = '100%';
    await sleep(350);
    closeModal('modal-quick');
    setUnsaved(true);
    toast('Calibrazione rapida completata. Verifica con il test drift.');
    log('Calibrazione rapida completata.');
    busy = false;
    startDriftTest();
  } catch (error) {
    busy = false;
    closeModal('modal-quick');
    toast(`Calibrazione fallita: ${error.message}`, 5000);
    log(`Errore calibrazione rapida: ${error.message}`);
  } finally {
    $('btn-quick-go').disabled = false;
    $('btn-quick-cancel').disabled = false;
    bar.style.width = '0%';
    msg.innerHTML = 'Appoggia il controller su una superficie stabile e <b>non toccare gli stick</b>.';
  }
}

/* ============================== wizard guidato ============================== */

// Posizioni del bersaglio nel diagramma per i 4 angoli
const WIZARD_CORNERS = [
  { label: 'in alto a sinistra', x: 26, y: 26 },
  { label: 'in alto a destra', x: 94, y: 26 },
  { label: 'in basso a sinistra', x: 26, y: 94 },
  { label: 'in basso a destra', x: 94, y: 94 },
];

let wizard = null; // { step }

function wizardSetDots(step) {
  [...$('wizard-dots').children].forEach((dot, i) => {
    dot.className = i < step ? 'done' : i === step ? 'active' : '';
  });
}

function wizardShowCorner(i) {
  const c = WIZARD_CORNERS[i];
  $('wizard-diagram').classList.remove('hidden');
  $('wizard-line').setAttribute('x2', c.x);
  $('wizard-line').setAttribute('y2', c.y);
  $('wizard-target').setAttribute('cx', c.x);
  $('wizard-target').setAttribute('cy', c.y);
  $('wizard-msg').innerHTML =
    `Porta <b>entrambi gli stick ${c.label}</b>, poi rilasciali.<br>Quando sono tornati al centro, premi <b>Continua</b>.`;
}

async function wizardNext() {
  if (!ds5) return;
  const btn = $('btn-wizard-next');
  btn.disabled = true;
  try {
    if (wizard.step === 0) {
      // avvio
      await ds5.calibBegin();
      busy = true;
      $('btn-wizard-cancel').classList.add('hidden');
      wizardShowCorner(0);
      btn.textContent = 'Continua';
    } else if (wizard.step >= 1 && wizard.step <= 3) {
      await sleep(150);
      await ds5.calibSample();
      wizardShowCorner(wizard.step);
    } else if (wizard.step === 4) {
      await sleep(150);
      await ds5.calibSample();
      btn.textContent = 'Salvataggio…';
      await sleep(400);
      await ds5.calibEnd();
      busy = false;
      $('wizard-diagram').classList.add('hidden');
      $('wizard-msg').innerHTML = 'Calibrazione del centro completata. Controlla il risultato con il test drift.';
      btn.textContent = 'Fine';
    } else {
      closeModal('modal-wizard');
      setUnsaved(true);
      startDriftTest();
      return;
    }
    wizard.step += 1;
    wizardSetDots(Math.min(wizard.step, 5));
  } catch (error) {
    busy = false;
    closeModal('modal-wizard');
    toast(`Calibrazione fallita: ${error.message}`, 5000);
    log(`Errore wizard: ${error.message}`);
  } finally {
    btn.disabled = false;
  }
}

function openWizard() {
  if (!ds5 || busy) return;
  cancelDriftTest();
  wizard = { step: 0 };
  wizardSetDots(0);
  $('wizard-diagram').classList.add('hidden');
  $('wizard-msg').innerHTML = 'Questa procedura ricentra gli stick campionando la posizione di riposo dopo ogni movimento. Una volta avviata <b>non può essere annullata</b>: non chiudere la pagina e non scollegare il controller.';
  $('btn-wizard-next').textContent = 'Inizia';
  $('btn-wizard-cancel').classList.remove('hidden');
  openModal('modal-wizard');
}

/* ============================== range ============================== */

let rangeSession = null; // { startTs }

async function openRange() {
  if (!ds5 || busy) return;
  cancelDriftTest();
  try {
    await ds5.rangeBegin();
  } catch (error) {
    toast(`Avvio calibrazione range fallito: ${error.message}`, 5000);
    return;
  }
  busy = true;
  dialRangeL.resetBins();
  dialRangeR.resetBins();
  rangeSession = { startTs: performance.now() };
  $('btn-range-done').disabled = true;
  $('range-bar').style.width = '0%';
  openModal('modal-range');
}

function updateRangeUI(ts) {
  const cov = Math.min(dialRangeL.coverage(), dialRangeR.coverage());
  const pct = Math.round(cov * 100);
  $('range-pct').textContent = `Copertura ${pct}%`;
  $('range-bar').style.width = pct + '%';
  const f = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  $('range-vals').textContent =
    `LX ${f(sticks.lx)} · LY ${f(sticks.ly)} · RX ${f(sticks.rx)} · RY ${f(sticks.ry)}`;
  const elapsed = ts - rangeSession.startTs;
  if (pct >= 100 || elapsed > RANGE_UNLOCK_MS) {
    $('btn-range-done').disabled = false;
  }
}

async function finishRange() {
  if (!ds5 || !rangeSession) return;
  const incomplete = Math.min(dialRangeL.coverage(), dialRangeR.coverage()) < 0.97;
  rangeSession = null;
  try {
    await ds5.rangeEnd();
    closeModal('modal-range');
    setUnsaved(true);
    toast(incomplete
      ? 'Range salvato ma con copertura incompleta: valuta di ripetere la calibrazione.'
      : 'Calibrazione range completata.');
    log('Calibrazione range completata.');
  } catch (error) {
    closeModal('modal-range');
    toast(`Errore calibrazione range: ${error.message}`, 5000);
    log(`Errore range: ${error.message}`);
  } finally {
    busy = false;
  }
}

/* ============================== modali ============================== */

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
function closeAllModals() {
  for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
}

/* ============================== reboot ============================== */

async function rebootController() {
  if (!ds5 || busy) return;
  if (unsaved && !confirm('Hai una calibrazione non salvata: riavviando il controller andrà persa. Continuare?'))
    return;
  await ds5.reboot();
  toast('Controller riavviato: ricollegalo quando si è spento.', 5000);
  // la disconnessione fisica arriverà dall'evento hid
}

/* ============================== eventi ============================== */

$('btn-connect').addEventListener('click', connect);
$('btn-disconnect').addEventListener('click', disconnect);
$('btn-reboot').addEventListener('click', rebootController);
$('btn-retest').addEventListener('click', () => startDriftTest());

$('btn-quick').addEventListener('click', () => { if (!busy && ds5) openModal('modal-quick'); });
$('btn-quick-cancel').addEventListener('click', () => closeModal('modal-quick'));
$('btn-quick-go').addEventListener('click', quickCalibrate);

$('btn-wizard').addEventListener('click', openWizard);
$('btn-wizard-cancel').addEventListener('click', () => closeModal('modal-wizard'));
$('btn-wizard-next').addEventListener('click', wizardNext);

$('btn-range').addEventListener('click', openRange);
$('btn-range-done').addEventListener('click', finishRange);

$('btn-flash').addEventListener('click', () => openModal('modal-flash'));
$('btn-flash-cancel').addEventListener('click', () => closeModal('modal-flash'));
$('btn-flash-go').addEventListener('click', doFlash);

// avvisa prima di chiudere la pagina con modifiche non salvate
window.addEventListener('beforeunload', e => {
  if (unsaved || busy) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================== boot ============================== */

async function boot() {
  if (!navigator.hid) {
    showHeroError('<b>WebHID non disponibile.</b> Apri questa pagina con Chrome o Edge. Se la stai aprendo da file://, servila da localhost (es. <code>python3 -m http.server</code>).');
    $('btn-connect').disabled = true;
    return;
  }

  navigator.hid.addEventListener('disconnect', e => {
    if (ds5 && e.device === ds5.device) {
      log('Controller scollegato.');
      teardown('Controller scollegato.');
    }
  });

  // riconnessione automatica se il permesso è già stato concesso
  try {
    const devices = await navigator.hid.getDevices();
    const known = devices.find(d => d.vendorId === 0x054c && d.productId === 0x0ce6);
    if (known) {
      log('DualSense già autorizzato: connessione automatica…');
      await adopt(known);
    }
  } catch (error) {
    log(`Auto-connessione fallita: ${error.message || error}`);
  }
}

boot();

// Hook di sviluppo: simula la posizione degli stick senza controller.
window.__senseSimulate = (lx, ly, rx, ry) => { sticks = { lx, ly, rx, ry }; };
window.__senseExtractStable = extractStableSamples;

'use strict';

import { DS5, HID_FILTERS } from './ds5.js';
import { initGame } from './game.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Soglie verdetto drift (% di deflessione massima a riposo)
const DRIFT_OK_MAX = 1.2;
const DRIFT_MILD_MAX = 3.5;
const DRIFT_TEST_MS = 3000;
const DRIFT_SETTLE_SAMPLES = 60; // ~250 ms iniziali scartati (assestamento)
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
  constructor(canvas, { traceMode = false, dotRadius = 5 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.traceMode = traceMode;
    this.dotRadius = dotRadius;
    this.target = null; // {x, y} normalizzato: anello bersaglio per il wizard
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

  // Copertura adattiva: un settore conta se il suo massimo si avvicina al
  // massimo globale osservato. Così la scala (calibrata o raw) non falsa
  // il progresso: conta la forma del perimetro, non il valore assoluto.
  coverage() {
    const globalMax = Math.max(...this.bins);
    if (globalMax < 0.5) return 0;
    const thr = Math.max(RANGE_RADIUS_OK * 0.75, globalMax * 0.88);
    return this.bins.filter(v => v >= thr).length / RANGE_BINS;
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

    // anello bersaglio (wizard)
    if (this.target) {
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(c + this.target.x * R, c + this.target.y * R, this.dotRadius + 6, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // punto corrente
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(c + this.x * R, c + this.y * R, this.dotRadius, 0, 2 * Math.PI);
    ctx.fill();
  }
}

const dialL = new StickDial($('dial-l'));
const dialR = new StickDial($('dial-r'));
const dialRangeL = new StickDial($('dial-range-l'), { traceMode: true });
const dialRangeR = new StickDial($('dial-range-r'), { traceMode: true });
const dialWizL = new StickDial($('dial-wiz-l'), { dotRadius: 4 });
const dialWizR = new StickDial($('dial-wiz-r'), { dotRadius: 4 });

/* ============================== render loop ============================== */

let lastReadout = 0;
function frame(ts) {
  dialL.push(sticks.lx, sticks.ly);
  dialR.push(sticks.rx, sticks.ry);
  dialL.draw();
  dialR.draw();

  if (!$('wizard-live').classList.contains('hidden')
      && !$('modal-wizard').classList.contains('hidden')) {
    dialWizL.push(sticks.lx, sticks.ly);
    dialWizR.push(sticks.rx, sticks.ry);
    dialWizL.draw();
    dialWizR.draw();
  }

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
  $('chip-conn-text').textContent = connected ? 'Connected · USB' : 'Not connected';
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
  if (nv.status === 'locked') { el.textContent = 'NVS protected'; el.classList.add('chip-on'); }
  else if (nv.status === 'unlocked') { el.textContent = 'NVS unlocked'; el.classList.add('chip-warn'); }
  else if (nv.status === 'pending_reboot') { el.textContent = 'Restart required'; el.classList.add('chip-warn'); }
  else el.textContent = 'NVS ?';
}

function setBatteryChip() {
  const el = $('chip-battery');
  if (!battery) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.textContent = battery.charging ? `Charging · ${battery.level}%` : `Battery ${battery.level}%`;
}

async function refreshNv() {
  if (!ds5) return;
  const nv = await ds5.queryNvStatus();
  setNvChip(nv);
  return nv;
}

async function connect() {
  if (!navigator.hid) {
    showHeroError('<b>WebHID not available.</b> Use Chrome or Edge: Safari and Firefox don’t support access to HID devices.');
    return;
  }
  try {
    const devices = await navigator.hid.requestDevice({ filters: HID_FILTERS });
    if (devices.length === 0) return;
    await adopt(devices[0]);
  } catch (error) {
    showHeroError(`<b>Connection failed.</b> ${esc(error.message || error)}`);
    log(`Connection error: ${error.message || error}`);
  }
}

async function adopt(device) {
  if (!device.opened) await device.open();
  const candidate = new DS5(device, log);

  if (candidate.isBluetooth()) {
    await candidate.close();
    showHeroError('<b>Controller on Bluetooth.</b> Calibration requires a <b>USB cable</b> connection: plug it in and try again.');
    return;
  }

  ds5 = candidate;
  log(`Connected: ${device.productName}`);
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
  $('device-sub').textContent = info.serial || 'serial number not available';
  const rows = [];
  if (info.color) rows.push(['Color', info.color]);
  if (info.board) rows.push(['Board', info.board]);
  if (info.buildDate) rows.push(['Firmware', info.buildDate]);
  if (info.fwversion) rows.push(['Version', '0x' + info.fwversion.toString(16)]);
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
  log('Disconnected.');
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

  if (rangeSession) {
    for (const a of ['lx', 'ly', 'rx', 'ry']) {
      const v = sticks[a];
      if (v < rangeSession.stats[a].min) rangeSession.stats[a].min = v;
      if (v > rangeSession.stats[a].max) rangeSession.stats[a].max = v;
    }
  }

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
  $('drift-status').textContent = 'Waiting…';
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
  $('drift-status').textContent = 'Test running — don’t touch the sticks…';
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
    $('drift-status').textContent = 'No data from the controller. Check the USB connection.';
    return;
  }

  // scarta l'assestamento iniziale (presa della mano che si stacca, ecc.)
  const usable = driftTest.samples.length > DRIFT_SETTLE_SAMPLES + 100
    ? driftTest.samples.slice(DRIFT_SETTLE_SAMPLES)
    : driftTest.samples;

  const { stable, fraction } = extractStableSamples(usable);

  if (fraction < DRIFT_MIN_STABLE) {
    if (driftTest.retries < DRIFT_MAX_RETRIES) {
      driftTest.retries += 1;
      driftTest.samples = [];
      driftTest.deadline = performance.now() + DRIFT_TEST_MS;
      $('drift-status').textContent = 'Movement detected — retrying: don’t touch the sticks…';
      requestAnimationFrame(driftTick);
      return;
    }
    // Segnale in movimento continuo anche dopo i tentativi: diagnosi, non errore.
    const result = analyzeDrift(usable);
    result.unstable = true;
    finishDriftTest(result);
    return;
  }

  finishDriftTest(analyzeDrift(stable.length > 50 ? stable : usable));
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Mediana per asse invece della media: un singolo sobbalzo o vibrazione
// del tavolo non sposta il risultato.
function analyzeDrift(samples) {
  const med = key => median(samples.map(s => s[key]));
  const mlx = med('lx'), mly = med('ly'), mrx = med('rx'), mry = med('ry');
  const devs = (xk, yk, mx, my) => samples
    .map(s => Math.hypot(s[xk] - mx, s[yk] - my))
    .sort((a, b) => a - b);
  const p95 = arr => arr[Math.floor(arr.length * 0.95)];
  return {
    left: { offset: Math.hypot(mlx, mly) * 100, noise: p95(devs('lx', 'ly', mlx, mly)) * 100, x: mlx, y: mly },
    right: { offset: Math.hypot(mrx, mry) * 100, noise: p95(devs('rx', 'ry', mrx, mry)) * 100, x: mrx, y: mry },
  };
}

function verdictFor(stick) {
  if (stick.offset < DRIFT_OK_MAX) return { cls: 'v-ok', label: `Centered · ${stick.offset.toFixed(1)}%` };
  if (stick.offset < DRIFT_MILD_MAX) return { cls: 'v-mild', label: `Mild drift · ${stick.offset.toFixed(1)}%` };
  return { cls: 'v-bad', label: `Marked drift · ${stick.offset.toFixed(1)}%` };
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
    const r = result[side];
    const v = verdictFor(r);
    const badge = $(el);
    badge.className = `verdict ${v.cls}`;
    badge.textContent = v.label;
    badge.title = `x ${(r.x * 100).toFixed(1)}% · y ${(r.y * 100).toFixed(1)}% · noise ${r.noise.toFixed(1)}%`;
    badge.classList.remove('hidden');
  }

  const worst = Math.max(result.left.offset, result.right.offset);
  const noisy = Math.max(result.left.noise, result.right.noise) > 1.5;
  let msg;
  if (result.unstable) {
    msg = 'Sticks moving continuously during the test. If you weren’t touching them, the signal is severely '
      + 'unstable (worn sensor): center calibration can reduce but not eliminate the problem.';
  } else if (worst < DRIFT_OK_MAX) {
    msg = 'Sticks correctly centered. No calibration needed.';
  } else if (worst < DRIFT_MILD_MAX) {
    msg = 'Mild drift detected. A quick calibration should fix it.';
  } else {
    msg = 'Marked drift detected. Quick calibration recommended; if that’s not enough, use the guided one.';
  }
  if (noisy && !result.unstable) msg += ' The signal is unstable: the potentiometer may be worn.';
  if (prev && unsaved) {
    const before = Math.max(prev.left.offset, prev.right.offset);
    msg = `Max offset: before ${before.toFixed(1)}% → now ${worst.toFixed(1)}%. ` + msg;
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
      toast('Saved. The controller needs a restart: use the "Restart" button.', 5000);
    } else {
      toast('Calibration saved permanently to the controller.');
    }
    log('Flash complete.');
  } catch (error) {
    toast(`Error while saving: ${error.message}`, 5000);
    log(`Flash error: ${error.message}`);
  } finally {
    busy = false;
  }
}

/* ============================== calibrazione rapida ============================== */

const QUICK_MAX_PASSES = 3;
const QUICK_SAMPLES_PER_PASS = 8;

// Misura veloce dell'offset residuo (post-calibrazione), con lo stesso
// filtro di stabilità del test drift.
async function measureOffset(ms = 1200) {
  const samples = [];
  const id = setInterval(() => samples.push({ ...sticks }), 8);
  await sleep(ms);
  clearInterval(id);
  if (samples.length < 40) return null;
  const { stable } = extractStableSamples(samples);
  return analyzeDrift(stable.length > 40 ? stable : samples);
}

// Calibra, verifica, e se l'offset residuo non è sotto soglia ripete:
// converge da solo invece di sperare nella singola passata.
async function quickCalibrate() {
  if (!ds5 || busy) return;
  cancelDriftTest();
  busy = true;
  const bar = $('quick-bar');
  const msg = $('quick-msg');
  $('btn-quick-go').disabled = true;
  $('btn-quick-cancel').disabled = true;
  try {
    await sleep(800);
    let worst = null;
    for (let pass = 1; pass <= QUICK_MAX_PASSES; pass++) {
      const base = ((pass - 1) / QUICK_MAX_PASSES) * 100;
      msg.innerHTML = `Pass ${pass}: calibrating — <b>don’t touch the sticks</b>…`;
      bar.style.width = (base + 4) + '%';

      await ds5.calibBegin();
      for (let i = 0; i < QUICK_SAMPLES_PER_PASS; i++) {
        await sleep(100);
        await ds5.calibSample();
        bar.style.width = (base + 4 + ((i + 1) / QUICK_SAMPLES_PER_PASS) * 18) + '%';
      }
      await sleep(150);
      await ds5.calibEnd();

      msg.innerHTML = `Pass ${pass}: verifying…`;
      const result = await measureOffset();
      bar.style.width = (base + 100 / QUICK_MAX_PASSES) + '%';
      if (!result) break; // niente dati: lascia il giudizio al test drift finale
      worst = Math.max(result.left.offset, result.right.offset);
      log(`Pass ${pass}: residual offset ${worst.toFixed(2)}%`);
      if (worst < DRIFT_OK_MAX) break;
      if (pass < QUICK_MAX_PASSES)
        msg.innerHTML = `Residual offset ${worst.toFixed(1)}% — new pass…`;
    }
    bar.style.width = '100%';
    await sleep(300);
    closeModal('modal-quick');
    setUnsaved(true);
    toast(worst !== null && worst >= DRIFT_OK_MAX
      ? `Calibration complete, residual offset ${worst.toFixed(1)}%. If it persists, try the guided one.`
      : 'Quick calibration complete.');
    log('Quick calibration complete.');
    busy = false;
    startDriftTest();
  } catch (error) {
    busy = false;
    closeModal('modal-quick');
    toast(`Calibration failed: ${error.message}`, 5000);
    log(`Quick calibration error: ${error.message}`);
  } finally {
    $('btn-quick-go').disabled = false;
    $('btn-quick-cancel').disabled = false;
    bar.style.width = '0%';
    msg.innerHTML = 'Rest the controller on a stable surface and <b>don’t touch the sticks</b>.';
  }
}

/* ============================== wizard guidato ============================== */

// Posizioni del bersaglio: nel diagramma (coordinate SVG) e nei mini
// quadranti live (direzione normalizzata, ~angolo a piena corsa).
const WIZARD_CORNERS = [
  { label: 'to the top left', x: 26, y: 26, tx: -0.7, ty: -0.7 },
  { label: 'to the top right', x: 94, y: 26, tx: 0.7, ty: -0.7 },
  { label: 'to the bottom left', x: 26, y: 94, tx: -0.7, ty: 0.7 },
  { label: 'to the bottom right', x: 94, y: 94, tx: 0.7, ty: 0.7 },
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
    `Move <b>both sticks ${c.label}</b> (inside the dashed ring below), then release them.<br>`
    + 'When they’ve returned to the center, press <b>Continue</b>.';
  // mini quadranti live: l'utente vede dove sta puntando davvero,
  // anche con la calibrazione attuale sballata
  $('wizard-live').classList.remove('hidden');
  dialWizL.target = { x: c.tx, y: c.ty };
  dialWizR.target = { x: c.tx, y: c.ty };
}

function wizardHideLive() {
  $('wizard-live').classList.add('hidden');
  dialWizL.target = null;
  dialWizR.target = null;
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
      btn.textContent = 'Continue';
    } else if (wizard.step >= 1 && wizard.step <= 3) {
      await sleep(150);
      await ds5.calibSample();
      wizardShowCorner(wizard.step);
    } else if (wizard.step === 4) {
      await sleep(150);
      await ds5.calibSample();
      btn.textContent = 'Saving…';
      await sleep(400);
      await ds5.calibEnd();
      busy = false;
      $('wizard-diagram').classList.add('hidden');
      wizardHideLive();
      $('wizard-msg').innerHTML = 'Center calibration complete. Check the result with the drift test.';
      btn.textContent = 'Done';
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
    toast(`Calibration failed: ${error.message}`, 5000);
    log(`Wizard error: ${error.message}`);
  } finally {
    btn.disabled = false;
  }
}

function openWizard() {
  if (!ds5 || busy) return;
  cancelDriftTest();
  wizard = { step: 0 };
  wizardSetDots(0);
  wizardHideLive();
  $('wizard-diagram').classList.add('hidden');
  $('wizard-msg').innerHTML = 'This procedure re-centers the sticks by sampling their resting position after each movement. Once started it <b>cannot be cancelled</b>: don’t close the page and don’t disconnect the controller.';
  $('btn-wizard-next').textContent = 'Start';
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
    toast(`Failed to start range calibration: ${error.message}`, 5000);
    return;
  }
  busy = true;
  dialRangeL.resetBins();
  dialRangeR.resetBins();
  rangeSession = {
    startTs: performance.now(),
    stats: {
      lx: { min: 0, max: 0 }, ly: { min: 0, max: 0 },
      rx: { min: 0, max: 0 }, ry: { min: 0, max: 0 },
    },
  };
  $('btn-range-done').disabled = true;
  $('range-bar').style.width = '0%';
  $('range-minmax').innerHTML = '<span>LX —</span><span>LY —</span><span>RX —</span><span>RY —</span>';
  $('range-hint').textContent = 'Extremes not reached yet';
  openModal('modal-range');
}

let lastMinmax = 0;
function updateRangeUI(ts) {
  const cov = Math.min(dialRangeL.coverage(), dialRangeR.coverage());
  const pct = Math.round(cov * 100);
  $('range-pct').textContent = `Coverage ${pct}%`;
  $('range-bar').style.width = pct + '%';

  if (ts - lastMinmax > 120) {
    lastMinmax = ts;
    const st = rangeSession.stats;
    // Soglia relativa al massimo osservato dello stick: con la vecchia
    // calibrazione un bordo compresso non arriva mai a ±1.0, ma conta che
    // l'utente l'abbia spinto a fondo, non il valore assoluto.
    const edgeThr = stick => {
      const axes = stick === 'l' ? [st.lx, st.ly] : [st.rx, st.ry];
      const maxAbs = Math.max(...axes.flatMap(a => [Math.abs(a.min), Math.abs(a.max)]));
      return maxAbs > 0.5 ? Math.max(0.5, maxAbs * 0.7) : Infinity;
    };
    const thrL = edgeThr('l'), thrR = edgeThr('r');
    const f = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
    const span = (name, s, thr) =>
      `<span>${name} <span class="${s.min <= -thr ? 'edge-ok' : ''}">${f(s.min)}</span>…`
      + `<span class="${s.max >= thr ? 'edge-ok' : ''}">${f(s.max)}</span></span>`;
    $('range-minmax').innerHTML =
      span('LX', st.lx, thrL) + span('LY', st.ly, thrL)
      + span('RX', st.rx, thrR) + span('RY', st.ry, thrR);

    const missing = [];
    const dirs = [
      [st.lx.min > -thrL, 'L left'], [st.lx.max < thrL, 'L right'],
      [st.ly.min > -thrL, 'L up'], [st.ly.max < thrL, 'L down'],
      [st.rx.min > -thrR, 'R left'], [st.rx.max < thrR, 'R right'],
      [st.ry.min > -thrR, 'R up'], [st.ry.max < thrR, 'R down'],
    ];
    for (const [miss, label] of dirs) if (miss) missing.push(label);
    rangeSession.allEdges = missing.length === 0;
    $('range-hint').textContent = rangeSession.allEdges
      ? 'All extremes reached ✓'
      : `Missing: ${missing.join(', ')}`;
  }

  const elapsed = ts - rangeSession.startTs;
  if (pct >= 100 || elapsed > RANGE_UNLOCK_MS) {
    $('btn-range-done').disabled = false;
  }
}

async function finishRange() {
  if (!ds5 || !rangeSession) return;
  // Estremi tutti raggiunti = calibrazione valida anche se qualche settore
  // diagonale non arriva al 100% di copertura (gate non perfettamente circolare).
  const incomplete = rangeSession.allEdges !== true
    && Math.min(dialRangeL.coverage(), dialRangeR.coverage()) < 0.97;
  rangeSession = null;
  try {
    await ds5.rangeEnd();
    closeModal('modal-range');
    setUnsaved(true);
    toast(incomplete
      ? 'Range saved but with incomplete coverage: consider repeating the calibration.'
      : 'Range calibration complete.');
    log('Range calibration complete.');
  } catch (error) {
    closeModal('modal-range');
    toast(`Range calibration error: ${error.message}`, 5000);
    log(`Range error: ${error.message}`);
  } finally {
    busy = false;
  }
}

/* ============================== modali ============================== */

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
function closeAllModals() {
  game?.close(); // ferma il loop rAF del gioco, non solo la classe .hidden
  for (const m of document.querySelectorAll('.modal')) m.classList.add('hidden');
}

/* ============================== reboot ============================== */

async function rebootController() {
  if (!ds5 || busy) return;
  if (unsaved && !confirm('You have an unsaved calibration: restarting the controller will lose it. Continue?'))
    return;
  await ds5.reboot();
  toast('Controller restarted: reconnect it once it has powered off.', 5000);
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

// Test di precisione: il gioco legge solo gli stick (deps), nessun comando HID.
const game = initGame({
  getSticks: () => sticks,
  isAvailable: () => !!ds5 && !busy,
});
function openGame(bypassGate = false) {
  if (!bypassGate && (!ds5 || busy)) return;
  cancelDriftTest(); // libera la card drift dal suo loop prima di giocare
  game.open(bypassGate);
}
$('btn-game').addEventListener('click', () => openGame());

// avvisa prima di chiudere la pagina con modifiche non salvate
window.addEventListener('beforeunload', e => {
  if (unsaved || busy) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================== boot ============================== */

async function boot() {
  if (!navigator.hid) {
    showHeroError('<b>WebHID not available.</b> Open this page with Chrome or Edge. If you’re opening it from file://, serve it from localhost (e.g. <code>python3 -m http.server</code>).');
    $('btn-connect').disabled = true;
    return;
  }

  navigator.hid.addEventListener('disconnect', e => {
    if (ds5 && e.device === ds5.device) {
      log('Controller disconnected.');
      teardown('Controller disconnected.');
    }
  });

  // riconnessione automatica se il permesso è già stato concesso
  try {
    const devices = await navigator.hid.getDevices();
    const known = devices.find(d => d.vendorId === 0x054c && d.productId === 0x0ce6);
    if (known) {
      log('DualSense already authorized: connecting automatically…');
      await adopt(known);
    }
  } catch (error) {
    log(`Auto-connection failed: ${error.message || error}`);
  }
}

boot();

// Hook di sviluppo: simula la posizione degli stick senza controller.
window.__senseSimulate = (lx, ly, rx, ry) => { sticks = { lx, ly, rx, ry }; };
window.__senseExtractStable = extractStableSamples;
window.__senseDials = { dialL, dialR, dialWizL, dialWizR, dialRangeL, dialRangeR };
// Apre il gioco bypassando il gate isAvailable: utile per testare senza controller
// in coppia con __senseSimulate.
window.__senseGameOpen = () => openGame(true);

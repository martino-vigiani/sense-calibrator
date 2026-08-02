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
let deviceInfo = null;
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
    this.size = canvas.width; // dimensione logica dal markup, letta una volta sola
    this.dpr = 0;
    this.applyDpr();
  }

  // Rialloca il backing store al devicePixelRatio corrente. Va richiamata
  // quando il DPR cambia (finestra spostata su un monitor con densità diversa,
  // zoom del browser): senza, il canvas resta scalato per il vecchio DPR e i
  // quadranti restano sfocati fino a un reload.
  applyDpr() {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === this.dpr) return false;
    this.dpr = dpr;
    // assegnare width/height azzera lo stato del contesto, trasformazione inclusa
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.scale(dpr, dpr);
    return true;
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
const allDials = [dialL, dialR, dialRangeL, dialRangeR, dialWizL, dialWizR];

// Il DPR non ha un evento dedicato: si osserva con una media query costruita
// sul valore corrente, che scatta appena quel valore smette di essere vero.
// Va riarmata a ogni cambio, perché la query è legata al DPR di allora.
let dprQuery = null;
function watchDpr() {
  dprQuery?.removeEventListener('change', onDprChange);
  dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprQuery.addEventListener('change', onDprChange);
}
function onDprChange() {
  // applyDpr azzera il canvas: i quadranti attivi si ridisegnano al frame
  // successivo, gli altri quando il loro modale torna visibile.
  for (const d of allDials) d.applyDpr();
  watchDpr();
}
watchDpr();

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

/* Browser senza WebHID (mobile e tablet in generale, Safari, Firefox).
   Solo presentazione: sostituisce la CTA con un'istruzione chiara e lascia
   leggibili hero, steps e FAQ. Nessun impatto sulla calibrazione. */
function showUnsupported() {
  const touchOnly = window.matchMedia('(pointer: coarse)').matches;
  if (!touchOnly) {
    $('unsupported-title').textContent = 'Open this page in Chrome or Edge';
    $('unsupported-msg').innerHTML = 'Recalibrating a DualSense means talking to it over a USB cable, and only '
      + '<b>Chromium browsers</b> — Chrome, Edge, Brave, Opera — are allowed to do that. '
      + 'Safari and Firefox don’t support WebHID.';
  }
  $('btn-connect').disabled = true;
  document.querySelector('.hero-cta').classList.add('hidden');
  // "NOT CONNECTED" qui è rumore: non si potrà mai connettere nulla.
  // Liberato lo spazio, la topbar può tenere l'etichetta "GitHub" (vedi CSS).
  $('chip-conn').classList.add('hidden');
  document.body.classList.add('no-hid');
  $('unsupported').classList.remove('hidden');
}

// "Copia link": su mobile l'azione utile è mandarsi la pagina sul desktop.
const btnCopyLink = $('btn-copy-link');
if (btnCopyLink) {
  btnCopyLink.addEventListener('click', async () => {
    const url = location.href;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // contesti non sicuri / permessi negati
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    btnCopyLink.textContent = ok ? 'Link copied' : 'Press and hold to copy';
    toast(ok ? 'Link copied — open it on a desktop with Chrome or Edge.' : url);
    setTimeout(() => { btnCopyLink.textContent = 'Copy link'; }, 2400);
  });
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
  deviceInfo = info;
  renderDeviceInfo(info);
  await refreshNv();

  $('view-hero').classList.add('hidden');
  $('view-device').classList.remove('hidden');
  $('hero-error').classList.add('hidden');

  recordEvent('connect', {
    color: info.color ?? null,
    build: info.buildDate ?? null,
  });

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
  deviceInfo = null;
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

// Chi attende campioni stick (waitForStable) viene notificato dagli input
// report HID: continuano ad arrivare anche quando i timer della pagina sono
// throttlati (finestra in background durante la calibrazione).
const stickListeners = new Set();
function notifyStickSample() {
  for (const fn of stickListeners) fn();
}

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
  notifyStickSample();

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
  $('drift-status').textContent = 'Test running: don’t touch the sticks…';
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
      $('drift-status').textContent = 'Movement detected. Retrying: don’t touch the sticks…';
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
  const auto = driftTest?.auto === true;
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
  recordEvent('drift', {
    auto,
    res: summarizeResult(result),
    worst: +worst.toFixed(2),
    unstable: result.unstable === true,
  });
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
    recordEvent('flash', { ok: true, nv: nv?.status ?? null });
    setUnsaved(false);
    if (nv?.status === 'pending_reboot') {
      toast('Saved. The controller needs a restart: use the "Restart" button.', 5000);
    } else {
      toast('Calibration saved permanently to the controller.');
    }
    log('Flash complete.');
  } catch (error) {
    recordEvent('flash', { ok: false, err: String(error.message || error).slice(0, 120) });
    toast(`Error while saving: ${error.message}`, 5000);
    log(`Flash error: ${error.message}`);
  } finally {
    busy = false;
  }
}

/* ============================== calibrazione rapida ============================== */

const QUICK_MAX_PASSES = 4;
const QUICK_SAMPLES_PER_PASS = 12;
// Gating di stabilità: ogni calibSample viene inviato solo quando il segnale
// è rimasto entro QUICK_STABLE_SPREAD per QUICK_STABLE_MS. Così un tocco,
// una vibrazione o un cavo mosso non contaminano la media del firmware.
const QUICK_STABLE_SPREAD = 0.035;  // più severo di DRIFT_MOVE_SPREAD
// Uno stick consumato oscilla da solo: il gate si adatta al rumore proprio
// del controller (stimato dalla misura baseline) e non scende mai sotto
// QUICK_STABLE_SPREAD né sale oltre QUICK_STABLE_SPREAD_MAX. Così il jitter
// automatico non blocca la calibrazione, ma l'escursione grande di una mano
// viene ancora respinta.
// Tetto = DRIFT_MOVE_SPREAD: un gate di stabilità più permissivo della soglia
// con cui l'app stessa dichiara "questo è movimento" sarebbe auto-contraddittorio
// (a 0.12 bastavano due allargamenti per superarla e far passare una mano).
const QUICK_STABLE_SPREAD_MAX = DRIFT_MOVE_SPREAD;
const QUICK_STABLE_MS = 300;
const QUICK_STABLE_TIMEOUT = 5000;
// Sotto questo miglioramento tra passate l'offset residuo è al pavimento
// del rumore: ripetere non serve più.
const QUICK_CONVERGE_EPS = 0.15;    // punti percentuali
// Soglia per dichiarare un PEGGIORAMENTO all'utente. Deve stare sopra un passo
// di quantizzazione (1 LSB = 0.784 punti): sotto, la differenza fra due misure
// è rumore di misura e avvisare produrrebbe solo falsi allarmi.
const QUICK_REGRESSION_EPS = 0.8;
const QUICK_NOISE_WORN = 1.5;       // noise p95 oltre cui il sensore è consumato

// Attende che tutti gli assi restino entro `spread` per `holdMs` consecutivi.
// Ritorna false se il segnale non si stabilizza entro `timeoutMs`.
// Guidato dagli input report HID, non da un timer: il gating resta preciso
// anche con i timer della pagina throttlati.
function waitForStable({ spread = QUICK_STABLE_SPREAD, holdMs = QUICK_STABLE_MS, timeoutMs = QUICK_STABLE_TIMEOUT } = {}) {
  return new Promise(resolve => {
    const start = performance.now();
    const win = [];
    const done = ok => {
      stickListeners.delete(onSample);
      clearTimeout(guard);
      resolve(ok);
    };
    const onSample = () => {
      const now = performance.now();
      win.push({ ...sticks, t: now });
      while (win.length && win[0].t < now - holdMs) win.shift();
      if (win.length >= 10 && now - win[0].t >= holdMs * 0.8) {
        let maxSpread = 0;
        for (const a of ['lx', 'ly', 'rx', 'ry']) {
          let min = Infinity, max = -Infinity;
          for (const s of win) {
            if (s[a] < min) min = s[a];
            if (s[a] > max) max = s[a];
          }
          maxSpread = Math.max(maxSpread, max - min);
        }
        if (maxSpread <= spread) return done(true);
      }
      if (now - start >= timeoutMs) done(false);
    };
    stickListeners.add(onSample);
    // guardia per il caso "nessun input report" (controller muto)
    const guard = setTimeout(() => done(false), timeoutMs + 250);
  });
}

// Misura dell'offset residuo (pre/post calibrazione), con lo stesso
// filtro di stabilità del test drift.
// Campiona sugli input report HID, non su un timer: un setInterval viene
// throttlato quando la tab va in background (la verifica restava senza dati
// e la passata di convergenza si interrompeva), e a 8 ms sotto-campionava i
// ~250 Hz del controller duplicando campioni identici — il che falsava sia la
// frazione di stabilità sia la durata reale di DRIFT_WINDOW.
async function measureOffset(ms = 1500) {
  const samples = [];
  const onSample = () => samples.push({ ...sticks });
  stickListeners.add(onSample);
  try {
    await sleep(ms);
  } finally {
    stickListeners.delete(onSample);
  }
  if (samples.length < 40) return null;
  const { stable } = extractStableSamples(samples);
  return analyzeDrift(stable.length > 40 ? stable : samples);
}

/* --------- telemetria locale + upload anonimo (opt-out) --------- */
// localStorage sempre. L'upload è attivo di default: i dati sono anonimi per
// costruzione (mai seriale, ID, IP o fingerprint) e servono ad addestrare
// miglioramenti data-driven dell'algoritmo. '0' esplicito = opt-out persistito.
const CALIB_STORE_KEY      = 'sense-calib-sessions';
const TELEMETRY_CONSENT_KEY = 'sense-telemetry-consent';
const TELEMETRY_NOTICE_KEY = 'sense-telemetry-notice';
const TELEMETRY_ENDPOINT   = 'https://subralabs.com/api/calib/v1/sessions';

const telemetryEnabled = () => localStorage.getItem(TELEMETRY_CONSENT_KEY) !== '0';
const noticeSeen = () => localStorage.getItem(TELEMETRY_NOTICE_KEY) === '1';

// Finché l'avviso di primo avvio non è stato letto, gli eventi restano in coda
// invece di partire: così l'affermazione "nothing has been sent yet" nel banner
// è vera, e scegliere l'opt-out scarta anche quanto raccolto nel frattempo.
let pendingUploads = [];
const PENDING_MAX = 50;

// Identificativo della SOLA sessione corrente: casuale, generato a ogni
// caricamento di pagina, mai scritto su disco. Serve a ricollegare gli eventi
// di una stessa visita (drift → quick → test di precisione), che altrimenti
// arrivano slegati e rendono impossibile ricostruire un prima/dopo. Non è un
// identificativo di dispositivo né di utente: ricaricare la pagina ne produce
// uno nuovo, quindi due sessioni non sono collegabili tra loro.
const SESSION_ID = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).slice(0, 8);

// Ogni azione significativa produce un evento tipizzato: connect, drift,
// quick, wizard, range, flash, game. Stessi vincoli di anonimato per tutti.
function recordEvent(kind, data = {}) {
  recordCalibSession({
    kind,
    t: new Date().toISOString(),
    board: deviceInfo?.board ?? null,
    fw: deviceInfo?.fwversion ?? null,
    ...data,
  });
}

function summarizeResult(r) {
  if (!r) return null;
  const f = v => +v.toFixed(3);
  return {
    off: [f(r.left.offset), f(r.right.offset)],
    noise: [f(r.left.noise), f(r.right.noise)],
    // Direzione del drift per asse. `off` è hypot(x, y), da cui x e y non sono
    // ricostruibili: senza questi, l'asimmetria per asse — la firma dell'usura
    // meccanica di un potenziometro — sarebbe persa per sempre.
    xy: [[f(r.left.x * 100), f(r.left.y * 100)], [f(r.right.x * 100), f(r.right.y * 100)]],
  };
}

function recordCalibSession(entry) {
  entry.sid = SESSION_ID;
  try {
    const arr = JSON.parse(localStorage.getItem(CALIB_STORE_KEY) || '[]');
    arr.push(entry);
    localStorage.setItem(CALIB_STORE_KEY, JSON.stringify(arr.slice(-200)));
  } catch { /* storage pieno o negato: la telemetria non è mai bloccante */ }

  if (!telemetryEnabled()) return;
  if (!noticeSeen()) {
    // Copia, non riferimento: l'oggetto sessione viene ancora mutato dopo la
    // registrazione (il catch vi scrive `aborted`/`err`), e accodare il vivo
    // farebbe partire al flush una versione diversa da quella registrata.
    if (pendingUploads.length < PENDING_MAX) pendingUploads.push({ ...entry });
    return;
  }
  uploadEvent(entry);
}

// Una sessione di calibrazione va registrata una volta sola, sia che finisca
// bene sia che esploda a metà. Prima veniva registrata solo sul percorso felice:
// le calibrazioni fallite — la classe più informativa per capire quando
// l'algoritmo non funziona — non producevano alcun evento.
const recordedSessions = new WeakSet();
function recordSessionOnce(session) {
  if (recordedSessions.has(session)) return;
  recordedSessions.add(session);
  recordCalibSession(session);
}

// Fuoco-e-dimentica, mai bloccante: un endpoint giù non deve mai far fallire
// una calibrazione.
function uploadEvent(entry) {
  fetch(TELEMETRY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
    signal: AbortSignal.timeout(4000),
  })
    .then(() => log('Anonymous telemetry sent.'))
    .catch(() => {});
}

// Calibra con campioni gated sulla stabilità, verifica, e ripete finché
// l'offset scende: si ferma da solo a soglia raggiunta o a convergenza
// (miglioramento sotto epsilon = pavimento del rumore).
async function quickCalibrate() {
  if (!ds5 || busy) return;
  cancelDriftTest();
  busy = true;
  const bar = $('quick-bar');
  const msg = $('quick-msg');
  $('btn-quick-go').disabled = true;
  $('btn-quick-cancel').disabled = true;
  const session = {
    kind: 'quick',
    t: new Date().toISOString(),
    board: deviceInfo?.board ?? null,
    fw: deviceInfo?.fwversion ?? null,
    before: null,
    passes: [],
    after: null,
    unstableEvents: 0,
  };
  try {
    msg.innerHTML = 'Waiting for the sticks to settle…';
    // Attesa iniziale col gate largo del test drift: serve solo a lasciar
    // staccare la mano, non a giudicare il jitter proprio dello stick.
    const settled = await waitForStable({ spread: DRIFT_MOVE_SPREAD, timeoutMs: 3000 });
    const before = await measureOffset(1000);
    session.before = summarizeResult(before);
    session.settled = settled;

    // Gate adattivo: `noise` è il p95 (in %) della deviazione dalla mediana.
    // Il fattore 2.5 è tarato sul max delle escursioni dei quattro assi su una
    // finestra di ~60 campioni (rapporto reale 2.2 medio, 2.56 al p95): non è
    // il "2× per asse singolo" che verrebbe da intuire, e abbassarlo a 2 fa
    // collassare il gate se il controller riporta a 1000 Hz invece di 250.
    //
    // La baseline si deriva dal rumore anche quando l'attesa iniziale va in
    // timeout. Non stabilizzarsi entro DRIFT_MOVE_SPREAD significa "mano sullo
    // stick" oppure "jitter proprio oltre 0.08", cioè proprio il potenziometro
    // consumato per cui il gate adattivo esiste: spegnerlo lì lo negherebbe a
    // chi ne ha più bisogno. Il caso "mano sullo stick" è comunque innocuo,
    // perché il tetto è DRIFT_MOVE_SPREAD, la soglia oltre cui l'app dichiara
    // movimento — il gate non può diventare più permissivo di così.
    let baseGate = QUICK_STABLE_SPREAD;
    if (before) {
      const noise = Math.max(before.left.noise, before.right.noise) / 100;
      baseGate = Math.min(QUICK_STABLE_SPREAD_MAX, Math.max(QUICK_STABLE_SPREAD, noise * 2.5));
      if (baseGate > QUICK_STABLE_SPREAD)
        log(`Noisy signal: stability gate widened to ±${(baseGate * 100).toFixed(1)}%.`);
    }
    if (!settled) log('Sticks never settled before the baseline measurement.');
    let gateSpread = baseGate;
    let gateMax = baseGate;
    let gateOff = false;
    let gateWidenings = 0;

    let worst = null;
    let prevWorst = null;
    let bestWorst = null;
    let result = null;
    for (let pass = 1; pass <= QUICK_MAX_PASSES; pass++) {
      // Il gate si restringe verso la baseline a ogni passata: un disturbo
      // isolato nella passata 1 non deve lasciare tutte le successive con un
      // gate permissivo. Il decadimento (1.25) è deliberatamente più debole
      // dell'allargamento (1.6): fossero uguali, ogni passata ripartirebbe
      // esattamente dal valore che ha già fallito e ri-pagherebbe per intero
      // un timeout da 5 s per campione.
      // `gateOff` invece resta: si attiva solo dopo ripetuti fallimenti a gate
      // massimo, e riaprirlo significherebbe pagare di nuovo quei timeout.
      gateSpread = Math.max(baseGate, gateSpread / 1.25);
      const base = ((pass - 1) / QUICK_MAX_PASSES) * 100;
      msg.innerHTML = `Pass ${pass}: calibrating. <b>Don’t touch the sticks.</b>`;
      bar.style.width = (base + 3) + '%';

      await ds5.calibBegin();
      for (let i = 0; i < QUICK_SAMPLES_PER_PASS; i++) {
        if (!gateOff) {
          const stable = await waitForStable({ spread: gateSpread });
          if (!stable) {
            // Segnale mai fermo entro il gate: campiona comunque (il firmware
            // media), traccia l'evento e allarga il gate una volta invece di
            // pagare il timeout su ogni campione successivo.
            session.unstableEvents += 1;
            if (gateSpread < QUICK_STABLE_SPREAD_MAX) {
              gateSpread = Math.min(QUICK_STABLE_SPREAD_MAX, gateSpread * 1.6);
              gateMax = Math.max(gateMax, gateSpread);
              gateWidenings += 1;
              log(`Gate widened to ±${(gateSpread * 100).toFixed(1)}% (signal moving on its own).`);
            } else {
              gateOff = true;
              log('Signal never stable even at the widest gate: sampling without gating.');
            }
            msg.innerHTML = `Pass ${pass}: unstable signal. <b>Don’t touch the sticks.</b>`;
          }
        } else {
          await sleep(100);
        }
        await ds5.calibSample();
        await sleep(60);
        bar.style.width = (base + 3 + ((i + 1) / QUICK_SAMPLES_PER_PASS) * 16) + '%';
      }
      await sleep(150);
      await ds5.calibEnd();

      msg.innerHTML = `Pass ${pass}: verifying…`;
      result = await measureOffset();
      bar.style.width = (base + 100 / QUICK_MAX_PASSES) + '%';
      if (!result) {
        // La calibrazione di QUESTA passata è già stata applicata da calibEnd,
        // ma non è stata verificata: `worst` conteneva il residuo della passata
        // precedente, ormai sovrascritta. Tenerlo significherebbe mostrare
        // (e mandare in telemetria) un numero riferito a una calibrazione che
        // non è più sul controller.
        worst = null;
        session.passes.push(null);
        session.aborted = 'no-data';
        log(`Pass ${pass}: not enough samples to verify the result.`);
        break;
      }
      worst = Math.max(result.left.offset, result.right.offset);
      session.passes.push(+worst.toFixed(2));
      if (bestWorst === null || worst < bestWorst) bestWorst = worst;
      log(`Pass ${pass}: residual offset ${worst.toFixed(2)}%`);
      if (worst < DRIFT_OK_MAX) break;

      const gain = prevWorst === null ? Infinity : prevWorst - worst;
      prevWorst = worst;
      if (gain < 0) {
        // Regressione, non convergenza. Ogni calibEnd è già stato applicato e
        // il codice non può rileggere la calibrazione dal controller: fermarsi
        // qui congelerebbe il peggioramento. Con budget residuo si riprova.
        log(`Pass ${pass} came out worse than the previous one: trying again instead of stopping.`);
      } else if (gain < QUICK_CONVERGE_EPS && worst <= bestWorst + QUICK_CONVERGE_EPS) {
        // Convergenza vera. La seconda condizione evita di dichiarare "converso"
        // un plateau raggiunto DOPO una regressione: senza, la sequenza
        // 5.0 → 5.4 → 5.35 uscirebbe qui lasciando inutilizzato il budget
        // residuo, cioè esattamente il recupero che si voleva tentare.
        log('Converged: residual offset at the noise floor, further passes won’t help.');
        break;
      }
      if (pass < QUICK_MAX_PASSES)
        msg.innerHTML = `Residual offset ${worst.toFixed(1)}%, running another pass…`;
    }

    session.after = worst === null ? null : summarizeResult(result);
    session.best = bestWorst === null ? null : +bestWorst.toFixed(2);
    // `gate` è il valore finale, che con gateOff o dopo un decadimento non dice
    // quanto si è dovuto allargare: `gateMax` è il dato utile per il tuning.
    session.gate = +gateSpread.toFixed(3);
    session.gateMax = +gateMax.toFixed(3);
    session.gateBase = +baseGate.toFixed(3);
    session.gateWidenings = gateWidenings;
    session.gateOff = gateOff;
    recordSessionOnce(session);

    bar.style.width = '100%';
    await sleep(300);
    closeModal('modal-quick');
    setUnsaved(true);

    // Il controller monta SEMPRE la calibrazione dell'ultima passata: non si può
    // tornare alla migliore. Quando l'ultima è peggiore, l'unica cosa onesta è
    // dirlo, invece di annunciare come risultato un numero che non è il migliore
    // che il tool aveva ottenuto.
    // Ordine: prima gli esiti che descrivono lo stato raggiunto (centrato,
    // limite hardware), poi gli avvisi di peggioramento. Invertirli farebbe
    // dire "ripeti tenendo fermo il controller" a chi è già centrato, o a chi
    // ha un sensore consumato in cui ripetere non può funzionare.
    const beforeWorst = before ? Math.max(before.left.offset, before.right.offset) : null;
    const lostGround = worst !== null && bestWorst !== null && worst - bestWorst > QUICK_REGRESSION_EPS;
    const worseThanStart = worst !== null && beforeWorst !== null && worst - beforeWorst > QUICK_REGRESSION_EPS;
    const worn = result && worst !== null && Math.max(result.left.noise, result.right.noise) > QUICK_NOISE_WORN;

    if (worst === null) {
      toast('Calibration applied, but the result could not be verified: run the drift test to check it.', 6000);
    } else if (worst < DRIFT_OK_MAX) {
      toast('Quick calibration complete.');
    } else if (worn) {
      toast(`Calibration complete, residual offset ${worst.toFixed(1)}%. The signal is noisy (worn sensor): this is likely the hardware limit.`, 6000);
    } else if (worseThanStart) {
      toast(`The last pass ended worse than the starting point (${worst.toFixed(1)}% against ${beforeWorst.toFixed(1)}%). Repeat the calibration keeping the controller still.`, 7000);
    } else if (lostGround) {
      toast(`Calibration complete at ${worst.toFixed(1)}%, but an earlier pass had reached ${bestWorst.toFixed(1)}%. Repeat it to try to get back there.`, 7000);
    } else if (session.unstableEvents > 0) {
      toast(`Calibration complete, residual offset ${worst.toFixed(1)}%. Movement was detected during sampling: repeat on a stable surface.`, 6000);
    } else {
      toast(`Calibration complete, residual offset ${worst.toFixed(1)}%. If it persists, try the guided one.`, 6000);
    }
    log('Quick calibration complete.');
    busy = false;
    startDriftTest();
  } catch (error) {
    busy = false;
    // La riparazione di calibBegin può aver committato: in quel caso la RAM del
    // controller è cambiata anche se la calibrazione non è mai partita.
    if (error.committed) setUnsaved(true);
    session.aborted = 'error';
    session.err = String(error.message || error).slice(0, 120);
    recordSessionOnce(session);
    closeModal('modal-quick');
    toast(`Calibration failed: ${error.message}. If it keeps failing, restart the controller.`, 6000);
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
      // avvio. Misura di partenza: il wizard è il percorso per il drift ostinato,
      // cioè i casi più informativi, e finora non ne usciva alcun numero.
      // Cancel va nascosto e `busy` alzato PRIMA di qualunque await: durante il
      // secondo di misura il modale è ancora a schermo, e un Cancel in quella
      // finestra chiuderebbe il modale lasciando `busy` a true per sempre —
      // bloccando ogni calibrazione successiva fino al reload.
      $('btn-wizard-cancel').classList.add('hidden');
      busy = true;
      btn.textContent = 'Measuring…';
      wizard.before = summarizeResult(await measureOffset(1000));
      await ds5.calibBegin();
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
      const wizAfter = summarizeResult(await measureOffset());
      busy = false;
      wizard.reported = true;
      recordEvent('wizard', { done: true, before: wizard.before ?? null, after: wizAfter });
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
    if (error.committed) setUnsaved(true);
    // Anche il wizard fallito è un dato: registra dove si è rotto. Il flag
    // impedisce un secondo evento se a lanciare è stato il codice DOM che segue
    // l'evento di successo: quella procedura è riuscita, e contarla anche come
    // fallita sporcherebbe il rapporto successi/fallimenti del dataset.
    if (wizard && !wizard.reported) {
      wizard.reported = true;
      recordEvent('wizard', {
        done: false,
        step: wizard.step ?? null,
        before: wizard.before ?? null,
        err: String(error.message || error).slice(0, 120),
      });
    }
    closeModal('modal-wizard');
    toast(`Calibration failed: ${error.message}. If it keeps failing, restart the controller.`, 6000);
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
  $('range-minmax').innerHTML = '<span>LX</span><span>LY</span><span>RX</span><span>RY</span>';
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
  const rangeStats = {
    covL: +dialRangeL.coverage().toFixed(2),
    covR: +dialRangeR.coverage().toFixed(2),
    allEdges: rangeSession.allEdges === true,
    ms: Math.round(performance.now() - rangeSession.startTs),
  };
  rangeSession = null;
  try {
    await ds5.rangeEnd();
    recordEvent('range', { ...rangeStats, incomplete });
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

// L'entrata era animata e l'uscita no: il modale spariva di colpo. L'uscita
// ora è simmetrica ma più corta (l'utente ha già deciso), e `display:none`
// arriva solo a animazione finita.
const MODAL_CLOSE_MS = 160;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const closeTimers = new Map();

function openModal(id) {
  const el = $(id);
  // riapertura durante la chiusura: annulla il timer, o `hidden` arriverebbe dopo
  clearTimeout(closeTimers.get(el));
  closeTimers.delete(el);
  el.classList.remove('closing', 'hidden');
}

function closeModal(id) {
  const el = $(id);
  if (el.classList.contains('hidden') || closeTimers.has(el)) return;
  el.classList.add('closing');
  closeTimers.set(el, setTimeout(() => {
    closeTimers.delete(el);
    el.classList.remove('closing');
    el.classList.add('hidden');
  }, reduceMotion.matches ? 0 : MODAL_CLOSE_MS));
}

// Chiusura secca: si usa nel teardown (controller scollegato), dove la vista
// sottostante cambia sotto i piedi e animare l'uscita mostrerebbe il salto.
function closeAllModals() {
  game?.close(); // ferma il loop rAF del gioco, non solo la classe .hidden
  for (const m of document.querySelectorAll('.modal')) {
    clearTimeout(closeTimers.get(m));
    closeTimers.delete(m);
    m.classList.remove('closing');
    m.classList.add('hidden');
  }
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
  onReport: res => recordEvent('game', res),
  showModal: () => openModal('modal-game'),
  hideModal: () => closeModal('modal-game'),
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

/* ============================== consenso telemetria ============================== */

// Due checkbox sincronizzate (dialogo calibrazione rapida + footer):
// stesso stato in localStorage, cambiarne una aggiorna l'altra.
const consentBoxes = ['telemetry-consent', 'telemetry-consent-footer'].map($).filter(Boolean);
function setConsent(on) {
  localStorage.setItem(TELEMETRY_CONSENT_KEY, on ? '1' : '0');
  for (const box of consentBoxes) box.checked = on;
}
for (const box of consentBoxes) {
  box.checked = telemetryEnabled();
  box.addEventListener('change', () => setConsent(box.checked));
}

// Avviso una tantum al primo avvio. Banner persistente, non un toast che
// scompare: è una scelta da fare, e finché non è fatta niente lascia il browser.
function resolveNotice(keepSharing) {
  localStorage.setItem(TELEMETRY_NOTICE_KEY, '1');
  setConsent(keepSharing);
  const queued = pendingUploads;
  pendingUploads = [];
  if (keepSharing) {
    for (const entry of queued) uploadEvent(entry);
  } else {
    toast('Nothing was sent. You can re-enable sharing anytime in the footer.', 5000);
  }
  const el = $('telemetry-notice');
  el.classList.add('closing');
  setTimeout(() => {
    el.classList.remove('closing');
    el.classList.add('hidden');
  }, reduceMotion.matches ? 0 : 180);
}

// Senza WebHID non esiste controller, quindi nessun evento può essere prodotto
// e non c'è niente da divulgare: mostrare l'avviso sarebbe solo attrito per chi
// apre il link dal telefono. Il flag resta non impostato, così la scelta viene
// chiesta davvero la prima volta che la pagina si apre su un browser che può
// usare il tool. L'opt-out nel footer resta comunque visibile e funzionante.
if (navigator.hid && telemetryEnabled() && !noticeSeen()) {
  $('telemetry-notice').classList.remove('hidden');
  $('btn-notice-ok').addEventListener('click', () => resolveNotice(true));
  $('btn-notice-optout').addEventListener('click', () => resolveNotice(false));
}

/* ============================== tastiera ============================== */

// Esc chiude solo ciò che è annullabile senza lasciare il controller in uno
// stato inconsistente: mai durante una calibrazione (`busy`), mai sul range
// (una sessione aperta va chiusa con rangeEnd, non abbandonata).
const ESC_DISMISS = {
  'modal-quick': 'btn-quick-cancel',
  'modal-wizard': 'btn-wizard-cancel',
  'modal-flash': 'btn-flash-cancel',
  'modal-game': 'btn-game-exit',
};

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || busy) return;
  for (const [modalId, btnId] of Object.entries(ESC_DISMISS)) {
    const modal = $(modalId);
    if (modal.classList.contains('hidden')) continue;
    const btn = $(btnId);
    // il cancel del wizard sparisce a procedura avviata: allora Esc non fa nulla
    if (btn && !btn.disabled && !btn.classList.contains('hidden')) btn.click();
    return;
  }
});

/* ============================== boot ============================== */

async function boot() {
  if (!navigator.hid) {
    showUnsupported();
    if (location.protocol === 'file:') {
      showHeroError('<b>Opened from file://.</b> WebHID needs a secure context: serve the folder over HTTP (e.g. <code>python3 -m http.server</code>).');
    }
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
window.__senseSimulate = (lx, ly, rx, ry) => { sticks = { lx, ly, rx, ry }; notifyStickSample(); };
window.__senseExtractStable = extractStableSamples;
window.__senseWaitForStable = waitForStable;
// Storico locale delle calibrazioni (telemetria per futura calibrazione ML).
window.__senseCalibSessions = () => JSON.parse(localStorage.getItem(CALIB_STORE_KEY) || '[]');
window.__senseDials = { dialL, dialR, dialWizL, dialWizR, dialRangeL, dialRangeR };
// Apre il gioco bypassando il gate isAvailable: utile per testare senza controller
// in coppia con __senseSimulate.
window.__senseGameOpen = () => openGame(true);

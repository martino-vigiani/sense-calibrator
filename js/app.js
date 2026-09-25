'use strict';

import { DS5, HID_FILTERS, NV_UNKNOWN_MESSAGE, POISONED_MESSAGE, isOldFirmware, parseBuildDate } from './ds5.js';
import { initGame } from './game.js';
import { initSensitivityFinder } from './sensitivity.js';
import { initPlaytest } from './playtest.js';
import { uploadCalibrationEvent } from './telemetry.js';
import {
  DRIFT_MAX_RETRIES, DRIFT_MIN_STABLE, DRIFT_SETTLE_SAMPLES, DRIFT_TEST_MS, DRIFT_WINDOW,
  analyzeDrift, extractStableSamples, parseSticks, summarizeResult, verdictFor,
} from './calib/measure.js';
import { STICK_LSB, measureOffset as measureOffsetFrom, waitForStable as waitForStableFrom } from './calib/sampling.js';
import { runQuick } from './calib/quick.js';
import { createOpGate } from './calib/ops.js';
import { CENTERED_MAX, LSB_PCT, formatOffset } from './calib/lattice.js';
import {
  driftMessage, flashSummary, guidedOutcomeView, outcomeHtml, outcomeLogLine, powerCycleReminderView, quickOutcomeView,
  quickPreflightRoute, rangeOutcomeView,
  revertAdvice, stickTier, writeLockFor,
} from './ui/outcome.js';
import { HANDS_OFF_LABELS, createHandsOffMeter, renderHandsOff } from './ui/hands-off.js';
import { CONNECT_CHECKLIST, connectErrorCopy } from './ui/connect-help.js';
import {
  WIZARD_DEFAULTS, captureRestReference, checkBefore, cornerProjection, createCornerTracker, gateWizardSample, restTolerance, wizardComparison,
} from './calib/wizard-gate.js';
import { CIRCULARITY_NORMAL, RANGE_DEFAULTS, circularityRms, createRangeTracker, rangeStatus } from './calib/range-coverage.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOCAL_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const EXPERIMENTAL_PREVIEW = LOCAL_PREVIEW_HOSTS.has(location.hostname)
  && new URLSearchParams(location.search).has('preview');

// Sensitivity Finder e Gameplay Lab restano disponibili per sviluppo con
// `?preview=1`, ma non fanno parte del prodotto pubblico finché non sono pronti.
if (EXPERIMENTAL_PREVIEW) {
  for (const element of document.querySelectorAll('[data-experimental]')) {
    element.hidden = false;
  }
}

// Soglie e funzioni di misura del drift: js/calib/measure.js (pure, condivise
// con il simulatore in ops/sim e con i test).

// Calibrazione range: soglie e copertura in js/calib/range-coverage.js.
const RANGE_BINS = RANGE_DEFAULTS.bins;

let ds5 = null;
let sticks = { lx: 0, ly: 0, rx: 0, ry: 0 };
let battery = null;
let deviceInfo = null;
let unsaved = false;
// Una operazione HID alla volta (ex flag `busy`): vedi js/calib/ops.js.
const ops = createOpGate();

/* ============================== log & toast ============================== */

const logEl = $('log');
function log(msg) {
  // Locale del browser: l'interfaccia è in inglese, e 'it-IT' era un residuo.
  const ts = new Date().toLocaleTimeString(undefined, { hour12: false });
  logEl.textContent += `${ts}  ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// `alert: true` per gli errori: il toast visibile resta nella stessa pila, ma
// il testo va anche nella regione role="alert" (#alerts), annunciata subito;
// il toast è allora aria-hidden, così lo screen reader non lo legge due volte.
function toast(msg, ms = 3200, { alert = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if (alert) {
    el.setAttribute('aria-hidden', 'true');
    $('alerts').textContent = msg;
  }
  $('toasts').appendChild(el);
  setTimeout(() => {
    if (alert && $('alerts').textContent === msg) $('alerts').textContent = '';
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, ms);
}

// Le regioni live (role="status") vanno riscritte solo quando il testo cambia:
// riassegnare lo stesso testo produce comunque una mutazione, e uno screen
// reader può rileggerla. Il range lo farebbe ogni 120 ms e la quick a ogni
// evento di progresso. Il confronto è con il DOM, non con una cache: se altro
// codice scrive l'elemento, il valore di riferimento resta quello vero. Per
// l'HTML si serializza il nuovo valore con lo stesso parser del browser, così
// entità e spazi non producono falsi "cambiato".
function setLive(el, value, { html = false } = {}) {
  if (!el) return;
  if (!html) {
    if (el.textContent !== value) el.textContent = value;
    return;
  }
  const probe = document.createElement('template');
  probe.innerHTML = value;
  const normalized = probe.innerHTML ?? value;
  if (el.innerHTML !== normalized) el.innerHTML = value;
}

/* ============================== dial canvas ============================== */

const INK = '#0a0a0a';
const GRID = '#e4e4e0';
// Anello di riferimento e punti del reticolo: 3.25:1 su bianco (WCAG 1.4.11),
// lo stesso valore di --edge in style.css. Il vecchio #c9c9c5 era 1.66:1, ed è
// proprio l'anello con cui l'utente confronta il punto.
const MID = '#8f8f8a';
// Zoom ×10 sul centro: a scala piena 1 LSB (0.784%) è meno di un pixel, e il
// passo tra "centrato" (0.555%) e "1 passo" (1.240%) non si vede. A ×10 il
// bordo del quadrante vale il 10% e il reticolo del byte diventa visibile.
const DIAL_ZOOM = 10;
const LSB = LSB_PCT / 100; // un passo del byte, in unità normalizzate

class StickDial {
  constructor(canvas, { traceMode = false, dotRadius = 5 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.traceMode = traceMode;
    this.dotRadius = dotRadius;
    this.target = null; // {x, y} normalizzato: anello bersaglio per il wizard
    this.trail = [];
    // In traceMode i massimi per settore arrivano dal tracker del range
    // (range-coverage.js), alimentato dagli input report: il quadrante li
    // disegna soltanto.
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
    if (!this.traceMode) {
      this.trail.push({ x, y });
      if (this.trail.length > 36) this.trail.shift();
    }
  }

  draw() {
    const { ctx, size } = this;
    const c = size / 2;
    const R = size / 2 - 14;
    ctx.clearRect(0, 0, size, size);
    if (this.zoom > 1) { this.drawZoomed(c, R); return; }

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

  // Vista ×10 (solo quadranti principali): bordo = 10% di offset, anello
  // tratteggiato = CENTERED_MAX (il confine del verdetto "Centered"), punti =
  // i valori che il byte può davvero assumere vicino al centro. Il punto a
  // riposo cade su uno dei quattro punti interni (0.555%) o su un gradino
  // fuori dall'anello (1.240%): è la quantizzazione che il numero nasconde.
  drawZoomed(c, R) {
    const { ctx } = this;
    const k = DIAL_ZOOM * R; // px per unità normalizzata
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c, R / 2, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
    ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
    ctx.stroke();

    ctx.fillStyle = MID;
    for (let i = -4; i < 4; i++) {
      for (let j = -4; j < 4; j++) {
        ctx.beginPath();
        ctx.arc(c + (i + 0.5) * LSB * k, c + (j + 0.5) * LSB * k, 1.3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    ctx.strokeStyle = MID;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(c, c, (CENTERED_MAX / 100) * k, 0, 2 * Math.PI); ctx.stroke();
    ctx.setLineDash([]);

    // Fuori scala il punto resta sul bordo, nella sua direzione: si vede da
    // che parte è, non dove. La scia è ritagliata al cerchio.
    const clampToRim = (x, y) => {
      const r = Math.hypot(x, y) * DIAL_ZOOM;
      const f = r > 1 ? 1 / r : 1;
      return [c + x * k * f, c + y * k * f];
    };
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.clip();
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      ctx.strokeStyle = `rgba(10,10,10,${(i / this.trail.length) * 0.35})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(c + a.x * k, c + a.y * k);
      ctx.lineTo(c + b.x * k, c + b.y * k);
      ctx.stroke();
    }
    ctx.restore();

    const [px, py] = clampToRim(this.x, this.y);
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(px, py, this.dotRadius, 0, 2 * Math.PI);
    ctx.fill();

    ctx.fillStyle = INK;
    ctx.font = '600 10px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('×10 · edge 10%', c + R, 10);
    ctx.textAlign = 'start';
  }
}

const dialL = new StickDial($('dial-l'));
const dialR = new StickDial($('dial-r'));
const dialRangeL = new StickDial($('dial-range-l'), { traceMode: true });
const dialRangeR = new StickDial($('dial-range-r'), { traceMode: true });
const dialWizL = new StickDial($('dial-wiz-l'), { dotRadius: 4 });
const dialWizR = new StickDial($('dial-wiz-r'), { dotRadius: 4 });
const allDials = [dialL, dialR, dialRangeL, dialRangeR, dialWizL, dialWizR];

// Zoom ×10, per quadrante: è solo disegno, non tocca misure né verdetti.
for (const [side, dial, name] of [['l', dialL, 'Left'], ['r', dialR, 'Right']]) {
  const btn = $(`btn-zoom-${side}`);
  const canvas = $(`dial-${side}`);
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    dial.zoom = on ? DIAL_ZOOM : 1;
    btn.setAttribute('aria-pressed', String(on));
    canvas.setAttribute('aria-label', on
      ? `${name} stick position, center zoomed ×10: edge 10%, dashed ring ${CENTERED_MAX}%`
      : `${name} stick position`);
  });
}

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
    // Solo disegno: i settori del range sono alimentati da onInputReport.
    if (rangeSession || rangeCheck) {
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

// Selettore vuoto o apertura fallita: la lista di controlli al posto del
// silenzio (prima `devices.length === 0` usciva senza dire nulla).
function showConnectHelp() {
  $('connect-help-list').innerHTML = CONNECT_CHECKLIST.map(item => `<li>${esc(item)}</li>`).join('');
  $('connect-help').classList.remove('hidden');
}

function showConnectError(error) {
  const copy = connectErrorCopy(error);
  showHeroError(`<b>${esc(copy.title)}</b> ${esc(copy.detail)}`);
  showConnectHelp();
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

const NV_CHIP_TITLE = 'State of the controller\'s non-volatile memory';
const NV_LOCKED_MESSAGE = 'The controller’s memory is locked, as it normally is: calibrations stay temporary until you write them to memory.';
const NV_UNLOCKED_MESSAGE = 'Memory unlocked: changes may be permanent. Restart the controller.';
const NV_UNKNOWN_STATE_MESSAGE = 'The controller did not report its memory state. Calibration is allowed, but changes may not be temporary.';
const NV_PENDING_MESSAGE = 'The controller has a save pending: restart it (Restart button) before calibrating.';

// Stato della memoria letto alla connessione (e dopo ogni flash). Solo lettura:
// alla connessione non si scrive nulla, nemmeno il lock automatico di upstream
// (rimandato finché la verifica hardware H3 non lo giustifica).
let nvStatus = null;
// Ultimo stato mostrato nel chip (incluso 'poisoned'): lo usa il testo dell'esito
// rapido, che consiglia lo spegnimento solo se è 'locked'.
let lastNvStatus = null;

function setNvChip(nv) {
  lastNvStatus = nv?.status ?? null;
  const el = $('chip-nvs');
  el.classList.remove('hidden', 'chip-warn', 'chip-on');
  el.title = NV_CHIP_TITLE;
  if (!nv) { el.classList.add('hidden'); return; }
  if (nv.status === 'locked') {
    // "Locked" è lo stato normale: il nome vecchio ("NVS protected") non diceva
    // a chi gioca se fosse un bene o un problema.
    el.textContent = 'Memory locked (normal)';
    el.title = NV_LOCKED_MESSAGE;
    el.classList.add('chip-on');
  }
  else if (nv.status === 'unlocked') {
    el.textContent = 'Memory unlocked';
    el.title = NV_UNLOCKED_MESSAGE;
    el.classList.add('chip-warn');
  } else if (nv.status === 'pending_reboot') {
    el.textContent = 'Restart required';
    el.title = NV_PENDING_MESSAGE;
    el.classList.add('chip-warn');
  } else if (nv.status === 'poisoned') {
    el.textContent = 'Not responding';
    el.title = POISONED_MESSAGE;
    el.classList.add('chip-warn');
  } else {
    el.textContent = 'Memory state unknown';
    el.title = NV_UNKNOWN_STATE_MESSAGE;
    el.classList.add('chip-warn');
  }
}

// Firmware 2020–2021: avviso con conferma, una volta per connessione. Upstream
// li blocca; i nostri dati non mostrano fallimenti, quindi non si blocca (C2-10).
let oldFirmwareAck = false;

// Gate comune prima di aprire Quick, Guided o Range. Blocca SOLO su stati
// confermati: memoria sbloccata (ogni calibrazione "temporanea" potrebbe finire
// dritta in NVS) o controller avvelenato da un timeout. `unknown`/`error`
// mostrano l'avviso nel chip ma lasciano calibrare (C2-19).
function calibrationAllowed() {
  if (!ds5 || ops.busy) return false;
  if (ds5.poisoned) { toast(POISONED_MESSAGE, 7000); return false; }
  if (nvStatus === 'unlocked') { toast(NV_UNLOCKED_MESSAGE, 7000); return false; }
  if (!oldFirmwareAck && isOldFirmware(deviceInfo?.buildDate)) {
    const year = parseBuildDate(deviceInfo.buildDate).year;
    const go = confirm(`This controller runs firmware built in ${year}. Calibration has not been verified on firmware this old; `
      + 'updating it from a PS5 first is safer. Continue anyway?');
    if (!go) return false;
    oldFirmwareAck = true;
  }
  return true;
}

function setBatteryChip() {
  const el = $('chip-battery');
  if (!battery) { el.classList.add('hidden'); updateBatteryHints(); return; }
  el.classList.remove('hidden');
  el.textContent = battery.charging ? `Charging · ${battery.level}%` : `Battery ${battery.level}%`;
  updateBatteryHints();
}

// Batteria bassa e non in carica: un controller che si spegne a metà
// calibrazione la interrompe. Solo un avviso: non blocca nulla.
const LOW_BATTERY_PCT = 20;
function updateBatteryHints() {
  const low = !!battery && !battery.charging && battery.level <= LOW_BATTERY_PCT;
  const text = low
    ? `Battery at ${battery.level}% and not charging. If the controller shuts down mid-calibration, the calibration is interrupted: charge it first, or use a USB port that charges it.`
    : '';
  for (const id of ['quick-battery', 'wizard-battery']) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle('hidden', !low);
  }
}

async function refreshNv() {
  const controller = ds5;
  if (!controller) return;
  const nv = await controller.queryNvStatus();
  // Il controller può essere cambiato durante l'attesa: il chip è del nuovo.
  if (ds5 !== controller) return nv;
  nvStatus = nv.status;
  setNvChip(controller.poisoned ? { status: 'poisoned' } : nv);
  return nv;
}

// Il DS5 ha smesso di rispondere (timeout): nessun altro comando su questa
// connessione. Se il comando appeso era un commit la RAM (o la NVS) può essere
// cambiata, quindi lo stato "non salvato" si alza per prudenza.
let flashing = false;
function onControllerPoisoned(controller, error) {
  if (ds5 !== controller) return;
  if (error.committed) setUnsaved(true);
  setNvChip({ status: 'poisoned' });
  updateWriteLock();
  log(`Controller not responding: ${error.message}.`);
  // Durante il flash il messaggio giusto è quello sullo stato della memoria,
  // mostrato da doFlash.
  if (!flashing) toast(POISONED_MESSAGE, 8000, { alert: true });
}

const CONNECT_LABEL = 'Connect DualSense';
function setConnecting(on) {
  const btn = $('btn-connect');
  if (!btn || !navigator.hid) return;
  btn.disabled = on;
  btn.textContent = on ? 'Connecting…' : CONNECT_LABEL;
}

const isDualSense = device => device?.vendorId === 0x054c && device?.productId === 0x0ce6;
const isUsbDevice = device => !new DS5(device).isBluetooth();

async function connect() {
  if (!navigator.hid) {
    showHeroError('<b>WebHID not available.</b> Use Chrome or Edge: Safari and Firefox don’t support access to HID devices.');
    return;
  }
  if (adopting) return;
  try {
    const devices = await navigator.hid.requestDevice({ filters: HID_FILTERS });
    // Selettore vuoto o chiuso senza scegliere: il browser non dice quale dei
    // due, quindi la lista vale per entrambi.
    if (devices.length === 0) { showConnectHelp(); return; }
    await adopt(devices.find(isUsbDevice) ?? devices[0]);
  } catch (error) {
    showConnectError(error);
    log(`Connection error: ${error.name ? `${error.name}: ` : ''}${error.message || error}`);
  }
}

// Un solo adopt alla volta: auto-connessione al boot, evento `connect` e click
// su Connect arrivavano tutti qui, e due adopt paralleli producevano due eventi
// connect e due catene di test drift. `aborted` lo alza la disconnessione del
// dispositivo in corso di adozione, anche prima che diventi `ds5`.
let adopting = null; // { device, aborted }
let autoDriftTimer = null;

async function adopt(device) {
  if (adopting || (ds5 && ds5.device === device)) return;
  const attempt = { device, aborted: false };
  adopting = attempt;
  setConnecting(true);
  try {
    if (!device.opened) await device.open();
    if (attempt.aborted) return;
    const candidate = new DS5(device, log, {
      timers: pageClock,
      onPoison: error => onControllerPoisoned(candidate, error),
    });

    if (candidate.isBluetooth()) {
      await candidate.close();
      showHeroError('<b>Controller on Bluetooth.</b> Calibration requires a <b>USB cable</b> connection: plug it in and try again.');
      return;
    }

    ds5 = candidate;
    oldFirmwareAck = false;
    log(`Connected: ${device.productName}`);
    setConnChip(true);

    device.oninputreport = onInputReport;

    // Info dispositivo e stato NVS: solo letture. Dopo ogni await il
    // controller può essere stato scollegato (teardown ha già mostrato la
    // hero): allora questo adopt non tocca più nulla.
    const info = await candidate.getInfo();
    if (ds5 !== candidate) return;
    deviceInfo = info;
    renderDeviceInfo(info);
    const key = await localDeviceKey(info.serial);
    if (ds5 !== candidate) return;
    deviceKey = key;
    const nv = await refreshNv();
    if (ds5 !== candidate) return;
    reapplyRangeWriteLock(key);
    reapplyPowerCycle();

    $('view-hero').classList.add('hidden');
    $('view-device').classList.remove('hidden');
    $('hero-error').classList.add('hidden');
    $('connect-help').classList.add('hidden');

    recordEvent('connect', {
      color: info.color ?? null,
      build: info.buildDate ?? null,
    });

    if (nv?.status === 'unlocked') {
      log(NV_UNLOCKED_MESSAGE);
      toast(NV_UNLOCKED_MESSAGE, 8000);
    } else if (nv?.status === 'pending_reboot') {
      toast(NV_PENDING_MESSAGE, 6000);
    } else if (nv?.status !== 'locked') {
      log(`NVS status: ${nv?.status ?? 'n/a'}. ${NV_UNKNOWN_STATE_MESSAGE}`);
    }
    if (isOldFirmware(info.buildDate)) log(`Old firmware (${info.buildDate}): calibration will ask for confirmation.`);

    // test drift automatico dopo un breve assestamento; il timer è di questa
    // connessione e teardown lo cancella.
    autoDriftTimer = setTimeout(() => {
      autoDriftTimer = null;
      if (ds5 === candidate) startDriftTest(true);
    }, 900);
  } finally {
    if (adopting === attempt) adopting = null;
    setConnecting(false);
  }
}

// Il seriale identifica il controller: nascosto di default, perché chi
// condivide uno screenshot del risultato non lo pubblichi senza volerlo.
let serialShown = false;
const maskSerial = serial => (serial.length > 4 ? `Serial •••• ${serial.slice(-4)}` : 'Serial ••••');
function renderSerial() {
  const serial = deviceInfo?.serial;
  $('device-sub').textContent = serial ? (serialShown ? serial : maskSerial(serial)) : 'serial number not available';
  const btn = $('btn-serial');
  btn.classList.toggle('hidden', !serial);
  btn.textContent = serialShown ? 'Hide serial' : 'Show serial';
  btn.setAttribute('aria-pressed', String(serialShown));
}

function renderDeviceInfo(info) {
  serialShown = false;
  renderSerial();
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
  const hadUnsaved = unsaved;
  const nvAtExit = lastNvStatus;
  ds5 = null;
  battery = null;
  deviceInfo = null;
  nvStatus = null;
  oldFirmwareAck = false;
  rangeSession = null;
  rangeCheck = null;
  rangeIntro = null;
  // Il blocco della scrittura NON decade allo scollegamento: vedi
  // rangeWriteLocks. Resta la chiave del controller che l'ha prodotto.
  deviceKey = null;
  if (adopting) adopting.aborted = true;
  clearTimeout(autoDriftTimer);
  autoDriftTimer = null;
  stopDriftLoop();
  driftTest = null;
  // Stato per dispositivo: niente deve sopravvivere al controller che l'ha
  // prodotto (i quadranti disegnavano l'ultima posizione, il verdetto drift
  // del vecchio controller veniva confrontato col nuovo).
  sticks = { lx: 0, ly: 0, rx: 0, ry: 0 };
  wizard = null;
  quickPreflightBlocked = false;
  lastDriftResult = null;
  lastBattery = 0;
  modalReturnFocus.clear();
  ops.reset();
  // L'esito e il blocco di Write sono del controller che se ne va.
  centerState = null;
  rangeState = null;
  lastCenterView = null;
  clearOutcome();
  setConnChip(false);
  setNvChip(null);
  setBatteryChip();
  setUnsaved(false);
  closeAllModals();
  $('view-device').classList.add('hidden');
  $('view-hero').classList.remove('hidden');
  if (message) toast(message);
  // La calibrazione in RAM non è stata scritta. Cosa faccia lo scollegamento
  // (H11) non è verificato: il testo non promette né che sia persa né che resti.
  if (hadUnsaved) toast(unsavedOnExitMessage(nvAtExit), 10000);
  syncBusyTitle();
}

function unsavedOnExitMessage(nv) {
  const off = revertAdvice(nv);
  return 'The calibration was never written to memory. '
    + (off ?? 'We haven’t confirmed whether disconnecting discards it: run the drift test when you reconnect.');
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

// Sorgente e orologio per js/calib: gli stessi input report e timer di sempre,
// passati come dipendenze così che il simulatore possa sostituirli.
const stickSource = {
  subscribe(fn) {
    stickListeners.add(fn);
    return () => { stickListeners.delete(fn); };
  },
  get sticks() { return sticks; },
  now: () => performance.now(),
};
// Arrow function, non i riferimenti nudi: `window.setTimeout` chiamato come
// metodo di un altro oggetto lancia "Illegal invocation".
const pageClock = {
  sleep,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};
const waitForStable = options => waitForStableFrom(stickSource, pageClock, options);
const measureOffset = (ms, options) => measureOffsetFrom(stickSource, pageClock, ms, options);

function onInputReport(event) {
  const parsed = parseSticks(event.reportId, event.data);
  if (!parsed) return;
  const d = event.data;
  sticks = parsed;
  notifyStickSample();
  playtest?.feedSample(sticks, performance.now());

  if (driftTest) driftSample();

  // Copertura del range e verifica dagli input report (~250 Hz), mai da rAF:
  // a 60 Hz una rotazione veloce saltava metà dei settori, e in una tab in
  // background rAF si ferma del tutto.
  if (rangeSession) rangeSession.tracker.push(sticks);
  if (rangeCheck) rangeCheck.tracker.push(sticks);
  // Raggiungimento dell'angolo del wizard, anch'esso dagli input report.
  if (wizard?.tracker) wizard.tracker.push(sticks);

  const now = performance.now();
  feedHandsOff(now);
  if (now - lastBattery > 2000 && ds5) {
    lastBattery = now;
    battery = ds5.parseBattery(d);
    setBatteryChip();
  }
}

/* ============================== mani lontane ============================== */

// Misuratore nei modali Quick e Guided (js/ui/hands-off.js), alimentato dagli
// input report come ogni altra misura: niente timer, niente rAF.
// Il misuratore vede solo il movimento: un pollice fermo è "Not moving". Quando
// la pagina SA già di una tenuta il livello diventa `held` ("Stick held: let
// go"), così il misuratore non contraddice il messaggio del modale.
const handsOff = createHandsOffMeter();
// Rapida: vero dalle fasi held/stalled/unstable (e dal preflight fallito) fino
// al prossimo segno che gli stick sono stati lasciati (pass, resumed, verify,
// next, un campione preso).
let quickHoldKnown = false;
function handsOffTarget() {
  if (!$('modal-quick').classList.contains('hidden')) return ['quick-handsoff', HANDS_OFF_LABELS.quick, () => quickHoldKnown];
  if (!$('modal-wizard').classList.contains('hidden')) return ['wizard-handsoff', HANDS_OFF_LABELS.guided, () => wizardHoldKnown(wizard)];
  return null;
}
// Wizard: (1) nella fase degli angoli uno stick è ancora sull'angolo (stessa
// proiezione e stessa soglia del tracker, `cornerDot`); (2) dopo un timeout
// del gate, uno stick è fuori dalla tolleranza del riferimento in sessione
// (o, senza riferimento, oltre il raggio di plausibilità). Nessuna soglia nuova.
function wizardHoldKnown(w) {
  if (!w) return false;
  if (w.phase === 'corner') {
    const p = cornerProjection(sticks, WIZARD_CORNERS[w.corner]);
    if (Math.max(p.left, p.right) >= WIZARD_DEFAULTS.cornerDot) return true;
  }
  if (!w.gateTimedOut) return false;
  if (!w.ref) return Math.hypot(sticks.lx, sticks.ly) > WIZARD_DEFAULTS.refRadius || Math.hypot(sticks.rx, sticks.ry) > WIZARD_DEFAULTS.refRadius;
  const tol = w.escaped ? Math.max(WIZARD_DEFAULTS.escapeLsb * STICK_LSB, w.tol ?? 0) : w.tol;
  return ['lx', 'ly', 'rx', 'ry'].some(a => Math.abs(sticks[a] - w.ref[a]) > tol);
}
function feedHandsOff(now) {
  const target = handsOffTarget();
  if (!target) return;
  const level = handsOff.push(sticks, now);
  renderHandsOff($(target[0]), target[2]() ? 'held' : level, target[1]);
}
function resetHandsOff() {
  quickHoldKnown = false;
  handsOff.reset();
  renderHandsOff($('quick-handsoff'), 'unknown', HANDS_OFF_LABELS.quick);
  renderHandsOff($('wizard-handsoff'), 'unknown', HANDS_OFF_LABELS.guided);
  updateBatteryHints();
}

/* ============================== test drift ============================== */

let driftTest = null;

// Il completamento del test è guidato dagli input report HID (driftSample),
// non da rAF: Chrome sospende rAF nelle tab nascoste mentre i report continuano
// ad arrivare, e il "test da 3 s" finiva per analizzare minuti di campioni.
// rAF resta solo per la barra e per il caso "nessun report" (controller muto).
const DRIFT_EXPECTED_SAMPLES = Math.round(DRIFT_TEST_MS / 4); // ~250 Hz
const DRIFT_SAMPLE_CAP = 3 * DRIFT_EXPECTED_SAMPLES;
const DRIFT_NO_DATA_GRACE_MS = 1000;
let driftRaf = 0;

function stopDriftLoop() {
  if (driftRaf) cancelAnimationFrame(driftRaf);
  driftRaf = 0;
}

function cancelDriftTest() {
  if (!driftTest) return;
  stopDriftLoop();
  driftTest = null;
  $('drift-card').dataset.state = 'idle';
  $('drift-progress').classList.add('hidden');
  $('drift-status').textContent = 'Waiting…';
}

function startDriftTest(auto = false) {
  if (!ds5 || ops.busy) return;
  // Un test già in corso (doppio "Run again", timer automatico) si annulla:
  // due catene rAF sullo stesso `driftTest` sono il difetto di prima.
  cancelDriftTest();
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
  driftRaf = requestAnimationFrame(driftTick);
}

function driftSample() {
  const test = driftTest;
  test.samples.push({ ...sticks });
  // Tetto a 3× il previsto: con un controller più veloce del previsto il test
  // si chiude prima, ma memoria e calcolo restano limitati in ogni caso.
  if (performance.now() >= test.deadline || test.samples.length >= DRIFT_SAMPLE_CAP) evaluateDriftTest();
}

// Solo barra di avanzamento e guardia "nessun dato": la fine del test arriva
// dal primo report dopo la scadenza.
function driftTick() {
  driftRaf = 0;
  if (!driftTest) return;
  const now = performance.now();
  const remaining = Math.max(0, driftTest.deadline - now);
  const pct = 100 - (remaining / DRIFT_TEST_MS) * 100;
  $('drift-progress').querySelector('i').style.width = pct + '%';
  if (now >= driftTest.deadline + DRIFT_NO_DATA_GRACE_MS) {
    // nessun input report oltre la scadenza: il controller è muto
    evaluateDriftTest();
    return;
  }
  driftRaf = requestAnimationFrame(driftTick);
}

function evaluateDriftTest() {
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

  // Finestra di DRIFT_WINDOW campioni esatti (prima erano 31).
  const { stable, fraction } = extractStableSamples(usable, DRIFT_WINDOW);

  if (fraction < DRIFT_MIN_STABLE) {
    if (driftTest.retries < DRIFT_MAX_RETRIES) {
      driftTest.retries += 1;
      driftTest.samples = [];
      driftTest.deadline = performance.now() + DRIFT_TEST_MS;
      $('drift-status').textContent = 'Movement detected. Retrying: don’t touch the sticks…';
      if (!driftRaf) driftRaf = requestAnimationFrame(driftTick);
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

let lastDriftResult = null;

// Segno esplicito e meno tipografico (−, non -): +0.0% e −0.0% restano
// distinguibili, e lo screen reader legge "meno".
const signedPct = v => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}%`;

function finishDriftTest(result) {
  const auto = driftTest?.auto === true;
  stopDriftLoop();
  driftTest = null;
  const card = $('drift-card');
  card.dataset.state = 'idle';
  $('drift-progress').classList.add('hidden');
  if (!result) return;

  const prev = lastDriftResult;
  lastDriftResult = result;

  for (const [side, el] of [['left', 'verdict-l'], ['right', 'verdict-r']]) {
    const r = result[side];
    // `unstable` è del risultato intero: passato allo stick, il badge diventa
    // "Moving" invece di una percentuale calcolata su campioni in movimento.
    const v = verdictFor({ ...r, unstable: result.unstable === true });
    const badge = $(el);
    badge.className = `verdict ${v.cls}`;
    badge.textContent = v.label;
    // Dettaglio come testo visibile, non `title`: tastiera e touch non
    // raggiungono un tooltip. Il CSS lo nasconde insieme al badge.
    $(`${el}-detail`).textContent = `x ${signedPct(r.x * 100)} · y ${signedPct(r.y * 100)} · noise ${r.noise.toFixed(1)}%`;
    badge.classList.remove('hidden');
  }

  const worst = Math.max(result.left.offset, result.right.offset);
  recordEvent('drift', {
    auto,
    res: summarizeResult(result),
    worst: +worst.toFixed(2),
    unstable: result.unstable === true,
  });
  // Testo e instradamento dal livello peggiore (js/ui/outcome.js): ≥15% →
  // Guided, Pinned → Range poi Guided, rumore → "il rumore resta".
  $('drift-status').textContent = driftMessage(result, { previous: prev, unsaved, writeLock: currentWriteLock().mode }).text;
}

/* ============================== unsaved / flash ============================== */

function setUnsaved(v) {
  unsaved = v;
  $('banner-unsaved').classList.toggle('hidden', !v);
  // Il segno per la scheda si alza con la RAM cambiata e si abbassa solo con
  // un salvataggio riuscito: uno scollegamento non prova che sia stata persa.
  if (v) markTabUnsaved(true);
  updateWriteLock();
}

/* --------- esito persistente e blocco di Write (js/ui/outcome.js) --------- */

// Cosa monta ora la RAM del controller, per il blocco di Write: l'ultimo esito
// del centro (Quick o Guided) e l'ultimo del range. Sono indipendenti: un
// Quick riuscito non ripara un range incompleto, e viceversa.
let centerState = null;
let rangeState = null;
// Blocchi del range (WS7, vedi setRangeWriteLock): chiave del controller →
// { reason, exempt }. Più di uno: il blocco di A resta sospeso mentre è
// collegato B, e un blocco di B non sostituisce quello di A.
const rangeWriteLocks = new Map();
let lastCenterView = null;

function currentWriteLock() {
  // Il blocco del range (WS7) sopravvive allo scollegamento e segue il
  // controller; `rangeState` invece è l'esito mostrato e decade col teardown.
  // Si sommano: basta uno dei due per tenere Write spento.
  const rangeWriteLock = rangeLockFor(deviceKey);
  const range = rangeWriteLock
    ? {
      incomplete: !!rangeState?.incomplete || rangeWriteLock === 'incomplete',
      alreadyClosed: !!rangeState?.alreadyClosed || rangeWriteLock !== 'incomplete',
    }
    : rangeState;
  return writeLockFor({
    center: centerState,
    range,
    poisoned: !!ds5?.poisoned,
    needsPowerCycle: powerCycleApplies(),
  });
}

function updateWriteLock() {
  const lock = currentWriteLock();
  $('btn-flash').disabled = lock.mode === 'disabled';
  const note = $('banner-lock');
  const shown = lock.reasons.filter(r => r.mode === lock.mode);
  if (lock.mode === 'allowed' || !shown.length) {
    note.textContent = '';
    note.classList.add('hidden');
  } else {
    note.textContent = (lock.mode === 'disabled' ? 'Write is off: ' : 'Check before saving: ') + shown.map(r => r.text).join(' ');
    note.classList.remove('hidden');
  }
  return lock;
}

// Pannello #calib-outcome: sostituisce i toast di 6-7 s, che il 26% degli esiti
// affidava a un messaggio che spariva. Resta fino alla calibrazione successiva.
// Uguale a scroll-margin-top di .outcome-card (la topbar fissa).
const OUTCOME_TOP_MARGIN = 80;
function showOutcome(view) {
  if (view.center) { centerState = view.center; lastCenterView = view; }
  if (view.range) rangeState = view.range;
  const el = $('calib-outcome');
  el.dataset.tone = view.tone;
  el.innerHTML = outcomeHtml(view);
  el.classList.remove('hidden');
  el.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  // Un pannello più alto dello spazio libero (su telefono, con l'avviso
  // telemetria aperto) veniva allineato dall'alto e lasciava le azioni, cioè
  // le uscite (Guided, recovery), sotto l'avviso. Allora si porta in vista la
  // riga delle azioni: il titolo resta a uno scroll di distanza.
  const actions = el.querySelector?.('.outcome-actions');
  if (actions && typeof getComputedStyle === 'function') {
    const reserved = parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0;
    const room = window.innerHeight - OUTCOME_TOP_MARGIN - reserved;
    if (el.getBoundingClientRect().height > room)
      actions.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
  updateWriteLock();
}

function clearOutcome() {
  const el = $('calib-outcome');
  el.innerHTML = '';
  el.classList.add('hidden');
}

function runOutcomeAction(action) {
  if (action === 'guided') $('btn-wizard').click();
  else if (action === 'range') $('btn-range').click();
  else if (action === 'quick') $('btn-quick').click();
  else if (action === 'retest') startDriftTest();
  else if (action === 'recovery') openQuickRecovery();
  else if (action === 'restart') rebootController();
  else if (action === 'powered-off') confirmPoweredOff();
}

// Modale di Write: le cifre dell'ultimo esito e, se l'esito è peggiore
// dell'inizio o perso, avviso, Cancel col fuoco e una seconda conferma.
function openFlashModal() {
  $('btn-flash-go').disabled = false; // disattivato da doFlash al click precedente
  const lock = updateWriteLock();
  if (lock.mode === 'disabled') { toast(lock.reasons[0].text, 7000); return; }
  const summary = flashSummary(lastCenterView, lock);
  const numbers = $('flash-numbers');
  numbers.innerHTML = summary.numbers.map(line => `<li>${esc(line)}</li>`).join('');
  numbers.classList.toggle('hidden', summary.numbers.length === 0);
  const ack = $('flash-ack');
  ack.checked = false;
  $('flash-warning').classList.toggle('hidden', !summary.guarded);
  $('flash-warning-text').textContent = summary.guarded ? `${summary.warnings.join(' ')} Saving makes it permanent.` : '';
  $('btn-flash-go').disabled = summary.guarded;
  $('btn-flash-go').textContent = summary.guarded ? 'Write anyway' : 'Write permanently';
  // Il fuoco va su Cancel quando il risultato è a rischio (meccanismo di WS6).
  $('btn-flash-cancel').toggleAttribute('data-autofocus', summary.guarded);
  openModal('modal-flash');
}

// Segno "calibrazione non salvata in questa scheda" in sessionStorage. Non è
// legato a un controller (non se ne conserva nessun identificativo): dopo un
// ricaricamento dice solo che una calibrazione PUÒ essere ancora attiva.
const TAB_UNSAVED_KEY = 'sense-unsaved-in-tab';
function tabStore() {
  try { return window.sessionStorage ?? null; } catch { return null; }
}
function markTabUnsaved(on) {
  const store = tabStore();
  try {
    if (on) store?.setItem(TAB_UNSAVED_KEY, '1');
    else store?.removeItem(TAB_UNSAVED_KEY);
  } catch { /* storage negato: il banner è solo un promemoria */ }
}
function tabUnsavedFlag() {
  try { return tabStore()?.getItem(TAB_UNSAVED_KEY) === '1'; } catch { return false; }
}

/* --------- scheda in background durante una calibrazione --------- */

const BASE_TITLE = document.title;
let awayDuringOp = false;
function syncBusyTitle() {
  if (document.hidden) {
    if (ops.busy) {
      awayDuringOp = true;
      document.title = rangeSession ? 'Range calibration running…' : 'Calibrating… don’t touch';
    } else if (awayDuringOp) {
      document.title = 'Calibration finished · Sense Calibrator';
    }
    return;
  }
  if (!awayDuringOp) return;
  awayDuringOp = false;
  document.title = BASE_TITLE;
  toast(ops.busy
    ? 'Still calibrating: keep your hands off the sticks.'
    : 'The calibration finished while you were away: the result is on the page.', 6000);
}

async function doFlash() {
  // Guardia e disattivazione sincrone, prima di qualunque await: un doppio
  // click arriva mentre il primo flash è ancora in volo e, senza questo,
  // lancerebbe un secondo ciclo unlock → lock sulla NVS. Il bottone torna
  // attivo solo alla prossima apertura del modale, non nel finally: durante
  // l'animazione di chiusura sarebbe di nuovo cliccabile.
  if (!ds5 || ops.busy || blockedForPowerCycle() || blockedByRangeWriteLock()) return;
  // Blocco di Write (WS5), anche qui e non solo sul bottone: un risultato
  // catastrofico, un asse incollato o un range incompleto non si scrivono mai;
  // uno peggiore dell'inizio solo con la seconda conferma spuntata.
  const lock = currentWriteLock();
  if (lock.mode === 'disabled' || (lock.mode === 'guarded' && !$('flash-ack').checked)) return;
  const controller = ds5;
  $('btn-flash-go').disabled = true;
  const op = ops.beginOp();
  closeModal('modal-flash');
  flashing = true;
  try {
    await controller.flash();
    const nv = await refreshNv();
    // Parola di stato grezza della NVS dopo il flash (verifica hardware H1).
    // Finché H1 non misura l'insieme degli stati "riuscito", la regola della
    // release 1 è: nessuna eccezione e stato ≠ `unlocked`. Una NVS rimasta
    // aperta non è un salvataggio riuscito: ogni calibrazione successiva
    // finirebbe dritta in memoria, quindi `unsaved` resta alzato.
    const raw = typeof nv?.raw === 'number' ? `0x${nv.raw.toString(16).padStart(8, '0')}` : 'n/a';
    console.info('[flash] NVS status after flash:', nv?.status ?? null, raw);
    log(`NVS status after flash: ${nv?.status ?? 'n/a'} (raw ${raw}).`);
    if (nv?.status === 'unlocked') {
      recordEvent('flash', { ok: false, nv: nv.status });
      toast(`Save not confirmed: ${NV_UNLOCKED_MESSAGE}`, 8000, { alert: true });
      log('Flash not confirmed: NVS still unlocked.');
      return;
    }
    recordEvent('flash', { ok: true, nv: nv?.status ?? null });
    setUnsaved(false);
    markTabUnsaved(false);
    if (nv?.status === 'pending_reboot') {
      toast('Saved. The controller needs a restart: use the "Restart" button.', 5000);
    } else {
      toast('Calibration saved permanently to the controller.');
    }
    log('Flash complete.');
  } catch (error) {
    // Anche qui si rilegge lo stato: un unlock riuscito seguito da un lock
    // fallito lascia la NVS aperta, e il chip deve dirlo (e bloccare Quick).
    const nv = await refreshNv();
    recordEvent('flash', { ok: false, nv: nv?.status ?? null, err: String(error.message || error).slice(0, 120) });
    if (error.nvUnknown) toast(NV_UNKNOWN_MESSAGE, 8000, { alert: true });
    else toast(`Error while saving: ${error.message}`, 5000, { alert: true });
    log(`Flash error: ${error.message}`);
  } finally {
    flashing = false;
    ops.endOp(op);
    syncBusyTitle();
  }
}

/* ============================== calibrazione rapida ============================== */

let quickPreflightBlocked = false;
// Partenza già centrata: il prossimo "Calibrate anyway" passa force a runQuick.
let quickForceNext = false;
// Recupero opt-in dopo un esito catastrofico (C0-10): una sola passata, con
// force, e comunque dietro la tenuta entro il 15% di runQuick.
let quickRecoveryNext = false;
// Durante uno stallo (WS1) Cancel non chiude il modale: chiede a runQuick di
// abbandonare la passata senza calibEnd. Fuori dallo stallo è ignorato.
let quickStallCancelable = false;
let quickCancelRequested = false;
// Controller con una sessione di calibrazione lasciata aperta (stallo di
// Quick, errore o scollegamento fra calibBegin e calibEnd in Quick o nel
// wizard): nessun comando di calibrazione o scrittura finché non viene
// riavviato. Il blocco segue il CONTROLLER, non l'oggetto DS5: Disconnect +
// Connect, un reload o un replug non lo spengono, la sessione resta aperta nel
// firmware e il prossimo calibBegin, rifiutato, verrebbe "riparato" con un
// calibEnd che committa il parziale (anche 0 campioni) senza consenso. Come
// rangeWriteLocks usa la chiave salata del seriale (un seriale illeggibile conta
// come lo stesso controller). Il segno in sessionStorage non porta nessun
// identificativo: dopo un reload il blocco vale per qualunque controller, e
// l'utente lo toglie con Restart o confermando di averlo spento.
// Si toglie SOLO con un Restart inviato o con la conferma esplicita di uno
// spegnimento: la pagina non distingue uno spegnimento da uno stacco.
const TAB_POWER_CYCLE_KEY = 'sense-power-cycle-in-tab';
function tabPowerCycleFlag() {
  try { return tabStore()?.getItem(TAB_POWER_CYCLE_KEY) === '1'; } catch { return false; }
}
let powerCycleLock = tabPowerCycleFlag() ? { controller: null, key: null, reload: true } : null; // { controller, key, reload }
// Seconda linea di difesa: da quando questa scheda ha lasciato (o ereditato
// da un reload) una sessione aperta, calibBegin non ripara più una sessione
// rifiutata: fallisce e rimette il blocco. Così una conferma di spegnimento
// sbagliata, o un Restart che non ha riavviato nulla, non committa il parziale.
let repairAllowed = !powerCycleLock;

function markPowerCycle(controller, key) {
  powerCycleLock = { controller, key: key ?? null, reload: false };
  repairAllowed = false;
  // Il blocco sostituisce il segno provvisorio della sessione in volo: il suo
  // rilascio non deve più togliere nulla.
  sessionGuard = null;
  try { tabStore()?.setItem(TAB_POWER_CYCLE_KEY, '1'); } catch { /* storage negato: resta il blocco in memoria */ }
  updateWriteLock();
}

function clearPowerCycle(reason) {
  if (!powerCycleLock) return;
  powerCycleLock = null;
  try { tabStore()?.removeItem(TAB_POWER_CYCLE_KEY); } catch { /* niente da togliere */ }
  log(reason);
  updateWriteLock();
}

// Segno provvisorio di sessione in volo. Si scrive in modo sincrono PRIMA di
// ogni calibBegin (Quick e Guided), non dopo che il ciclo è uscito: un reload o
// una chiusura della scheda a sessione aperta (fra due angoli del wizard, o a
// metà campionamento di Quick) non passa da fail()/catch, e senza il segno la
// pagina nuova partirebbe con repairAllowed = true, cioè con un calibBegin che
// "ripara" il parziale committandolo. Con il segno la pagina nuova torna
// bloccata (reload: true) e non ripara mai. In memoria cambia solo
// repairAllowed: il blocco vero (powerCycleLock) lo mette chi vede la sessione
// restare aperta. Il rilascio, dopo il calibEnd riuscito di quella sessione o a
// ciclo finito senza blocco, rimette lo stato di prima; dopo un markPowerCycle
// non fa nulla (il segno ora è del blocco).
let sessionGuard = null;
function openSessionGuard() {
  const guard = { repairAllowed, hadFlag: tabPowerCycleFlag() };
  sessionGuard = guard;
  repairAllowed = false;
  try { tabStore()?.setItem(TAB_POWER_CYCLE_KEY, '1'); } catch { /* storage negato: resta repairAllowed = false */ }
  return guard;
}
function releaseSessionGuard(guard) {
  if (!guard || sessionGuard !== guard) return;
  sessionGuard = null;
  repairAllowed = guard.repairAllowed;
  if (!guard.hadFlag && !powerCycleLock) {
    try { tabStore()?.removeItem(TAB_POWER_CYCLE_KEY); } catch { /* niente da togliere */ }
  }
}

// Vale per il controller collegato: lo stesso oggetto DS5, oppure uno la cui
// chiave coincide o non si può confrontare (prudente).
function powerCycleApplies() {
  if (!ds5 || !powerCycleLock) return false;
  if (powerCycleLock.controller === ds5) return true;
  return !(deviceKey && powerCycleLock.key && deviceKey !== powerCycleLock.key);
}

// Al collegamento: se il blocco vale per il controller appena adottato, il
// pannello lo dice subito, con Restart e la conferma di spegnimento.
function reapplyPowerCycle() {
  if (!powerCycleLock) return;
  if (!powerCycleApplies()) {
    log('A different controller is connected: the open calibration session of the previous one does not apply to it.');
    updateWriteLock();
    return;
  }
  log('This controller may still have a calibration pass left open: restart it before calibrating or saving.');
  showOutcome(powerCycleReminderView({ reload: powerCycleLock.reload }));
}

function blockedForPowerCycle() {
  if (!powerCycleApplies()) return false;
  toast('Restart the controller (Restart button, or hold PS for 10 s) before calibrating or saving again. Disconnecting it doesn’t count.', 6000);
  return true;
}

// Conferma esplicita di uno spegnimento fatto a mano. Il calibBegin successivo
// resta senza riparazione (repairAllowed): se il controller non era stato
// spento davvero, l'avvio viene rifiutato e il blocco torna, senza commit.
function confirmPoweredOff() {
  if (!powerCycleApplies() || ops.busy) return;
  const ok = confirm('Continue only if you turned the controller off (held PS for 10 s until the light went out, or used Restart) after the calibration pass was left open. Disconnecting or unplugging the cable doesn’t count. Did you turn it off?');
  if (!ok) return;
  clearPowerCycle('Power-off confirmed by the user: calibration unblocked. A session still open would be refused, never committed.');
  clearOutcome();
}

const QUICK_INTRO = 'Rest the controller on a stable surface and <b>don’t touch the sticks</b>.';
// Dopo una preflight fallita con uno stick che riposa oltre il raggio di Quick
// o al bordo (ultimo test drift): il bottone principale apre Guided o Range.
let quickRouteNext = null;
function resetQuickModal() {
  quickForceNext = false;
  quickRouteNext = null;
  quickRecoveryNext = false;
  $('btn-quick-go').textContent = 'Calibrate now';
  $('btn-quick-go').className = 'btn btn-primary';
  $('btn-quick-cancel').textContent = 'Cancel';
  $('btn-quick-cancel').className = 'btn btn-ghost';
  $('btn-quick-cancel').removeAttribute('data-autofocus');
}

// Partenza già centrata: "Close" è l'azione principale, "Calibrate anyway" la
// secondaria. Una passata da un pavimento può solo restare o peggiorare.
function offerCalibrateAnyway() {
  quickForceNext = true;
  $('btn-quick-go').textContent = 'Calibrate anyway';
  $('btn-quick-go').className = 'btn btn-secondary';
  $('btn-quick-cancel').textContent = 'Close';
  $('btn-quick-cancel').className = 'btn btn-primary';
  $('btn-quick-cancel').setAttribute('data-autofocus', '');
}

function openQuickModal() {
  resetHandsOff();
  openModal('modal-quick');
}

function openQuickRecovery() {
  if (!calibrationAllowed() || blockedForPowerCycle()) return;
  resetQuickModal();
  quickRecoveryNext = true;
  $('btn-quick-go').textContent = 'Run one pass';
  $('quick-msg').innerHTML = 'One recovery pass, with the same safety checks. <b>Only try it with both sticks fully released</b> and the controller resting on a table.';
  openQuickModal();
}

function cancelQuickCalibration() {
  if (ops.busy) {
    if (quickStallCancelable) {
      quickCancelRequested = true;
      $('btn-quick-cancel').disabled = true;
    }
    return;
  }
  closeModal('modal-quick');
  const resume = quickPreflightBlocked || quickForceNext;
  quickPreflightBlocked = false;
  resetQuickModal();
  $('quick-msg').innerHTML = QUICK_INTRO;
  if (resume) startDriftTest();
}

/* --------- telemetria locale + upload anonimo (opt-out) --------- */
// localStorage sempre. L'upload è attivo di default: i dati sono anonimi per
// costruzione (mai seriale, ID, IP o fingerprint) e servono ad addestrare
// miglioramenti data-driven dell'algoritmo. '0' esplicito = opt-out persistito.
const CALIB_STORE_KEY      = 'sense-calib-sessions';
const TELEMETRY_CONSENT_KEY = 'sense-telemetry-consent';
const TELEMETRY_NOTICE_KEY = 'sense-telemetry-notice';

// Solo un SecurityError (storage negato dal browser) spegne lo storage per la
// pagina. Prima lo spegneva qualunque eccezione, anche la quota piena: da lì
// `telemetryEnabled()` tornava false e chi aveva scelto di condividere smetteva
// in silenzio, con la casella del consenso ancora spuntata.
let storageAvailable = true;
const STORE_TRIM_ON_QUOTA = 50;
const isSecurityError = error => error?.name === 'SecurityError';
const isQuotaError = error => error?.name === 'QuotaExceededError'
  || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error?.code === 22 || error?.code === 1014;

function storageRead(key, fallback = null) {
  if (!storageAvailable) return fallback;
  try { return localStorage.getItem(key) ?? fallback; }
  catch (error) {
    if (isSecurityError(error)) storageAvailable = false;
    return fallback;
  }
}

// Ultime STORE_TRIM_ON_QUOTA sessioni locali, o un array vuoto se il valore
// salvato non è un array leggibile.
function trimmedSessions(json) {
  try {
    const arr = JSON.parse(json ?? '[]');
    return JSON.stringify(Array.isArray(arr) ? arr.slice(-STORE_TRIM_ON_QUOTA) : []);
  } catch { return '[]'; }
}

function storageWrite(key, value) {
  if (!storageAvailable) return false;
  try { localStorage.setItem(key, value); return true; }
  catch (error) {
    if (isSecurityError(error)) { storageAvailable = false; return false; }
    if (!isQuotaError(error)) return false;
  }
  // Quota piena: si sacrifica lo storico locale delle sessioni (la voce più
  // grande), mai il consenso, e si riprova una volta.
  try {
    if (key === CALIB_STORE_KEY) {
      localStorage.setItem(key, trimmedSessions(value));
    } else {
      localStorage.setItem(CALIB_STORE_KEY, trimmedSessions(localStorage.getItem(CALIB_STORE_KEY)));
      localStorage.setItem(key, value);
    }
    return true;
  } catch (error) {
    if (isSecurityError(error)) storageAvailable = false;
    return false;
  }
}
const telemetryEnabled = () => {
  const value = storageRead(TELEMETRY_CONSENT_KEY);
  return storageAvailable && value !== '0';
};
const noticeSeen = () => storageRead(TELEMETRY_NOTICE_KEY) === '1';

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

// Ogni azione significativa produce un evento locale tipizzato. Il server v1
// riceve solo sessioni quick complete e compatibili con il suo schema stretto;
// gli altri eventi restano nel browser.
function recordEvent(kind, data = {}) {
  recordCalibSession({
    kind,
    t: new Date().toISOString(),
    board: deviceInfo?.board ?? null,
    fw: deviceInfo?.fwversion ?? null,
    ...data,
  });
}

function recordCalibSession(entry) {
  entry.sid = SESSION_ID;
  try {
    let arr = JSON.parse(storageRead(CALIB_STORE_KEY, '[]'));
    // Un valore non-array (null, {}) faceva lanciare `push` a ogni evento:
    // lo storico locale era perso per sempre, in silenzio.
    if (!Array.isArray(arr)) arr = [];
    arr.push(entry);
    storageWrite(CALIB_STORE_KEY, JSON.stringify(arr.slice(-200)));
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
// una calibrazione. Un 4xx/5xx non viene più registrato come invio riuscito.
function uploadEvent(entry) {
  uploadCalibrationEvent(entry)
    .then(sent => { if (sent) log('Anonymous calibration telemetry sent.'); })
    .catch(error => log(`Anonymous telemetry not sent: ${error.message}`));
}

// Messaggi del modale Quick per ogni fase di runQuick (js/calib/quick.js).
// Accanto c'è il misuratore "mani lontane" (js/ui/hands-off.js), che reagisce
// in tempo reale; questi testi dicono cosa sta facendo l'algoritmo.
function quickProgressHtml({ phase, pass, worst }) {
  if (phase === 'preflight') return 'Release both sticks. Waiting for centered, stable readings…';
  if (phase === 'noisy') return 'The readings are jumping around. <b>Let go of both sticks</b> and keep the controller flat on the table. If nobody is touching them, the sensor may be worn.';
  if (phase === 'held') return 'Hold detected: <b>let go of the sticks.</b> A held stick would be saved as the new center.';
  if (phase === 'pass' || phase === 'resumed') return `Pass ${pass}: calibrating. <b>Don’t touch the sticks.</b>`;
  if (phase === 'unstable') return `Pass ${pass}: unstable signal. <b>Don’t touch the sticks.</b>`;
  if (phase === 'stalled') return `Pass ${pass} is not settling. <b>Let go of both sticks</b>, or cancel.`;
  if (phase === 'verify') return `Pass ${pass}: verifying…`;
  if (phase === 'next') return worst === null
    ? 'The result could not be verified, running another pass…'
    : `Residual offset ${formatOffset(worst)}, running another pass…`;
  return null;
}

// L'esito finale va nel pannello persistente (js/ui/outcome.js), compresi gli
// esiti di WS1 ('catastrophic', 'moved', 'stalled'): a 15% o più nessun
// percorso suona come un successo e Write è disabilitato. runQuick riceve il
// controller catturato, non più il `ds5` globale (niente `liveController`).

// UI della calibrazione rapida: l'algoritmo è runQuick (js/calib/quick.js),
// qui restano `busy`, modale, messaggi, toast, telemetria e stato non salvato.
async function quickCalibrate() {
  if (!ds5 || ops.busy || blockedForPowerCycle()) return;
  if (quickRouteNext) {
    const route = quickRouteNext;
    resetQuickModal();
    closeModal('modal-quick');
    runOutcomeAction(route);
    return;
  }
  // Il controller catturato è l'UNICO bersaglio dei comandi: dopo un replug a
  // metà passata il ciclo non deve pilotare il controller nuovo (prima usava
  // il `ds5` globale). runQuick controlla isCurrent() dopo ogni await.
  const controller = ds5;
  // Chiave del controller per il blocco "sessione aperta": deve seguirlo anche
  // se si stacca mentre la passata è in volo (teardown azzera deviceKey).
  const controllerKey = deviceKey;
  const recovery = quickRecoveryNext;
  const force = quickForceNext || recovery;
  cancelDriftTest();
  const op = ops.beginOp();
  clearOutcome();
  const bar = $('quick-bar');
  quickPreflightBlocked = false;
  resetQuickModal();
  quickStallCancelable = false;
  quickCancelRequested = false;
  quickHoldKnown = false;
  const msg = $('quick-msg');
  $('btn-quick-go').disabled = true;
  $('btn-quick-cancel').disabled = true;
  let blockedMessage = null;
  let run = null;
  // Vero appena la pagina ha alzato `unsaved` per un commit di QUESTA corsa
  // (evento 'committed' di runQuick): il teardown di uno scollegamento
  // successivo lo vede e avvisa da solo.
  let committedShown = false;
  // Segno di sessione in volo di QUESTA corsa (openSessionGuard).
  let guard = null;
  const fail = (session, error, committed, needsPowerCycle = false) => {
    // Sessione lasciata aperta a metà passata: il controller va spento prima di
    // qualunque altro comando, come dopo uno stallo (il prossimo calibBegin
    // sarebbe rifiutato e la riparazione committerebbe il parziale).
    // Anche da un ciclo orfano: il blocco segue il controller, non la UI.
    if (needsPowerCycle) markPowerCycle(controller, controllerKey);
    if (!ops.isCurrent(op)) { recordSessionOnce(session); return; }
    ops.endOp(op);
    // La RAM del controller è cambiata se una passata precedente ha già chiuso
    // con calibEnd (un errore alla passata 2 non la annulla), oppure se la
    // riparazione di calibBegin ha committato prima che la calibrazione partisse.
    // Una sessione solo aperta non ha cambiato la RAM: niente `unsaved`, ma
    // Write e ogni comando restano bloccati (showOutcome → updateWriteLock).
    if (committed) setUnsaved(true);
    session.aborted = 'error';
    session.err = String(error.message || error).slice(0, 120);
    recordSessionOnce(session);
    closeModal('modal-quick');
    showOutcome(quickOutcomeView({ outcome: 'error', error, committed, needsPowerCycle, worst: null, session }, { nvStatus: lastNvStatus }));
    log(`Quick calibration error: ${error.message}`);
  };
  try {
    run = await runQuick({
      controller,
      source: stickSource,
      clock: pageClock,
      isCurrent: () => ds5 === controller,
      isCancelled: () => quickCancelRequested,
      force,
      params: recovery ? { maxPasses: 1 } : {},
      repairStaleSession: repairAllowed,
      onSession: state => {
        if (state === 'opening') guard = openSessionGuard();
        else { releaseSessionGuard(guard); guard = null; }
      },
      onProgress: event => {
        if (ops.isCurrent(op)) {
          if (event.phase === 'held' || event.phase === 'stalled' || event.phase === 'unstable') quickHoldKnown = true;
          else if (event.bar !== undefined || ['pass', 'resumed', 'verify', 'next'].includes(event.phase)) quickHoldKnown = false;
        }
        if (event.phase === 'committed') {
          // La RAM è appena cambiata (calibEnd, o riparazione di calibBegin):
          // `unsaved` si alza ORA, non a fine ciclo, così uno scollegamento
          // nella passata successiva trova lo stato giusto (avviso all'uscita,
          // segno della scheda). Un ciclo orfano segna almeno la scheda.
          if (ops.isCurrent(op) && ds5 === controller) {
            setUnsaved(true);
            committedShown = true;
          } else markTabUnsaved(true);
          return;
        }
        if (!ops.isCurrent(op)) return; // ciclo orfano: la UI è di un'altra operazione
        if (event.bar !== undefined) bar.style.width = event.bar + '%';
        if (event.phase === 'stalled' || event.phase === 'resumed') {
          quickStallCancelable = event.phase === 'stalled';
          $('btn-quick-cancel').disabled = !quickStallCancelable || quickCancelRequested;
        }
        // Durante lo stallo il prompt "lascia gli stick" resta visibile.
        if (quickStallCancelable && event.phase === 'unstable') return;
        const html = quickProgressHtml(event);
        if (html !== null) setLive(msg, html, { html: true });
      },
      log,
      meta: { board: deviceInfo?.board ?? null, fw: deviceInfo?.fwversion ?? null },
    });
    const { session, outcome } = run;
    if (outcome === 'disconnected') {
      // Il teardown ha già chiuso i modali e avvisato: la UI ora può essere di
      // un altro controller, quindi qui si registra soltanto. Se però la RAM
      // del controller scollegato è cambiata senza che la pagina lo sapesse
      // (commit segnalato solo dall'errore), il segno della scheda e l'avviso
      // all'uscita mancano: li si dà qui. Che lo scollegamento la scarti è H11.
      recordSessionOnce(session);
      // Scollegato fra calibBegin e calibEnd: la sessione resta aperta nel
      // firmware anche dopo il ricollegamento (non è uno spegnimento).
      if (run.needsPowerCycle) markPowerCycle(controller, controllerKey);
      if (run.committed && !committedShown) {
        markTabUnsaved(true);
        toast(unsavedOnExitMessage(lastNvStatus), 10000);
      }
      log('Quick calibration interrupted: controller disconnected.');
      return;
    }
    if (outcome === 'already-centered') {
      recordSessionOnce(session);
      offerCalibrateAnyway();
      blockedMessage = 'Both sticks are already centered, at the measurement limit. <b>Nothing was sent to the controller.</b> Another pass can only keep them there or make them worse.';
      showOutcome(quickOutcomeView(run, { nvStatus: lastNvStatus }));
      return;
    }
    if (outcome === 'stalled') {
      recordSessionOnce(session);
      markPowerCycle(controller, controllerKey);
      setUnsaved(true);
      closeModal('modal-quick');
      showOutcome(quickOutcomeView(run, { nvStatus: lastNvStatus }));
      log('Quick calibration abandoned mid-pass: controller needs a restart.');
      return;
    }
    if (outcome === 'preflight') {
      quickPreflightBlocked = true;
      recordSessionOnce(session);
      // Se l'ultimo test drift dice già che uno stick riposa oltre il raggio di
      // Quick (o al bordo), nessuno lo sta toccando: il testo lo dice per primo
      // e il bottone porta a Guided (Pinned: Range). Niente "Stick held": il
      // misuratore mostrerebbe una mano che non c'è.
      const route = quickPreflightRoute(lastDriftResult);
      if (route) {
        quickRouteNext = route.action.id;
        $('btn-quick-go').textContent = route.action.label;
        blockedMessage = `Calibration has not started. <b>${esc(route.text)}</b> If someone was touching the sticks, release them and run the drift test again.`;
        log(`Quick calibration not started: ${route.text}`);
        return;
      }
      // Il modale dice "Release both sticks": il misuratore non deve dire il contrario.
      if (ops.isCurrent(op)) quickHoldKnown = true;
      blockedMessage = 'Calibration has not started. <b>Release both sticks</b> and keep the controller still, then try again. Check the USB connection if readings have stopped. If a released stick stays far from center, use guided calibration.';
      log('Quick calibration not started: centered, stable stick readings are required.');
      return;
    }
    if (outcome === 'error') {
      fail(session, run.error, run.committed, run.needsPowerCycle === true);
      return;
    }
    recordSessionOnce(session);
    if (!ops.isCurrent(op)) return;

    bar.style.width = '100%';
    await sleep(300);
    if (!ops.isCurrent(op)) return;
    closeModal('modal-quick');
    setUnsaved(true);
    // Pannello persistente al posto del toast: a 15% o più non suona mai come
    // un successo e disabilita Write; il consiglio di spegnere il controller
    // compare solo con la NVS letta `locked` (C0-11).
    showOutcome(quickOutcomeView(run, { nvStatus: lastNvStatus }));
    log(outcomeLogLine(run));
    ops.endOp(op);
    startDriftTest();
  } catch (error) {
    // Solo errori della UI dopo runQuick (che non lancia): la sessione è già
    // chiusa e registrata, quindi `recordSessionOnce` non la duplica.
    fail(run?.session ?? { kind: 'quick' }, error, run?.committed === true);
  } finally {
    // Ciclo finito senza sessione aperta (avvio rifiutato con certezza, esito
    // normale): il segno provvisorio se ne va. Con una sessione aperta il
    // blocco è già stato segnato e il rilascio non fa nulla; se non lo fosse
    // (run.needsPowerCycle senza markPowerCycle) il segno resta, per prudenza.
    if (!run?.needsPowerCycle) releaseSessionGuard(guard);
    quickStallCancelable = false;
    // Un ciclo orfano (controller scollegato e magari già sostituito) non tocca
    // né il flag busy né il modale dell'operazione nuova.
    if (ops.isCurrent(op)) {
      ops.endOp(op);
      $('btn-quick-go').disabled = false;
      $('btn-quick-cancel').disabled = false;
      bar.style.width = '0%';
      msg.innerHTML = blockedMessage || QUICK_INTRO;
      if (quickForceNext && !$('modal-quick').classList.contains('hidden')) $('btn-quick-cancel').focus();
    }
    syncBusyTitle();
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

// Stato del wizard (null fuori dalla procedura). `phase`:
//   'intro'  → Start: stick fermi, misura di partenza, calibBegin
//   'ref'    → sessione aperta, si attende il punto di riposo di riferimento
//   'corner' → angolo `corner` mostrato; Continue = gate + calibSample
//   'done'   → calibEnd fatto, confronto prima/dopo a schermo
// `step` guida i puntini (0 intro, 1–4 angoli, 5 fatto) ed è il passo
// registrato se la procedura si rompe.
let wizard = null;
// Ultimo confronto prima/dopo del wizard: lo legge il pannello dell'esito (WS5).
let lastWizardComparison = null;

function wizardSetDots(step) {
  [...$('wizard-dots').children].forEach((dot, i) => {
    dot.className = i < step ? 'done' : i === step ? 'active' : '';
  });
}

function wizardShowCorner(i, note = '') {
  const c = WIZARD_CORNERS[i];
  $('wizard-diagram').classList.remove('hidden');
  $('wizard-line').setAttribute('x2', c.x);
  $('wizard-line').setAttribute('y2', c.y);
  $('wizard-target').setAttribute('cx', c.x);
  $('wizard-target').setAttribute('cy', c.y);
  $('wizard-msg').innerHTML = (note ? `${note}<br>` : '')
    + `Move <b>both sticks ${c.label}</b> (inside the dashed ring below), then release them.<br>`
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

// La procedura appartiene al controller su cui è partita: dopo un replug (o
// un teardown, che azzera `wizard`) il ciclo orfano non invia più nulla e non
// tocca il modale della procedura nuova.
const wizardCurrent = w => wizard === w && !!w.controller && ds5 === w.controller;
const wizardGone = () => Object.assign(new Error('Controller disconnected'), { gone: true });

// Timeout del gate: nessun campione. Il riferimento non si allarga da solo;
// dopo `escapeAfter` timeout compare l'uscita esplicita.
function wizardTimeout(w, why) {
  w.timeouts += 1;
  w.gateTimedOut = true;
  const offerEscape = !w.escaped && w.timeouts >= WIZARD_DEFAULTS.escapeAfter;
  $('btn-wizard-escape').classList.toggle('hidden', !offerEscape);
  const escapeHint = offerEscape
    ? '<br>If your stick never settles at the same point, use <b>My stick doesn’t rest still</b>.'
    : '';
  $('wizard-msg').innerHTML = `${why} No sample was taken. <b>Let go of both sticks</b>, wait until they settle, `
    + `then press <b>Continue</b>.${escapeHint}`;
}

// Punto di riposo di riferimento, preso a sessione aperta (stesso frame dei
// campioni). Serve anche con l'uscita esplicita: è il centro del raggio largo
// dell'uscita, che non toglie mai il controllo di posizione.
async function wizardCaptureRef(w, ensure, isCancelled) {
  const btn = $('btn-wizard-next');
  btn.textContent = 'Waiting…';
  $('wizard-msg').innerHTML = 'Keep your hands off the sticks: measuring where they rest…';
  const ref = await captureRestReference(stickSource, pageClock, { escaped: w.escaped, isCancelled });
  ensure();
  if (!ref) {
    btn.textContent = 'Continue';
    wizardTimeout(w, 'The sticks did not come to rest.');
    return;
  }
  w.ref = ref;
  w.gateTimedOut = false;
  w.phase = 'corner';
  w.corner = 0;
  w.step = 1;
  w.tracker = createCornerTracker(WIZARD_CORNERS[0]);
  $('btn-wizard-escape').classList.add('hidden');
  wizardShowCorner(0);
  btn.textContent = 'Continue';
  wizardSetDots(1);
}

async function wizardSampleCorner(w, ensure, isCancelled) {
  const btn = $('btn-wizard-next');
  const i = w.corner;
  btn.textContent = 'Waiting…';
  $('wizard-msg').innerHTML = 'Waiting for both sticks to rest…';
  const gate = await gateWizardSample(stickSource, pageClock, {
    tracker: w.tracker, ref: w.ref, tol: w.tol, escaped: w.escaped, isCancelled,
  });
  ensure();
  if (!gate.ok) {
    btn.textContent = 'Continue';
    if (gate.reason === 'corner') {
      // Angolo non raggiunto: nessuna attesa e nessun campione. Non conta come
      // timeout (non è uno stick che non si ferma).
      w.cornerMisses += 1;
      const what = gate.missing.length === 2
        ? 'Neither stick reached the corner.'
        : `The ${gate.missing[0]} stick didn’t reach the corner.`;
      wizardShowCorner(i, `<b>${what}</b> No sample was taken.`);
    } else {
      wizardTimeout(w, 'The sticks are not resting where they started.');
    }
    return;
  }
  await w.controller.calibSample();
  ensure();
  w.samples += 1;
  w.gateTimedOut = false;
  $('btn-wizard-escape').classList.add('hidden');
  if (i < WIZARD_CORNERS.length - 1) {
    w.corner = i + 1;
    w.step = i + 2;
    w.tracker.reset(WIZARD_CORNERS[w.corner]);
    wizardShowCorner(w.corner);
    btn.textContent = 'Continue';
    wizardSetDots(w.step);
    return;
  }
  // Quarto campione: chiusura della sessione e confronto prima/dopo.
  w.tracker = null;
  btn.textContent = 'Saving…';
  await sleep(400);
  ensure();
  await w.controller.calibEnd();
  w.sessionOpen = false;
  releaseSessionGuard(w.guard);
  w.guard = null;
  w.committed = true;
  setUnsaved(true);
  ensure();
  const after = summarizeResult(await measureOffset());
  ensure();
  ops.endOp(w.op);
  w.phase = 'done';
  w.step = 5;
  wizardSetDots(5);
  const comparison = wizardComparison(w.before, after);
  lastWizardComparison = comparison;
  w.reported = true;
  // Solo locale (il payload v1 porta soltanto sessioni quick).
  recordEvent('wizard', {
    done: true, before: w.before ?? null, after,
    samples: w.samples, timeouts: w.timeouts, cornerMisses: w.cornerMisses, escaped: w.escaped,
  });
  $('wizard-diagram').classList.add('hidden');
  wizardHideLive();
  // Prima e dopo anche nel pannello persistente (WS5), con lo stesso blocco di
  // Write della rapida (peggiore dell'inizio, ≥15%, asse incollato).
  showOutcome(guidedOutcomeView({ before: w.before ?? null, after }, { nvStatus: lastNvStatus }));
  $('wizard-msg').innerHTML = `${wizardResultHtml(comparison, w.escaped)}<br>The result stays on the page after you close this.`;
  btn.textContent = 'Done';
}

function wizardResultHtml(cmp, escaped) {
  const rows = cmp.sticks.map(s => `${esc(s.name)}: ${esc(s.beforeLabel)} → <b>${esc(s.afterLabel)}</b>`).join('<br>');
  let tail;
  if (!cmp.measured) tail = 'The result could not be measured (the sticks were moving): check it with the drift test.';
  else if (cmp.worse) {
    // Il consiglio di spegnere solo con la memoria confermata `locked` (C0-11).
    tail = '<b>This is worse than before.</b> Don’t write it to memory'
      + (lastNvStatus === 'locked' ? ': turn the controller off (hold PS for 10 s), which should discard it.' : '.');
  } else tail = 'Check the result with the drift test.';
  const escapedNote = escaped ? '<br>The rest check was looser for some samples: the result may be less precise.' : '';
  return `Center calibration complete.<br>${rows}<br>${tail}${escapedNote}`;
}

async function wizardNext() {
  const w = wizard;
  if (!ds5 || !w || w.running) return;
  const btn = $('btn-wizard-next');
  btn.disabled = true;
  w.running = true;
  const ensure = () => { if (!wizardCurrent(w)) throw wizardGone(); };
  const isCancelled = () => !wizardCurrent(w);
  try {
    if (w.phase === 'intro') {
      // Cancel va nascosto e `busy` alzato PRIMA di qualunque await: durante
      // l'attesa il modale è ancora a schermo, e un Cancel in quella finestra
      // chiuderebbe il modale lasciando `busy` a true per sempre — bloccando
      // ogni calibrazione successiva fino al reload.
      $('btn-wizard-cancel').classList.add('hidden');
      w.op = ops.beginOp();
      w.controller = ds5;
      w.key = deviceKey;
      clearOutcome();
      btn.textContent = 'Measuring…';
      $('wizard-msg').innerHTML = 'Keep your hands off the sticks for a moment…';
      // Stick fermi prima di qualunque comando: con un pollice sullo stick
      // non parte nulla e la procedura si può ancora annullare.
      const held = await waitForStable({
        spread: WIZARD_DEFAULTS.spread, holdMs: WIZARD_DEFAULTS.holdMs, timeoutMs: WIZARD_DEFAULTS.timeoutMs, isCancelled,
      });
      ensure();
      if (!held) {
        ops.endOp(w.op);
        w.op = null;
        w.controller = null;
        $('btn-wizard-cancel').classList.remove('hidden');
        btn.textContent = 'Start';
        $('wizard-msg').innerHTML = 'The sticks are moving or being touched. <b>Let go of both sticks</b>, then press '
          + '<b>Start</b> again. Nothing was sent to the controller.';
        return;
      }
      // Misura di partenza: il wizard è il percorso per il drift ostinato, cioè
      // i casi più informativi. È anche il "prima" del confronto finale (stesso
      // frame calibrato del "dopo"), e il suo rumore fissa la tolleranza.
      const measured = await measureOffset(1000);
      ensure();
      // Un tocco nel secondo di misura fa esplodere il rumore, e con esso la
      // tolleranza del riferimento: la misura disturbata si rifiuta qui, PRIMA
      // di calibBegin, come uno stick non fermo all'avvio. Nessun comando è
      // partito, la procedura si può ancora annullare.
      const beforeCheck = checkBefore(measured);
      if (!beforeCheck.ok) {
        ops.endOp(w.op);
        w.op = null;
        w.controller = null;
        $('btn-wizard-cancel').classList.remove('hidden');
        btn.textContent = 'Start';
        log(`Guided calibration: start measurement rejected (${beforeCheck.reason}); nothing sent.`);
        $('wizard-msg').innerHTML = (beforeCheck.reason === 'no-data'
          ? 'The controller stopped sending stick readings while they were being measured. Check the cable, then press '
          : 'A stick moved while it was being measured. <b>Let go of both sticks</b>, then press ')
          + '<b>Start</b> again. Nothing was sent to the controller.';
        return;
      }
      w.before = summarizeResult(measured);
      w.tol = restTolerance(w.before);
      // Il segno di sessione in volo va scritto PRIMA del comando (vedi
      // openSessionGuard): un reload fra due angoli torna bloccato.
      const repair = repairAllowed;
      w.guard = openSessionGuard();
      const begun = await w.controller.calibBegin({ repair });
      w.sessionOpen = true;
      // La riparazione di una sessione rimasta aperta può aver committato:
      // la RAM è già cambiata.
      if (begun?.committed) {
        w.committed = true;
        setUnsaved(true);
      }
      ensure();
      w.phase = 'ref';
      await wizardCaptureRef(w, ensure, isCancelled);
    } else if (w.phase === 'ref') {
      await wizardCaptureRef(w, ensure, isCancelled);
    } else if (w.phase === 'corner') {
      await wizardSampleCorner(w, ensure, isCancelled);
    } else {
      closeModal('modal-wizard');
      setUnsaved(true);
      startDriftTest();
    }
  } catch (error) {
    ops.endOp(w.op);
    w.tracker = null;
    const gone = error.gone || !wizardCurrent(w);
    // Anche il wizard fallito è un dato: registra dove si è rotto. Il flag
    // impedisce un secondo evento se a lanciare è stato il codice DOM che segue
    // l'evento di successo: quella procedura è riuscita, e contarla anche come
    // fallita sporcherebbe il rapporto successi/fallimenti del dataset.
    if (!w.reported) {
      w.reported = true;
      recordEvent('wizard', {
        done: false,
        step: w.step ?? null,
        before: w.before ?? null,
        samples: w.samples, timeouts: w.timeouts, escaped: w.escaped,
        ...(gone ? { aborted: 'disconnected' } : { err: String(error.message || error).slice(0, 120) }),
      });
    }
    // Errore (o scollegamento) dopo un calibBegin riuscito e prima del
    // calibEnd: la sessione resta aperta nel firmware con 1–3 angoli. Come per
    // lo stallo della rapida, niente altri comandi finché il controller non
    // viene spento: il prossimo calibBegin sarebbe rifiutato e la sua
    // riparazione (calibEnd) committerebbe quel parziale. Un avvio rifiutato
    // senza riparazione (`openSession`) lascia aperta la sessione di prima.
    // Il blocco va segnato anche se il controller si è staccato: segue la
    // chiave e torna al ricollegamento.
    const leftOpen = w.sessionOpen === true || error.openSession === true;
    if (leftOpen) markPowerCycle(w.controller, w.key);
    else releaseSessionGuard(w.guard);
    // Scollegato: il teardown ha già chiuso tutto e il controller nuovo non
    // eredita né il modale né lo stato "non salvato" di questo.
    if (gone) return;
    // Una sessione solo aperta non ha cambiato la RAM: il blocco basta.
    if (error.committed || w.committed) setUnsaved(true);
    closeModal('modal-wizard');
    showOutcome(guidedOutcomeView(
      { before: w.before ?? null, error, committed: error.committed === true || !!w.committed, leftOpen },
      { nvStatus: lastNvStatus },
    ));
    log(`Wizard error: ${error.message}`);
  } finally {
    w.running = false;
    btn.disabled = false;
    syncBusyTitle();
  }
}

// Uscita esplicita per uno stick che non torna mai allo stesso punto: dopo
// `escapeAfter` timeout, con conferma, registrata in locale. Allarga il
// controllo di posizione a un raggio fisso (WIZARD_DEFAULTS.escapeLsb) attorno
// al riferimento, senza toglierlo: un pollice fermo sull'angolo o sul bordo
// resta fuori. La finestra stabile resta obbligatoria.
function wizardEscape() {
  const w = wizard;
  if (!w || w.escaped || w.running || w.timeouts < WIZARD_DEFAULTS.escapeAfter) return;
  const go = confirm('Continue with a looser check of where the sticks rest? Use this only if your stick never '
    + 'settles at exactly the same point. Each sample still waits for the sticks to be still and close to where they '
    + 'rested, so keep your hands off them, but the result may be less precise.');
  if (!go) return;
  w.escaped = true;
  $('btn-wizard-escape').classList.add('hidden');
  log('Guided calibration: rest-point check loosened at the user’s request (stick does not rest still).');
  const note = 'Rest check loosened. <b>Let go of both sticks</b>, then press <b>Continue</b>.';
  if (w.phase === 'corner') wizardShowCorner(w.corner, note);
  else $('wizard-msg').innerHTML = note;
}

function openWizard() {
  if (!ds5 || ops.busy || blockedForPowerCycle()) return;
  cancelDriftTest();
  wizard = {
    phase: 'intro', step: 0, corner: 0,
    op: null, controller: null, before: null, ref: null, tol: null, tracker: null,
    samples: 0, timeouts: 0, cornerMisses: 0, escaped: false, committed: false, sessionOpen: false, guard: null,
    running: false, reported: false,
  };
  lastWizardComparison = null;
  wizardSetDots(0);
  wizardHideLive();
  $('wizard-diagram').classList.add('hidden');
  $('btn-wizard-escape').classList.add('hidden');
  $('wizard-msg').innerHTML = 'This procedure re-centers the sticks by sampling their resting position after each movement. Once started it <b>cannot be cancelled</b>: don’t close the page and don’t disconnect the controller.';
  $('btn-wizard-next').textContent = 'Start';
  $('btn-wizard-cancel').classList.remove('hidden');
  resetHandsOff();
  openModal('modal-wizard');
}

/* ============================== range ============================== */

let rangeSession = null; // { startTs, tracker, controller, op }
// Verifica dopo un rangeEnd riuscito: { tracker, result }. Nessun comando HID.
let rangeCheck = null;
let rangeOp = null; // token di ops: la sessione range occupa il controller fino a finishRange
const RANGE_MSG_HTML = $('range-msg').innerHTML;

// Scrittura in memoria disattivata dopo un range chiuso incompleto ("Finish
// anyway"), già chiuso (code 3: il range in RAM è ignoto) o fallito dopo un
// possibile commit (C0-15). L'unico modo di toglierlo è un range completo che
// sostituisce quello in RAM. Non decade allo scollegamento: se il range in RAM
// sopravviva a uno stacco USB senza spegnimento è H11, non verificato, e un
// ricollegamento che riabilitasse Write porterebbe il range incompleto in NVS
// (aggirando H8). Neppure lo spegnimento lo toglie: l'app non distingue uno
// spegnimento da uno stacco, e che lo spegnimento annulli il range è H10.
// Per questo la UI non presenta mai il ricollegamento come via d'uscita.
// Il blocco segue il controller che l'ha prodotto tramite la sua chiave in
// `rangeWriteLocks`, hash salato del seriale (vedi localDeviceKey), mai il
// seriale in chiaro. Se uno dei due seriali non è leggibile il controller che
// si collega è trattato come lo stesso (prudente). Un controller diverso (due
// seriali noti e diversi) non lo eredita, ma il blocco NON decade: resta
// sospeso, come il blocco di power-cycle, e torna quando si ricollega il
// controller che l'ha prodotto. Prima veniva cancellato, e A → B → A
// riabilitava Write sul range incompleto di A. Limite noto: vive solo in
// memoria, quindi un reload della pagina lo perde; WS5 lo deve risolvere nel
// blocco generale della scrittura (esiti Quick), di cui questo è il pezzo del
// range. `rangeWriteLocks` è dichiarato accanto a `centerState`:
// currentWriteLock lo legge.
// Chiave locale del controller collegato (null se il seriale non è leggibile).
let deviceKey = null;

// Sale casuale per pagina: la chiave non è confrontabile tra pagine né
// riconducibile al seriale, e non esce mai dal browser.
const DEVICE_KEY_SALT = crypto.getRandomValues?.(new Uint8Array(16)) ?? null;

async function localDeviceKey(rawSerial) {
  const serial = String(rawSerial ?? '').replace(/\0/g, '').trim();
  if (!serial || !DEVICE_KEY_SALT || !crypto.subtle) return null;
  try {
    const text = new TextEncoder().encode(serial);
    const buf = new Uint8Array(DEVICE_KEY_SALT.length + text.length);
    buf.set(DEVICE_KEY_SALT);
    buf.set(text, DEVICE_KEY_SALT.length);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function rangeLockMessage(reason) {
  const off = lastNvStatus === 'locked'
    ? ' Turning the controller off (hold PS for 10 s) should discard the stored range, but Write stays disabled until a complete range calibration.'
    : '';
  if (reason === 'closed') {
    return 'Writing to memory is disabled: the range session had already closed, so the stored range is unknown. '
      + `Repeat the range calibration first.${off}`;
  }
  if (reason === 'error') {
    return 'Writing to memory is disabled: the range calibration failed after it may have changed the controller. '
      + `Repeat the range calibration before writing.${off}`;
  }
  return `Writing to memory is disabled: the range calibration was finished incomplete. Repeat the range calibration.${off}`;
}

// Motivo del blocco che vale per il controller con chiave `key` (null se
// nessuno). Un blocco vale se le chiavi coincidono o se una delle due manca
// (seriale illeggibile: stesso controller, prudente), salvo che quel
// controller abbia poi chiuso un range completo (`exempt`, solo per i blocchi
// senza chiave: vedi setRangeWriteLock). Senza controller collegato
// (deviceKey null) vale qualunque blocco.
function rangeLockFor(key) {
  let found = null;
  for (const [lockKey, lock] of rangeWriteLocks) {
    if (lockKey === key) return lock.reason;
    if (lockKey !== null && key !== null) continue;
    if (key !== null && lock.exempt.has(key)) continue;
    found ??= lock.reason;
  }
  return found;
}

// `key`: il controller a cui il blocco appartiene. finishRange passa la chiave
// letta PRIMA del rangeEnd: se il controller si stacca mentre il rangeEnd è in
// volo, teardown ha già azzerato deviceKey, ma il blocco va registrato lo
// stesso e deve seguire quel controller al ricollegamento.
// `reason` null = un range completo visto su QUEL controller: toglie solo il
// suo blocco. Un blocco senza chiave (range lasciato da un controller dal
// seriale illeggibile, che potrebbe essere questo) smette di valere per questo
// controller ma resta per gli altri. Un controller dal seriale illeggibile non
// toglie i blocchi con chiave: potrebbe non essere il loro controller, e
// toglierli riaprirebbe A → X → A.
function setRangeWriteLock(reason, key = deviceKey) {
  if (reason) {
    rangeWriteLocks.set(key, { reason, exempt: new Set() });
  } else {
    rangeWriteLocks.delete(key);
    if (key !== null) rangeWriteLocks.get(null)?.exempt.add(key);
  }
  syncRangeLockTitle();
  // Il bottone lo decide il blocco generale di Write (WS5), che include questo:
  // togliere il blocco del range non deve riabilitare Write se un altro motivo
  // (esito catastrofico, asse incollato, sessione da spegnere) lo tiene spento.
  updateWriteLock();
}

function syncRangeLockTitle() {
  const reason = rangeLockFor(deviceKey);
  $('btn-flash').title = reason ? rangeLockMessage(reason) : '';
}

// Al collegamento: un blocco lasciato da un altro controller (entrambi i
// seriali noti e diversi) non vale per questo, ma resta sospeso per il suo;
// altrimenti vale e l'utente viene avvisato che il range incompleto può essere
// ancora attivo.
function reapplyRangeWriteLock(key) {
  if (!rangeWriteLocks.size) return;
  syncRangeLockTitle();
  updateWriteLock();
  const reason = rangeLockFor(key);
  if (!reason) {
    log('A different controller is connected: the range write lock of the previous one does not apply to it (it still applies to that controller).');
    return;
  }
  const msg = 'This controller may still have the incomplete range calibration from before it was disconnected. '
    + rangeLockMessage(reason);
  log(msg);
  toast(msg, 9000);
}

function blockedByRangeWriteLock() {
  const reason = rangeLockFor(deviceKey);
  if (!reason) return false;
  toast(rangeLockMessage(reason), 7000);
  return true;
}

function useRangeTracker(tracker) {
  dialRangeL.bins = tracker.left.bins;
  dialRangeR.bins = tracker.right.bins;
}

function resetRangeReadouts(hint) {
  $('range-bar').style.width = '0%';
  $('range-pct').textContent = 'Coverage 0%';
  $('range-minmax').innerHTML = '<span>LX</span><span>LY</span><span>RX</span><span>RY</span>';
  $('range-hint').textContent = hint;
}

// Passo introduttivo prima di rangeBegin (come Start nel wizard): a sessione
// aperta non c'è Cancel né Esc, e con zero movimento Done non si sblocca mai,
// quindi l'utente deve saperlo PRIMA che parta qualunque comando. Qui Cancel ed
// Esc chiudono senza aver inviato nulla. `rangeIntro` lega lo Start al
// controller su cui il modale è stato aperto.
let rangeIntro = null;
function setRangeIntro(on) {
  $('range-intro').classList.toggle('hidden', !on);
  $('range-msg').classList.toggle('hidden', on);
  $('range-live').classList.toggle('hidden', on);
  $('btn-range-cancel').classList.toggle('hidden', !on);
  $('btn-range-start').classList.toggle('hidden', !on);
  $('btn-range-done').classList.toggle('hidden', on);
  // Il fuoco iniziale va su Start nell'intro, sul pannello a sessione aperta.
  $('btn-range-start').toggleAttribute('data-autofocus', on);
}

// Uno stick incollato al bordo su un asse non raggiunge mai il lato opposto:
// il range non si completa e "Finish anyway" non si sblocca (minExtent).
// Finché H12 non dice cosa fa il range a uno stick così, lo si dice prima.
function knownPinned() {
  if (centerState?.pinned) return true;
  return !!lastDriftResult && ['left', 'right'].some(side => stickTier(lastDriftResult, side)?.id === 'pinned');
}

function openRange() {
  if (!ds5 || ops.busy || blockedForPowerCycle()) return;
  cancelDriftTest();
  rangeCheck = null;
  rangeIntro = { controller: ds5 };
  const pinned = $('range-intro-pinned');
  pinned.textContent = knownPinned()
    ? 'An axis reads at the very edge. A stick stuck there may never reach the opposite side, so this may be '
      + 'impossible to finish, and turning the controller off would then be the only way out. We haven’t '
      + 'confirmed yet whether Range helps a stick like this: if you are not sure, use Guided calibration instead.'
    : '';
  pinned.classList.toggle('hidden', !knownPinned());
  setRangeIntro(true);
  openModal('modal-range');
}

function cancelRangeIntro() {
  if (!rangeIntro) return;
  rangeIntro = null;
  closeModal('modal-range');
}

async function startRange() {
  const intro = rangeIntro;
  if (!intro || !ds5 || ds5 !== intro.controller || ops.busy || blockedForPowerCycle()) return;
  rangeIntro = null;
  const controller = ds5;
  const op = ops.beginOp();
  rangeOp = op;
  clearOutcome();
  $('btn-range-start').disabled = true;
  $('btn-range-cancel').disabled = true;
  try {
    await controller.rangeBegin();
  } catch (error) {
    ops.endOp(op);
    if (ds5 === controller) {
      closeModal('modal-range');
      toast(`Failed to start range calibration: ${error.message}`, 5000);
    }
    return;
  } finally {
    $('btn-range-start').disabled = false;
    $('btn-range-cancel').disabled = false;
  }
  if (ds5 !== controller) { ops.endOp(op); return; }
  rangeCheck = null;
  const tracker = createRangeTracker();
  useRangeTracker(tracker);
  rangeSession = { startTs: performance.now(), tracker, controller, op };
  $('range-msg').innerHTML = RANGE_MSG_HTML;
  const done = $('btn-range-done');
  done.disabled = true;
  done.textContent = 'Done';
  resetRangeReadouts('Extremes not reached yet');
  $('range-exit-hint').textContent = RANGE_EXIT_HINT_SESSION;
  setRangeIntro(false);
}

let lastMinmax = 0;
let lastRangeHint = -Infinity;
const RANGE_HINT_MIN_MS = 1000;
function updateRangeUI(ts) {
  if (rangeCheck) { updateRangeCheckUI(ts); return; }
  const st = rangeStatus(rangeSession.tracker, ts - rangeSession.startTs);
  const pct = Math.round(st.coverage * 100);
  $('range-pct').textContent = `Coverage ${pct}%`;
  $('range-bar').style.width = pct + '%';

  if (ts - lastMinmax > 120) {
    lastMinmax = ts;
    // Una direzione è "raggiunta" a 0.9 dell'escursione massima dello stesso
    // stick (range-coverage.js): con la vecchia calibrazione un bordo compresso
    // non arriva mai a ±1.0, ma conta che l'utente l'abbia spinto a fondo.
    const { left: L, right: R } = rangeSession.tracker;
    const ok = (s, d) => !s.missingDirs.includes(d);
    const f = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
    const span = (name, min, max, okMin, okMax) =>
      `<span>${name} <span class="${okMin ? 'edge-ok' : ''}">${f(min)}</span>…`
      + `<span class="${okMax ? 'edge-ok' : ''}">${f(max)}</span></span>`;
    $('range-minmax').innerHTML =
      span('LX', L.min.x, L.max.x, ok(st.left, 'left'), ok(st.left, 'right'))
      + span('LY', L.min.y, L.max.y, ok(st.left, 'up'), ok(st.left, 'down'))
      + span('RX', R.min.x, R.max.x, ok(st.right, 'left'), ok(st.right, 'right'))
      + span('RY', R.min.y, R.max.y, ok(st.right, 'up'), ok(st.right, 'down'));

    let hint;
    if (st.complete) hint = 'All extremes reached, both directions ✓';
    else if (st.degenerate && ts - rangeSession.startTs >= RANGE_DEFAULTS.unlockMs) {
      // Nessuna chiusura con una direzione sotto metà corsa: il range salvato
      // sarebbe degenere. L'unica uscita senza scrivere è spegnere il controller.
      // Che lo spegnimento annulli il range è detto solo con la memoria
      // confermata `locked` (C0-11, H10 non ancora verificato).
      hint = 'Push each stick all the way to every edge before finishing. '
        + (lastNvStatus === 'locked'
          ? 'To leave without changes, turn the controller off (hold PS for 10 s).'
          : 'The only other way out is to turn the controller off (hold PS for 10 s).');
    } else hint = `Missing: ${st.missing.join(', ')}`;
    // #range-hint è role="status": solo traguardi (rangeStatus conta giri
    // interi) e al massimo un cambio al secondo, salvo il completamento. Nel
    // primo giro le quattro direzioni arrivano a ~0.4 s l'una dall'altra: il
    // testo intermedio si fonde nel successivo invece di accodare annunci.
    const el = $('range-hint');
    if (el.textContent !== hint && (st.complete || ts - lastRangeHint >= RANGE_HINT_MIN_MS)) {
      lastRangeHint = ts;
      setLive(el, hint);
    }
  }

  const done = $('btn-range-done');
  done.disabled = !st.canFinish;
  done.textContent = st.finishAnyway ? 'Finish anyway' : 'Done';
}

async function finishRange() {
  if (rangeCheck) { finishRangeCheck(); return; }
  if (!ds5 || !rangeSession) return;
  const session = rangeSession;
  const { controller, op } = session;
  const st = rangeStatus(session.tracker, performance.now() - session.startTs);
  if (!st.canFinish) {
    toast('Rotate both sticks along the edge first: the range is not usable yet.', 5000);
    return;
  }
  let finishAnyway = false;
  if (!st.complete) {
    const what = st.missingDirs.length
      ? `Not reached: ${st.missingDirs.join(', ')}.`
      : 'The sticks were not turned enough in both directions.';
    const go = confirm(`The range calibration is incomplete. ${what} Part of the stick travel may become unreachable. `
      + 'If you finish now, writing to memory stays disabled until you repeat the range calibration. Finish anyway?');
    if (!go || rangeSession !== session) return;
    finishAnyway = true;
  }
  // Campi solo locali: il payload v1 porta soltanto sessioni quick.
  const rangeStats = {
    covL: +st.left.coverage.toFixed(2),
    covR: +st.right.coverage.toFixed(2),
    allEdges: st.missingDirs.length === 0,
    turns: [+st.left.turns.toFixed(1), +st.right.turns.toFixed(1)],
    reversed: st.left.reversed && st.right.reversed,
    finishAnyway,
    ms: Math.round(performance.now() - session.startTs),
  };
  rangeSession = null;
  // Chiave del controller presa prima di ogni await: se si stacca durante il
  // rangeEnd, teardown azzera deviceKey, ma il blocco va comunque registrato
  // per QUESTO controller (è proprio il caso per cui esiste: un rangeEnd
  // incompleto o dall'esito ignoto seguito da un ricollegamento).
  const key = deviceKey;
  // Il blocco si registra anche se il controller non c'è più; se nel frattempo
  // se n'è collegato un altro, gli si applica la stessa regola del
  // ricollegamento (decade solo con un seriale noto e diverso).
  const lockFor = reason => {
    setRangeWriteLock(reason, key);
    if (ds5 && ds5 !== controller) reapplyRangeWriteLock(deviceKey);
  };
  try {
    const { alreadyClosed } = await controller.rangeEnd();
    const gone = ds5 !== controller;
    // code 3: la sessione era già chiusa, questo rangeEnd non ha scritto nulla,
    // ma il range in RAM è ignoto.
    if (alreadyClosed) {
      lockFor('closed');
      // Scollegato durante il rangeEnd: teardown ha già chiuso la UI.
      if (gone) return;
      recordEvent('range', { ...rangeStats, incomplete: finishAnyway, alreadyClosed });
      closeModal('modal-range');
      // Pannello persistente (WS5) al posto del toast.
      showOutcome(rangeOutcomeView({ alreadyClosed: true }));
      log('Range calibration already closed (code 3): nothing committed. Writing to memory disabled.');
      return;
    }
    if (finishAnyway) {
      lockFor('incomplete');
      if (gone) return;
      recordEvent('range', { ...rangeStats, incomplete: finishAnyway, alreadyClosed });
      setUnsaved(true);
      closeModal('modal-range');
      showOutcome(rangeOutcomeView({ incomplete: true }));
      log('Range calibration finished incomplete: writing to memory disabled.');
      ops.endOp(op);
      startDriftTest();
      return;
    }
    // Range completo ma controller già staccato: il blocco (se c'era) resta,
    // per prudenza; lo toglie solo un range completo visto a controller
    // collegato.
    if (gone) return;
    recordEvent('range', { ...rangeStats, incomplete: finishAnyway, alreadyClosed });
    setUnsaved(true);
    // Un range completo sostituisce in RAM quello incompleto: il blocco di
    // QUESTO controller decade (quelli sospesi di altri controller restano).
    setRangeWriteLock(null, key);
    showOutcome(rangeOutcomeView({}));
    log('Range calibration complete.');
    ops.endOp(op);
    startRangeCheck();
  } catch (error) {
    const gone = ds5 !== controller;
    // Un rangeEnd partito (o scaduto) può aver committato. Staccato durante
    // il rangeEnd, l'esito è ignoto comunque: blocco anche senza `committed`.
    if (error.committed || gone) lockFor('error');
    if (gone) return;
    if (error.committed) setUnsaved(true);
    closeModal('modal-range');
    showOutcome(rangeOutcomeView({ error, committed: error.committed === true }));
    log(`Range error: ${error.message}`);
  } finally {
    ops.endOp(op);
    syncBusyTitle();
  }
}

// Verifica del range appena applicato: un altro giro sul bordo, letto con la
// calibrazione nuova, dà l'errore di circolarità RMS sui 36 settori. Nessun
// comando al controller; poi il test drift (il range potrebbe spostare il
// centro: H12, non ancora verificato).
// Riga fissa sotto la barra: durante la sessione dice che non c'è Cancel e
// che l'unica uscita è spegnere il controller. Nel controllo successivo è
// falsa due volte (c'è "Skip check", e spegnere ora butterebbe il range appena
// applicato), quindi si sostituisce e startRange la rimette.
const RANGE_EXIT_HINT_SESSION = 'There is no Cancel: this ends when both sticks have covered the whole edge, or when you turn the controller off (hold PS for 10 s).';
const RANGE_EXIT_HINT_CHECK = 'Nothing is sent to the controller now: rotate once to check, or press Skip check.';

function startRangeCheck() {
  $('range-exit-hint').textContent = RANGE_EXIT_HINT_CHECK;
  const tracker = createRangeTracker();
  rangeCheck = { tracker, result: null };
  useRangeTracker(tracker);
  $('range-msg').innerHTML = '<b>Range applied</b> (temporary until you write it to memory). Now check it: rotate '
    + 'both sticks once more along the edge. Nothing is sent to the controller during the check.';
  resetRangeReadouts('Rotate both sticks once around the edge');
  const done = $('btn-range-done');
  done.disabled = false;
  done.textContent = 'Skip check';
}

// Chiamata a ogni rAF. #range-hint è role="status": come il suggerimento della
// sessione range passa da setLive (scrive solo se il testo cambia) e da un
// cancello di un secondo, altrimenti la riga di circolarità verrebbe
// riannunciata a ogni tick mentre i numeri si muovono.
let lastCheckHint = 0;
function updateRangeCheckUI(ts = performance.now()) {
  const { tracker } = rangeCheck;
  const pct = Math.round(rangeStatus(tracker).coverage * 100);
  setLive($('range-pct'), `Coverage ${pct}%`);
  $('range-bar').style.width = pct + '%';
  const l = circularityRms(tracker.left);
  const r = circularityRms(tracker.right);
  if (l === null || r === null) return;
  rangeCheck.result = [+l.toFixed(1), +r.toFixed(1)];
  if (ts - lastCheckHint < RANGE_HINT_MIN_MS) return;
  lastCheckHint = ts;
  const { min, max } = CIRCULARITY_NORMAL;
  // Percentuali intere nella regione live: con i decimi il testo cambiava a
  // ogni tick mentre i settori si riempiono. Il dato preciso resta in
  // rangeCheck.result.
  setLive($('range-hint'), `Circularity error: L ${Math.round(l)}% · R ${Math.round(r)}% (about ${min}–${max}% is normal)`);
  setLive($('btn-range-done'), 'Run drift test');
}

function finishRangeCheck() {
  const check = rangeCheck;
  rangeCheck = null;
  recordEvent('range-check', { circ: check.result, skipped: check.result === null });
  if (check.result) log(`Range check: circularity error L ${check.result[0]}% · R ${check.result[1]}%.`);
  closeModal('modal-range');
  startDriftTest();
}

/* ============================== modali ============================== */

// L'entrata era animata e l'uscita no: il modale spariva di colpo. L'uscita
// ora è simmetrica ma più corta (l'utente ha già deciso), e `display:none`
// arriva solo a animazione finita.
const MODAL_CLOSE_MS = 160;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const closeTimers = new Map();
const modalReturnFocus = new Map();

// Un elemento conta come focalizzabile solo se è davvero visibile: il filtro
// sulla sola classe `.hidden` dell'elemento lasciava passare i bottoni con un
// antenato nascosto (#game-intro, #game-report-actions), e il primo/ultimo
// elemento della trappola poteva essere invisibile.
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function isShown(el) {
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
  // Senza checkVisibility (browser vecchi, DOM finto dei test): risale gli
  // antenati cercando `.hidden` o l'attributo `hidden`.
  for (let node = el; node && node.classList; node = node.parentNode) {
    if (node.classList.contains('hidden') || node.hidden) return false;
  }
  return true;
}

function visibleFocusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && isShown(el));
}

function activeModalEl() {
  return [...document.querySelectorAll('.modal[aria-modal="true"]')]
    .find(modal => !modal.classList.contains('hidden') && !modal.classList.contains('closing')) ?? null;
}

// Ripiego del fuoco: il pannello ha tabindex=-1. Serve quando nel modale non
// c'è nulla di attivo (range all'apertura, con Done disabilitato) o quando il
// bottone che aveva il fuoco viene disabilitato o nascosto (rapida e wizard in
// corsa, Start del gioco): senza, il fuoco cadeva su BODY, fuori dal modale.
function focusPanel(modal) {
  const panel = modal.querySelector('.modal-panel');
  (panel ?? modal).focus?.({ preventScroll: true });
}

function focusInitial(modal) {
  // `data-autofocus` vince sul primo elemento: WS5 lo mette su Cancel quando
  // il risultato è a rischio e su Close per una partenza già centrata, e
  // quando è su più elementi vince il primo visibile nell'ordine del DOM
  // (Cancel viene prima di "Calibrate now"). Così la rapida non apre più sul
  // checkbox della telemetria, dove Spazio spegneva la condivisione.
  const preferred = [...modal.querySelectorAll('[data-autofocus]')]
    .find(el => !el.disabled && isShown(el));
  const target = preferred ?? visibleFocusables(modal)[0];
  if (target) target.focus({ preventScroll: true });
  else focusPanel(modal);
}

// Riporta il fuoco nel modale se l'elemento attivo non è più raggiungibile:
// disabilitato, nascosto, o fuori dal modale (BODY dopo un disable).
function keepFocusInModal(modal) {
  const active = document.activeElement;
  const panel = modal.querySelector('.modal-panel');
  if (active && active !== document.body && modal.contains?.(active)
      && (active === panel || (!active.disabled && isShown(active)))) return;
  focusPanel(modal);
}

let focusWatch = null;
function watchModalFocus(modal) {
  focusWatch?.disconnect();
  focusWatch = null;
  if (!modal || typeof MutationObserver !== 'function') return;
  // Il disable del bottone attivo non genera eventi di fuoco affidabili:
  // si osservano gli attributi che lo tolgono di mezzo.
  focusWatch = new MutationObserver(() => {
    if (activeModalEl() === modal) keepFocusInModal(modal);
  });
  focusWatch.observe(modal, { subtree: true, attributes: true, attributeFilter: ['disabled', 'class', 'hidden'] });
}

function updateBackgroundInert() {
  const hasModal = [...document.querySelectorAll('.modal[aria-modal="true"]')]
    .some(modal => !modal.classList.contains('hidden') && !modal.classList.contains('closing'));
  // Anche header e avviso telemetria: sono fuori da main, e senza inert Tab e
  // screen reader potevano raggiungerli sotto il backdrop del modale.
  document.querySelector('header')?.toggleAttribute('inert', hasModal);
  document.querySelector('main')?.toggleAttribute('inert', hasModal);
  document.querySelector('footer')?.toggleAttribute('inert', hasModal);
  $('telemetry-notice')?.toggleAttribute('inert', hasModal);
}

function openModal(id) {
  const el = $(id);
  // riapertura durante la chiusura: annulla il timer, o `hidden` arriverebbe dopo
  clearTimeout(closeTimers.get(el));
  closeTimers.delete(el);
  el.classList.remove('closing', 'hidden');
  // Riaprire un modale già aperto non deve sovrascrivere il punto di ritorno
  // con un elemento del modale stesso.
  if (!modalReturnFocus.has(el)) modalReturnFocus.set(el, document.activeElement);
  updateBackgroundInert();
  watchModalFocus(el);
  // Un frame dopo: il layout del modale appena mostrato deve esistere, o
  // checkVisibility vedrebbe ancora tutto nascosto.
  requestAnimationFrame(() => {
    if (activeModalEl() === el) focusInitial(el);
  });
}

function closeModal(id) {
  const el = $(id);
  if (el.classList.contains('hidden') || closeTimers.has(el)) return;
  el.classList.add('closing');
  closeTimers.set(el, setTimeout(() => {
    closeTimers.delete(el);
    el.classList.remove('closing');
    el.classList.add('hidden');
    updateBackgroundInert();
    const previous = modalReturnFocus.get(el);
    modalReturnFocus.delete(el);
    const another = activeModalEl();
    watchModalFocus(another);
    if (!another) previous?.focus?.({ preventScroll: true });
  }, reduceMotion.matches ? 0 : MODAL_CLOSE_MS));
}

// Chiusura secca: si usa nel teardown (controller scollegato), dove la vista
// sottostante cambia sotto i piedi e animare l'uscita mostrerebbe il salto.
function closeAllModals() {
  game?.close(); // ferma il loop rAF del gioco, non solo la classe .hidden
  sensitivityFinder?.close();
  playtest?.close();
  for (const m of document.querySelectorAll('.modal')) {
    clearTimeout(closeTimers.get(m));
    closeTimers.delete(m);
    m.classList.remove('closing');
    m.classList.add('hidden');
    modalReturnFocus.delete(m);
  }
  watchModalFocus(null);
  updateBackgroundInert();
}

/* ============================== accessibilità ============================== */

// Stato annunciabile derivato dal DOM visivo, in un punto solo: chi aggiorna
// le barre (rapida, range, gioco) e i pallini del wizard continua a scrivere
// solo `style.width` e le classi, e non deve ricordarsi l'ARIA. Un osservatore
// per elemento, nessun lavoro per frame: scatta solo quando cambia qualcosa.
function syncProgressBar(bar) {
  const fill = bar.querySelector('i');
  const pct = Math.round(Number.parseFloat(fill?.style.width) || 0);
  const now = String(Math.max(0, Math.min(100, pct)));
  if (bar.getAttribute('aria-valuenow') !== now) bar.setAttribute('aria-valuenow', now);
}

// I pallini sono aria-hidden: il passo arriva come testo. Pallino 0 = intro,
// 1..5 = i cinque passi della procedura.
const WIZARD_STEPS = 5;
function syncWizardStep() {
  const dots = [...$('wizard-dots').children];
  const active = dots.findIndex(dot => dot.classList.contains('active'));
  const text = active <= 0 ? 'Not started' : `Step ${Math.min(active, WIZARD_STEPS)} of ${WIZARD_STEPS}`;
  const el = $('wizard-step');
  if (el.textContent !== text) el.textContent = text;
}

function watchA11yState() {
  if (typeof MutationObserver !== 'function') return;
  for (const bar of document.querySelectorAll('.progress[role="progressbar"]')) {
    const fill = bar.querySelector('i');
    if (!fill) continue;
    new MutationObserver(() => syncProgressBar(bar)).observe(fill, { attributes: true, attributeFilter: ['style'] });
    syncProgressBar(bar);
  }
  new MutationObserver(syncWizardStep)
    .observe($('wizard-dots'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  syncWizardStep();
}
watchA11yState();

/* ============================== reboot ============================== */

async function rebootController() {
  if (!ds5 || ops.busy) return;
  // Un controller avvelenato non riceve più comandi: il riavvio va fatto a mano.
  if (ds5.poisoned) { toast(POISONED_MESSAGE, 7000); return; }
  if (unsaved && !confirm('You have an unsaved calibration: restarting the controller will lose it. Continue?'))
    return;
  const controller = ds5;
  // Il blocco "sessione aperta" si toglie solo con una prova che il riavvio è
  // avvenuto: la disconnessione HID di QUESTO controller entro pochi secondi
  // dal comando (vedi il listener 'disconnect'). Un invio rifiutato a
  // dispositivo aperto non ha riavviato nulla e il blocco resta. Il segno si
  // mette prima dell'invio: la disconnessione può arrivare prima che reboot()
  // ritorni. Se il riavvio c'è stato ma il blocco restasse per errore, il
  // prossimo calibBegin (senza riparazione) verrebbe rifiutato: mai un commit.
  rebootPending = { controller, at: performance.now() };
  const { sent } = await controller.reboot();
  if (ds5 !== controller) {
    toast('Controller restarting: reconnect it once it has powered off.', 5000);
    return;
  }
  if (!sent) {
    rebootPending = null;
    log('Restart not sent: the controller refused the command and is still connected.');
    toast('The restart didn’t reach the controller. Hold PS for 10 s until the light goes out, then turn it on again.', 8000, { alert: true });
    return;
  }
  toast('Restart sent: reconnect the controller once it has powered off.', 5000);
  // la disconnessione fisica arriverà dall'evento hid
}

// Finestra entro cui una disconnessione conta come prova del riavvio.
const REBOOT_DISCONNECT_WINDOW_MS = 5000;
let rebootPending = null; // { controller, at }
function rebootConfirmedBy(controller) {
  const pending = rebootPending;
  if (!pending || pending.controller !== controller) return false;
  rebootPending = null;
  return performance.now() - pending.at <= REBOOT_DISCONNECT_WINDOW_MS;
}

/* ============================== eventi ============================== */

$('btn-connect').addEventListener('click', connect);
// Disconnect chiede conferma come Restart: con una calibrazione non salvata o
// in corso l'utente perde lavoro, e cosa fa lo scollegamento non è verificato.
$('btn-disconnect').addEventListener('click', () => {
  if (ops.busy && !confirm('A calibration is running. Disconnecting now interrupts it. Disconnect anyway?')) return;
  // Con una sessione lasciata aperta, scollegare NON è lo spegnimento che serve:
  // il blocco resta e il testo lo dice invece di lasciarlo intendere.
  if (!ops.busy && powerCycleApplies()) {
    if (!confirm('This controller was left in the middle of a calibration pass. Disconnecting doesn’t turn it off: '
      + 'it will still need a restart (Restart button, or hold PS for 10 s) before you can calibrate or save. '
      + (unsaved ? 'The calibration on it hasn’t been written to memory either. ' : '')
      + 'Disconnect anyway?')) return;
    return disconnect();
  }
  if (!ops.busy && unsaved && !confirm('This calibration hasn’t been written to memory, and disconnecting won’t save it. '
    + 'We haven’t confirmed whether disconnecting discards it. Disconnect anyway?')) return;
  return disconnect();
});
$('btn-serial').addEventListener('click', () => { serialShown = !serialShown; renderSerial(); });
$('calib-outcome').addEventListener('click', event => {
  const action = event.target?.closest?.('[data-outcome-action]')?.dataset.outcomeAction;
  if (action) runOutcomeAction(action);
});
$('btn-session-dismiss').addEventListener('click', () => {
  markTabUnsaved(false);
  $('banner-session').classList.add('hidden');
});
document.addEventListener('visibilitychange', syncBusyTitle);
$('btn-reboot').addEventListener('click', rebootController);
$('btn-retest').addEventListener('click', () => startDriftTest());

$('btn-quick').addEventListener('click', () => {
  // calibrationAllowed: NVS sbloccata / controller avvelenato / firmware vecchio
  // (WS4). blockedForPowerCycle: sessione lasciata aperta da uno stallo (WS1).
  if (!calibrationAllowed() || blockedForPowerCycle()) return;
  resetQuickModal();
  $('quick-msg').innerHTML = QUICK_INTRO;
  openQuickModal();
});
$('btn-quick-cancel').addEventListener('click', cancelQuickCalibration);
$('btn-quick-go').addEventListener('click', quickCalibrate);

$('btn-wizard').addEventListener('click', () => (calibrationAllowed() ? openWizard() : undefined));
$('btn-wizard-cancel').addEventListener('click', () => closeModal('modal-wizard'));
$('btn-wizard-next').addEventListener('click', wizardNext);
$('btn-wizard-escape').addEventListener('click', wizardEscape);

$('btn-range').addEventListener('click', () => (calibrationAllowed() ? openRange() : undefined));
$('btn-range-done').addEventListener('click', finishRange);
$('btn-range-start').addEventListener('click', startRange);
$('btn-range-cancel').addEventListener('click', cancelRangeIntro);

$('btn-flash').addEventListener('click', openFlashModal);
// Seconda conferma per un risultato a rischio: Write si attiva solo spuntata.
$('flash-ack').addEventListener('change', () => {
  if (!$('flash-warning').classList.contains('hidden')) $('btn-flash-go').disabled = !$('flash-ack').checked;
});
$('btn-flash-cancel').addEventListener('click', () => closeModal('modal-flash'));
$('btn-flash-go').addEventListener('click', doFlash);

// Test di precisione: il gioco legge solo gli stick (deps), nessun comando HID.
// I campioni arrivano per input report (stickSource), mai per frame; il
// seriale serve solo alla chiave locale salata di "Previous" (game.js).
const game = initGame({
  getSticks: () => sticks,
  subscribe: fn => stickSource.subscribe(() => fn(sticks, performance.now())),
  getSerial: () => deviceInfo?.serial ?? null,
  isAvailable: () => !!ds5 && !ops.busy,
  onReport: res => recordEvent('game', res),
  showModal: () => openModal('modal-game'),
  hideModal: () => closeModal('modal-game'),
});
function openGame(bypassGate = false) {
  if (!bypassGate && (!ds5 || ops.busy)) return;
  cancelDriftTest(); // libera la card drift dal suo loop prima di giocare
  game.open(bypassGate);
}
$('btn-game').addEventListener('click', () => openGame());

// Sensitivity Finder: usa esclusivamente lo stick destro e conserva il report
// nel browser. Non modifica la calibrazione e non richiede servizi esterni.
const sensitivityFinder = initSensitivityFinder({
  getSticks: () => sticks,
  isAvailable: () => !!ds5 && !ops.busy,
  getMeasuredRightDrift: () => lastDriftResult
    ? { ...lastDriftResult.right, unstable: lastDriftResult.unstable === true }
    : null,
  showModal: () => openModal('modal-sensitivity'),
  hideModal: () => closeModal('modal-sensitivity'),
});
function openSensitivityFinder(bypassGate = false) {
  if (!bypassGate && (!ds5 || ops.busy)) return;
  cancelDriftTest();
  sensitivityFinder.open(bypassGate);
}

const playtest = initPlaytest({
  getSticks: () => sticks,
  isAvailable: () => !!ds5 && !ops.busy,
  showModal: () => openModal('modal-playtest'),
  hideModal: () => closeModal('modal-playtest'),
  onReport: result => recordEvent('playtest', result),
});
function openPlaytest(bypassGate = false) {
  if (!bypassGate && (!ds5 || ops.busy)) return;
  cancelDriftTest();
  playtest.open(bypassGate);
}

function updateToolSwitch(mode) {
  for (const button of document.querySelectorAll('[data-tool]')) {
    const active = button.dataset.tool === mode;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function switchControllerTool(mode, bypassGate = false) {
  if (mode !== 'calibration' && !EXPERIMENTAL_PREVIEW) return;
  if (!bypassGate && (!ds5 || ops.busy)) return;
  if (mode === 'calibration') {
    sensitivityFinder.close();
    playtest.close();
  } else if (mode === 'sensitivity') {
    playtest.close();
    openSensitivityFinder(bypassGate);
  } else if (mode === 'playtest') {
    sensitivityFinder.close();
    openPlaytest(bypassGate);
  } else return;
  updateToolSwitch(mode);
}

$('btn-sensitivity').addEventListener('click', () => switchControllerTool('sensitivity'));
$('btn-playtest').addEventListener('click', () => switchControllerTool('playtest'));
$('btn-sensitivity-exit').addEventListener('click', () => updateToolSwitch('calibration'));
$('btn-playtest-exit').addEventListener('click', () => switchControllerTool('calibration', true));
for (const button of document.querySelectorAll('[data-tool]')) {
  button.addEventListener('click', () => {
    switchControllerTool(button.dataset.tool, EXPERIMENTAL_PREVIEW);
  });
}

// avvisa prima di chiudere la pagina con modifiche non salvate
window.addEventListener('beforeunload', e => {
  if (unsaved || ops.busy) { e.preventDefault(); e.returnValue = ''; }
});

/* ============================== consenso telemetria ============================== */

// Due checkbox sincronizzate (dialogo calibrazione rapida + footer):
// stesso stato in localStorage, cambiarne una aggiorna l'altra.
const consentBoxes = ['telemetry-consent', 'telemetry-consent-footer'].map($).filter(Boolean);
function setConsent(on) {
  storageWrite(TELEMETRY_CONSENT_KEY, on ? '1' : '0');
  for (const box of consentBoxes) box.checked = on;
}
for (const box of consentBoxes) {
  box.checked = telemetryEnabled();
  box.addEventListener('change', () => setConsent(box.checked));
}

// Spazio che l'avviso telemetria occupa in basso, in --notice-space: il CSS lo
// riserva come scroll-padding-bottom della pagina e come padding in fondo al
// body. Senza, su telefono il pannello dell'esito scorreva in vista con i suoi
// bottoni (Guided, recovery) sotto l'avviso, un foglio fisso di ~250 px.
function syncNoticeSpace() {
  const el = $('telemetry-notice');
  const root = document.documentElement;
  if (!el || !root?.style?.setProperty) return;
  let space = 0;
  if (!el.classList.contains('hidden') && typeof getComputedStyle === 'function')
    space = Math.ceil((el.offsetHeight || 0) + (parseFloat(getComputedStyle(el).bottom) || 0));
  root.style.setProperty('--notice-space', `${space}px`);
}

// Avviso una tantum al primo avvio. Banner persistente, non un toast che
// scompare: è una scelta da fare, e finché non è fatta niente lascia il browser.
function resolveNotice(keepSharing) {
  storageWrite(TELEMETRY_NOTICE_KEY, '1');
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
    syncNoticeSpace();
  }, reduceMotion.matches ? 0 : 180);
}

// Senza WebHID non esiste controller, quindi nessun evento può essere prodotto
// e non c'è niente da divulgare: mostrare l'avviso sarebbe solo attrito per chi
// apre il link dal telefono. Il flag resta non impostato, così la scelta viene
// chiesta davvero la prima volta che la pagina si apre su un browser che può
// usare il tool. L'opt-out nel footer resta comunque visibile e funzionante.
if (navigator.hid && telemetryEnabled() && !noticeSeen()) {
  $('telemetry-notice').classList.remove('hidden');
  syncNoticeSpace();
  // L'altezza cambia con la larghezza (testo che va a capo, bottom sheet sotto
  // i 560 px): si rimisura a ogni cambio di dimensione dell'avviso.
  if (typeof ResizeObserver === 'function') new ResizeObserver(syncNoticeSpace).observe($('telemetry-notice'));
  else window.addEventListener('resize', syncNoticeSpace);
  $('btn-notice-ok').addEventListener('click', () => resolveNotice(true));
  $('btn-notice-optout').addEventListener('click', () => resolveNotice(false));
  requestAnimationFrame(() => $('btn-notice-optout').focus());
}

/* ============================== tastiera ============================== */

// Esc chiude solo ciò che è annullabile senza lasciare il controller in uno
// stato inconsistente: mai durante una calibrazione (`busy`), e sul range solo
// nel passo introduttivo, prima di rangeBegin (una sessione aperta va chiusa
// con rangeEnd, non abbandonata: allora Cancel è nascosto ed Esc non fa nulla).
const ESC_DISMISS = {
  'modal-range': 'btn-range-cancel',
  'modal-quick': 'btn-quick-cancel',
  'modal-wizard': 'btn-wizard-cancel',
  'modal-flash': 'btn-flash-cancel',
  'modal-game': 'btn-game-exit',
  'modal-sensitivity': 'btn-sensitivity-exit',
  'modal-playtest': 'btn-playtest-exit',
};

document.addEventListener('keydown', e => {
  const activeModal = activeModalEl();
  if (e.key === 'Tab' && activeModal) {
    // Trappola completa: con zero elementi, o con il fuoco sul pannello o
    // fuori dal modale, Tab non esce mai verso header, avviso o BODY.
    const focusable = visibleFocusables(activeModal);
    const active = document.activeElement;
    const index = focusable.indexOf(active);
    if (!focusable.length) { e.preventDefault(); focusPanel(activeModal); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (index === -1) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.key !== 'Escape' || ops.busy) return;
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
  // Una calibrazione di un caricamento precedente di questa scheda, mai
  // scritta né scartata di sicuro: può essere ancora attiva sul controller.
  if (tabUnsavedFlag()) $('banner-session').classList.remove('hidden');
  if (!navigator.hid) {
    showUnsupported();
    if (location.protocol === 'file:') {
      showHeroError('<b>Opened from file://.</b> WebHID needs a secure context: serve the folder over HTTP (e.g. <code>python3 -m http.server</code>).');
    }
    return;
  }

  navigator.hid.addEventListener('disconnect', e => {
    if (adopting && e.device === adopting.device) adopting.aborted = true;
    if (ds5 && e.device === ds5.device) {
      // Disconnessione subito dopo un Restart inviato: il riavvio è avvenuto e
      // ha chiuso la sessione lasciata aperta.
      if (rebootConfirmedBy(ds5) && powerCycleApplies())
        clearPowerCycle('Restart confirmed by the disconnect: the restart should have closed the calibration pass left open (a session still open would be refused, never committed).');
      log('Controller disconnected.');
      teardown('Controller disconnected.');
    }
  });

  // Un controller già autorizzato che torna (riavvio, cavo ricollegato) si
  // riaggancia da solo, senza passare dal selettore del browser.
  navigator.hid.addEventListener('connect', e => {
    if (ds5 || adopting || !isDualSense(e.device)) return;
    log('DualSense reconnected: connecting automatically…');
    adopt(e.device).catch(autoConnectFailed);
  });

  // riconnessione automatica se il permesso è già stato concesso; tra più
  // DualSense autorizzati si preferisce quello via USB
  try {
    const devices = (await navigator.hid.getDevices()).filter(isDualSense);
    const known = devices.find(isUsbDevice) ?? devices[0];
    if (known) {
      log('DualSense already authorized: connecting automatically…');
      await adopt(known);
    }
  } catch (error) {
    autoConnectFailed(error);
  }
}

// Un'apertura fallita (controller tenuto da Steam o da un'altra tab) prima
// finiva solo nel log: la hero restava muta.
function autoConnectFailed(error) {
  log(`Auto-connection failed: ${error.name ? `${error.name}: ` : ''}${error.message || error}`);
  if (ds5) return;
  showConnectError(error);
}

boot();

// Hook di sviluppo: simula la posizione degli stick senza controller.
window.__senseSimulate = (lx, ly, rx, ry) => { sticks = { lx, ly, rx, ry }; notifyStickSample(); };
window.__senseExtractStable = extractStableSamples;
window.__senseWaitForStable = waitForStable;
// Storico locale delle calibrazioni (telemetria per futura calibrazione ML).
window.__senseCalibSessions = () => JSON.parse(storageRead(CALIB_STORE_KEY, '[]'));
window.__senseDials = { dialL, dialR, dialWizL, dialWizR, dialRangeL, dialRangeR };
// Apre il gioco bypassando il gate isAvailable: utile per testare senza controller
// in coppia con __senseSimulate.
window.__senseGameOpen = () => openGame(true);
if (EXPERIMENTAL_PREVIEW) {
  // Preview condivisibile senza HID per controllare gli esperimenti in sviluppo.
  // __senseSimulate alimenta gli stick senza un controller collegato.
  window.__senseSensitivityOpen = () => openSensitivityFinder(true);
  window.__sensePlaytestOpen = () => switchControllerTool('playtest', true);
  if (location.hash === '#sensitivity-demo') openSensitivityFinder(true);
  if (location.hash === '#playtest-demo') switchControllerTool('playtest', true);
}

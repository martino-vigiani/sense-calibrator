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
import { measureOffset as measureOffsetFrom, waitForStable as waitForStableFrom } from './calib/sampling.js';
import { runQuick } from './calib/quick.js';
import { createOpGate } from './calib/ops.js';
import { CENTERED_MAX, LSB_PCT, formatOffset } from './calib/lattice.js';
import {
  driftMessage, flashSummary, guidedOutcomeView, outcomeHtml, outcomeLogLine, quickOutcomeView, rangeOutcomeView,
  revertAdvice, writeLockFor,
} from './ui/outcome.js';
import { HANDS_OFF_LABELS, createHandsOffMeter, renderHandsOff } from './ui/hands-off.js';
import { CONNECT_CHECKLIST, connectErrorCopy } from './ui/connect-help.js';

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

// Calibrazione range
const RANGE_BINS = 36;
const RANGE_RADIUS_OK = 0.8;
const RANGE_UNLOCK_MS = 15000;

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
    const nv = await refreshNv();
    if (ds5 !== candidate) return;

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

  if (rangeSession) {
    for (const a of ['lx', 'ly', 'rx', 'ry']) {
      const v = sticks[a];
      if (v < rangeSession.stats[a].min) rangeSession.stats[a].min = v;
      if (v > rangeSession.stats[a].max) rangeSession.stats[a].max = v;
    }
  }

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
const handsOff = createHandsOffMeter();
function handsOffTarget() {
  if (!$('modal-quick').classList.contains('hidden')) return ['quick-handsoff', HANDS_OFF_LABELS.quick];
  if (!$('modal-wizard').classList.contains('hidden')) return ['wizard-handsoff', HANDS_OFF_LABELS.guided];
  return null;
}
function feedHandsOff(now) {
  const target = handsOffTarget();
  if (!target) return;
  renderHandsOff($(target[0]), handsOff.push(sticks, now), target[1]);
}
function resetHandsOff() {
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
  $('drift-status').textContent = driftMessage(result, { previous: prev, unsaved }).text;
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
let lastCenterView = null;

function currentWriteLock() {
  return writeLockFor({
    center: centerState,
    range: rangeState,
    poisoned: !!ds5?.poisoned,
    needsPowerCycle: !!ds5 && ds5 === powerCycleController,
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
function showOutcome(view) {
  if (view.center) { centerState = view.center; lastCenterView = view; }
  if (view.range) rangeState = view.range;
  const el = $('calib-outcome');
  el.dataset.tone = view.tone;
  el.innerHTML = outcomeHtml(view);
  el.classList.remove('hidden');
  el.scrollIntoView?.({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
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
  if (!ds5 || ops.busy || blockedForPowerCycle()) return;
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
// Controller con una sessione di calibrazione lasciata aperta da uno stallo:
// nessun comando di calibrazione o scrittura finché non viene riavviato e
// ricollegato (un nuovo DS5 è un oggetto diverso, quindi il blocco decade da
// solo alla riconnessione).
let powerCycleController = null;

function blockedForPowerCycle() {
  if (!ds5 || ds5 !== powerCycleController) return false;
  toast('Restart the controller (hold PS for 10 s) and reconnect it before calibrating or saving again.', 6000);
  return true;
}

const QUICK_INTRO = 'Rest the controller on a stable surface and <b>don’t touch the sticks</b>.';
function resetQuickModal() {
  quickForceNext = false;
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
  // Il controller catturato è l'UNICO bersaglio dei comandi: dopo un replug a
  // metà passata il ciclo non deve pilotare il controller nuovo (prima usava
  // il `ds5` globale). runQuick controlla isCurrent() dopo ogni await.
  const controller = ds5;
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
  const msg = $('quick-msg');
  $('btn-quick-go').disabled = true;
  $('btn-quick-cancel').disabled = true;
  let blockedMessage = null;
  let run = null;
  const fail = (session, error, committed) => {
    if (!ops.isCurrent(op)) { recordSessionOnce(session); return; }
    ops.endOp(op);
    // La RAM del controller è cambiata se una passata precedente ha già chiuso
    // con calibEnd (un errore alla passata 2 non la annulla), oppure se la
    // riparazione di calibBegin ha committato prima che la calibrazione partisse.
    if (committed) setUnsaved(true);
    session.aborted = 'error';
    session.err = String(error.message || error).slice(0, 120);
    recordSessionOnce(session);
    closeModal('modal-quick');
    showOutcome(quickOutcomeView({ outcome: 'error', error, committed, worst: null, session }, { nvStatus: lastNvStatus }));
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
      onProgress: event => {
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
      // un altro controller, quindi qui si registra soltanto.
      recordSessionOnce(session);
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
      powerCycleController = controller;
      setUnsaved(true);
      closeModal('modal-quick');
      showOutcome(quickOutcomeView(run, { nvStatus: lastNvStatus }));
      log('Quick calibration abandoned mid-pass: controller needs a restart.');
      return;
    }
    if (outcome === 'preflight') {
      quickPreflightBlocked = true;
      recordSessionOnce(session);
      blockedMessage = 'Calibration has not started. <b>Release both sticks</b> and keep the controller still, then try again. Check the USB connection if readings have stopped. If a released stick stays far from center, use guided calibration.';
      log('Quick calibration not started: centered, stable stick readings are required.');
      return;
    }
    if (outcome === 'error') {
      fail(session, run.error, run.committed);
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
      wizard.op = ops.beginOp();
      clearOutcome();
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
      setUnsaved(true);
      const wizAfter = summarizeResult(await measureOffset());
      ops.endOp(wizard.op);
      wizard.reported = true;
      recordEvent('wizard', { done: true, before: wizard.before ?? null, after: wizAfter });
      $('wizard-diagram').classList.add('hidden');
      wizardHideLive();
      // Prima e dopo nel pannello persistente, con lo stesso blocco di Write
      // della rapida (peggiore dell'inizio, ≥15%, asse incollato).
      const view = guidedOutcomeView({ before: wizard.before ?? null, after: wizAfter }, { nvStatus: lastNvStatus });
      showOutcome(view);
      $('wizard-msg').textContent = `${view.title}. The result stays on the page after you close this.`;
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
    ops.endOp(wizard?.op);
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
    showOutcome(guidedOutcomeView({ before: wizard?.before ?? null, error, committed: error.committed === true }, { nvStatus: lastNvStatus }));
    log(`Wizard error: ${error.message}`);
  } finally {
    btn.disabled = false;
    syncBusyTitle();
  }
}

function openWizard() {
  if (!ds5 || ops.busy || blockedForPowerCycle()) return;
  cancelDriftTest();
  wizard = { step: 0 };
  wizardSetDots(0);
  wizardHideLive();
  $('wizard-diagram').classList.add('hidden');
  $('wizard-msg').innerHTML = 'This procedure re-centers the sticks by sampling their resting position after each movement. Once started it <b>cannot be cancelled</b>: don’t close the page and don’t disconnect the controller.';
  $('btn-wizard-next').textContent = 'Start';
  $('btn-wizard-cancel').classList.remove('hidden');
  resetHandsOff();
  openModal('modal-wizard');
}

/* ============================== range ============================== */

let rangeSession = null; // { startTs }
let rangeOp = null; // token di ops: la sessione range occupa il controller fino a finishRange

async function openRange() {
  if (!ds5 || ops.busy || blockedForPowerCycle()) return;
  cancelDriftTest();
  rangeOp = ops.beginOp();
  clearOutcome();
  try {
    await ds5.rangeBegin();
  } catch (error) {
    ops.endOp(rangeOp);
    toast(`Failed to start range calibration: ${error.message}`, 5000);
    return;
  }
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
    setLive($('range-hint'), rangeSession.allEdges
      ? 'All extremes reached ✓'
      : `Missing: ${missing.join(', ')}`);
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
    const { alreadyClosed } = await ds5.rangeEnd();
    recordEvent('range', { ...rangeStats, incomplete, alreadyClosed });
    closeModal('modal-range');
    // Pannello persistente e blocco di Write: un range incompleto (o chiuso
    // con "Finish anyway") o già chiuso dal firmware non si scrive.
    showOutcome(rangeOutcomeView({ incomplete, alreadyClosed }));
    // code 3: la sessione era già chiusa, questo rangeEnd non ha scritto nulla.
    if (alreadyClosed) {
      log('Range calibration already closed (code 3): nothing committed.');
      return;
    }
    setUnsaved(true);
    log(incomplete ? 'Range calibration applied with incomplete coverage.' : 'Range calibration complete.');
  } catch (error) {
    // Un rangeEnd partito (o scaduto) può aver committato.
    if (error.committed) setUnsaved(true);
    closeModal('modal-range');
    showOutcome(rangeOutcomeView({ error, committed: error.committed === true }));
    log(`Range error: ${error.message}`);
  } finally {
    ops.endOp(rangeOp);
    syncBusyTitle();
  }
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
  await ds5.reboot();
  toast('Controller restarted: reconnect it once it has powered off.', 5000);
  // la disconnessione fisica arriverà dall'evento hid
}

/* ============================== eventi ============================== */

$('btn-connect').addEventListener('click', connect);
// Disconnect chiede conferma come Restart: con una calibrazione non salvata o
// in corso l'utente perde lavoro, e cosa fa lo scollegamento non è verificato.
$('btn-disconnect').addEventListener('click', () => {
  if (ops.busy && !confirm('A calibration is running. Disconnecting now interrupts it. Disconnect anyway?')) return;
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

$('btn-range').addEventListener('click', () => (calibrationAllowed() ? openRange() : undefined));
$('btn-range-done').addEventListener('click', finishRange);

$('btn-flash').addEventListener('click', openFlashModal);
// Seconda conferma per un risultato a rischio: Write si attiva solo spuntata.
$('flash-ack').addEventListener('change', () => {
  if (!$('flash-warning').classList.contains('hidden')) $('btn-flash-go').disabled = !$('flash-ack').checked;
});
$('btn-flash-cancel').addEventListener('click', () => closeModal('modal-flash'));
$('btn-flash-go').addEventListener('click', doFlash);

// Test di precisione: il gioco legge solo gli stick (deps), nessun comando HID.
const game = initGame({
  getSticks: () => sticks,
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
  requestAnimationFrame(() => $('btn-notice-optout').focus());
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

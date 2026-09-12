'use strict';

/* ============================================================
   Sensitivity Finder — laboratorio di mira adattivo.

   Il modulo non invia dati e non tocca l'HID: legge solo lo stick destro
   attraverso getSticks(). Tre round con velocita diverse misurano errore di
   tracking, direzione delle correzioni e lavoro richiesto allo stick. Il
   modello locale produce prima un profilo universale e, solo quando richiesto,
   lo converte nella scala di un gioco specifico.

   Le raccomandazioni sono un punto di partenza spiegabile, non fingono di
   sostituire FOV, aim assist e sensazioni dentro al gioco reale.
   ============================================================ */

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const roundTo = (v, digits = 0) => {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};

const TRIAL_MS = 9000;
const TRIAL_SETTLE_MS = 650;
const COUNTDOWN_MS = 2100;
const ROUND_MULTIPLIERS = [0.76, 1, 1.26];
const MIN_VALID_SAMPLES = 240;
const MAX_FRAME_GAP_MS = 250;
const STORAGE_KEY = 'senseSensitivityLast.v1';

export const GAME_PROFILES = Object.freeze({
  general: {
    name: 'Universal FPS profile',
    base: null,
  },
  fortnite: {
    name: 'Fortnite',
    base: { look: 42, ads: 10 },
  },
  warzone: {
    name: 'Call of Duty / Warzone',
    base: { look: 6, ads: 0.85 },
  },
  apex: {
    name: 'Apex Legends',
    base: { look: 4, ads: 3 },
  },
});

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

export function summarizeSensitivityTrial(raw) {
  const errors = raw.errors || [];
  const alignments = raw.alignments || [];
  const inputs = raw.inputs || [];
  const mean = values => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
  const meanError = mean(errors);
  const meanAlignment = mean(alignments);
  const meanInput = mean(inputs);
  const seconds = Math.max(1, (raw.durationMs || TRIAL_MS) / 1000);
  const reversalsPerSecond = (raw.reversals || 0) / seconds;
  const accuracy = clamp(1 - meanError / 0.82, 0, 1);
  const direction = clamp((meanAlignment + 1) / 2, 0, 1);
  const correctionPenalty = clamp((reversalsPerSecond - 2.4) / 8, 0, 0.12);
  const score = Math.round(clamp((accuracy * 0.78 + direction * 0.22 - correctionPenalty) * 100, 0, 100));

  return {
    multiplier: raw.multiplier,
    score,
    meanError: roundTo(meanError, 3),
    p75Error: roundTo(percentile(errors, 0.75), 3),
    meanAlignment: roundTo(meanAlignment, 3),
    meanInput: roundTo(meanInput, 3),
    reversalsPerSecond: roundTo(reversalsPerSecond, 2),
    samples: errors.length,
  };
}

function responseCurveFor(trial) {
  return trial.reversalsPerSecond > 4.8 || trial.meanAlignment < 0.45
    ? 'Progressive'
    : 'Direct';
}

function styleFor(trial) {
  if (trial.meanInput > 0.62) return 'Committed tracker';
  if (trial.reversalsPerSecond > 4.8) return 'Reactive corrector';
  if (trial.meanError < 0.2) return 'Precision tracker';
  return 'Balanced aimer';
}

export function buildUniversalSensitivityProfile(trials, options = {}) {
  if (!Array.isArray(trials) || trials.length !== ROUND_MULTIPLIERS.length) {
    throw new Error('Three completed trials are required');
  }
  if (trials.some(trial => !Number.isFinite(trial.score)
      || !Number.isFinite(trial.samples) || trial.samples < MIN_VALID_SAMPLES)) {
    throw new Error('Each trial needs enough valid samples');
  }

  const ranked = [...trials].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const maxScore = best.score;
  let weightTotal = 0;
  let weightedMultiplier = 0;
  for (const trial of trials) {
    const weight = Math.exp((trial.score - maxScore) / 9);
    weightTotal += weight;
    weightedMultiplier += trial.multiplier * weight;
  }

  let multiplier = weightedMultiplier / weightTotal;
  // Se il test migliore richiede quasi sempre fondo corsa, una sensibilita
  // appena piu alta riduce lo sforzo. Molte correzioni suggeriscono il contrario.
  if (best.meanInput > 0.66) multiplier *= 1.05;
  if (best.reversalsPerSecond > 5.5) multiplier *= 0.96;
  multiplier = clamp(multiplier, 0.72, 1.34);

  const gap = ranked.length > 1 ? best.score - ranked[1].score : 0;
  const meanScore = trials.reduce((sum, trial) => sum + trial.score, 0) / trials.length;
  const confidence = Math.round(clamp(24 + meanScore * 0.38 + gap * 1.2
    + Math.min(14, best.samples / MIN_VALID_SAMPLES * 14), 24, 92));
  const evidence = confidence >= 76 ? 'Strong separation'
    : confidence >= 58 ? 'Usable separation'
      : 'Close result';
  const curve = responseCurveFor(best);
  const drift = options.measuredRightDrift;
  const rightDeadzone = drift && !drift.unstable
    ? clamp(Math.ceil(drift.offset + drift.noise * 2), 2, 15)
    : null;
  const lookIndex = clamp(Math.round(50 * multiplier), 36, 68);
  const adsRatio = roundTo(clamp(0.82 * Math.sqrt(multiplier), 0.7, 0.98), 2);

  return {
    multiplier: roundTo(multiplier, 2),
    lookIndex,
    adsRatio,
    curve,
    rightDeadzone,
    evidence,
    style: styleFor(best),
    bestRound: ROUND_MULTIPLIERS.indexOf(best.multiplier) + 1,
    best,
  };
}

export function buildSensitivityRecommendation(gameId, trials, options = {}) {
  const resolvedGameId = GAME_PROFILES[gameId] ? gameId : 'general';
  const profile = GAME_PROFILES[resolvedGameId];
  const universal = buildUniversalSensitivityProfile(trials, options);
  const { multiplier, curve, rightDeadzone } = universal;
  let settings;

  if (resolvedGameId === 'general') {
    settings = [
      ['Universal look index', `${universal.lookIndex} / 100`],
      ['ADS ratio', `${universal.adsRatio.toFixed(2)}× look speed`],
      ['Response curve', curve],
      ['Right-stick deadzone', rightDeadzone == null ? 'Run drift test first' : `${rightDeadzone}% measured`],
    ];
  } else if (resolvedGameId === 'warzone') {
    settings = [
      ['Horizontal stick', String(clamp(Math.round(profile.base.look * multiplier), 4, 10))],
      ['Vertical stick', String(clamp(Math.round(profile.base.look * multiplier), 4, 10))],
      ['ADS multiplier', roundTo(clamp(profile.base.ads * Math.sqrt(multiplier), 0.7, 1.05), 2).toFixed(2)],
      ['Aim response', curve === 'Direct' ? 'Dynamic' : 'Standard'],
      ['Right min deadzone', rightDeadzone == null ? 'Measure first' : `${rightDeadzone}%`],
    ];
  } else if (resolvedGameId === 'apex') {
    settings = [
      ['Look sensitivity', String(clamp(Math.round(profile.base.look * multiplier), 2, 7))],
      ['ADS sensitivity', String(clamp(Math.round(profile.base.ads * multiplier), 2, 6))],
      ['Response curve', curve === 'Direct' ? 'Linear' : 'Classic'],
      ['Look deadzone', rightDeadzone == null ? 'Measure first' : (rightDeadzone <= 6 ? 'None' : 'Small')],
    ];
  } else {
    settings = [
      ['Look horizontal', `${clamp(Math.round(profile.base.look * multiplier), 28, 62)}%`],
      ['Look vertical', `${clamp(Math.round(profile.base.look * multiplier), 28, 62)}%`],
      ['ADS sensitivity', `${clamp(Math.round(profile.base.ads * Math.sqrt(multiplier)), 6, 16)}%`],
      ['Input curve', curve === 'Direct' ? 'Linear' : 'Exponential'],
      ['Right deadzone', rightDeadzone == null ? 'Measure first' : `${rightDeadzone}%`],
    ];
  }

  return {
    ...universal,
    gameId: resolvedGameId,
    game: profile.name,
    settings,
  };
}

class AimCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.dpr = 0;
    this.applyDpr();
  }

  applyDpr() {
    const dpr = window.devicePixelRatio || 1;
    if (dpr === this.dpr) return;
    this.dpr = dpr;
    this.canvas.width = this.width * dpr;
    this.canvas.height = this.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(target, cursor, trail, countdown = '') {
    this.applyDpr();
    const { ctx, width: w, height: h } = this;
    const px = point => ({ x: (point.x * 0.5 + 0.5) * w, y: (point.y * 0.5 + 0.5) * h });
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#090b0a';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(216,255,87,.09)';
    ctx.lineWidth = 1;
    for (let x = 40; x < w; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 40; y < h; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    if (trail.length > 1) {
      ctx.beginPath();
      trail.forEach((point, index) => {
        const p = px(point);
        if (index === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.strokeStyle = 'rgba(255,255,255,.24)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const t = px(target);
    ctx.strokeStyle = '#d8ff57';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(t.x, t.y, 15, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(216,255,87,.18)';
    ctx.beginPath(); ctx.arc(t.x, t.y, 7, 0, Math.PI * 2); ctx.fill();

    const c = px(cursor);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x - 11, c.y); ctx.lineTo(c.x + 11, c.y);
    ctx.moveTo(c.x, c.y - 11); ctx.lineTo(c.x, c.y + 11);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.stroke();

    if (countdown) {
      ctx.fillStyle = '#fff';
      ctx.font = '700 64px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(countdown, w / 2, h / 2);
    }
  }
}

function targetAt(ms, roundIndex) {
  const t = ms / 1000;
  return {
    x: Math.sin(t * 0.78 + roundIndex * 0.7) * 0.68,
    y: Math.sin(t * 1.13 + 0.8 + roundIndex * 0.35) * 0.5,
  };
}

function shapedStick(x, y) {
  const mag = Math.hypot(x, y);
  if (mag <= 0.08) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.pow(clamp((mag - 0.08) / 0.92, 0, 1), 1.35);
  return { x: x / mag * scaled, y: y / mag * scaled, mag: scaled };
}

export function initSensitivityFinder(deps) {
  const modal = $('modal-sensitivity');
  const canvas = new AimCanvas($('sensitivity-canvas'));
  const setup = $('sensitivity-setup');
  const run = $('sensitivity-run');
  const report = $('sensitivity-report');
  const progress = $('sensitivity-progress').querySelector('i');
  const status = $('sensitivity-status');
  const scoreLive = $('sensitivity-live-score');
  const btnStart = $('btn-sensitivity-start');
  const btnExit = $('btn-sensitivity-exit');
  const btnRetry = $('btn-sensitivity-retry');
  const btnChange = $('btn-sensitivity-change');
  const gameButtons = [...document.querySelectorAll('[data-sensitivity-game]')];

  let selectedGame = 'general';
  let rafId = null;
  let state = null;
  let trials = [];
  let running = false;
  let lastTs = 0;
  let transitionTimer = null;
  let cursor = { x: 0, y: 0 };
  let trail = [];
  let invalidReason = '';

  function selectGame(gameId) {
    if (!GAME_PROFILES[gameId]) return;
    selectedGame = gameId;
    const presets = document.querySelector('.sensitivity-presets');
    if (gameId === 'general') presets?.removeAttribute('open');
    else presets?.setAttribute('open', '');
    for (const button of gameButtons) {
      const active = button.dataset.sensitivityGame === gameId;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    }
  }

  function showSetup() {
    running = false;
    state = null;
    setup.classList.remove('hidden');
    run.classList.add('hidden');
    report.classList.add('hidden');
    const previous = loadPrevious();
    if (previous?.gameId && GAME_PROFILES[previous.gameId]) selectGame(previous.gameId);
  }

  function startLoop() {
    if (rafId != null) return;
    const tick = ts => {
      rafId = requestAnimationFrame(tick);
      step(ts);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function beginSequence() {
    setup.classList.add('hidden');
    report.classList.add('hidden');
    run.classList.remove('hidden');
    trials = [];
    invalidReason = '';
    running = true;
    beginCountdown(0);
  }

  function beginCountdown(roundIndex) {
    cursor = { x: 0, y: 0 };
    trail = [];
    lastTs = performance.now();
    state = { kind: 'countdown', roundIndex, start: performance.now() };
    status.textContent = `Round ${roundIndex + 1} of ${ROUND_MULTIPLIERS.length} · get ready`;
    progress.style.width = `${roundIndex / ROUND_MULTIPLIERS.length * 100}%`;
    scoreLive.textContent = '—';
  }

  function beginTrial(roundIndex, ts) {
    const multiplier = ROUND_MULTIPLIERS[roundIndex];
    state = {
      kind: 'trial', roundIndex, multiplier, start: ts,
      errors: [], alignments: [], inputs: [], reversals: 0,
      previousInput: { x: 0, y: 0 },
    };
    status.textContent = `Round ${roundIndex + 1} of ${ROUND_MULTIPLIERS.length} · keep the white reticle on the green target`;
    lastTs = ts;
  }

  function finishTrial(ts) {
    const summary = summarizeSensitivityTrial({
      ...state,
      durationMs: ts - state.start,
    });
    if (summary.samples < MIN_VALID_SAMPLES) {
      invalidReason = 'This round did not contain enough uninterrupted samples.';
      finishSequence();
      return;
    }
    trials.push(summary);
    scoreLive.textContent = String(summary.score);
    const next = state.roundIndex + 1;
    if (next < ROUND_MULTIPLIERS.length) {
      // Il loop rAF continua mentre mostriamo il punteggio: azzerare lo stato
      // evita di chiudere lo stesso round una volta per frame durante la pausa.
      state = null;
      transitionTimer = setTimeout(() => {
        transitionTimer = null;
        if (running) beginCountdown(next);
      }, 650);
    } else {
      finishSequence();
    }
  }

  function finishSequence() {
    running = false;
    state = null;
    const inactiveRounds = trials.filter(trial => trial.meanInput < 0.08).length;
    if (invalidReason || trials.length !== ROUND_MULTIPLIERS.length || inactiveRounds > 0) {
      renderInvalidRun(invalidReason || 'We didn’t detect enough right-stick movement.');
      run.classList.add('hidden');
      report.classList.remove('hidden');
      return;
    }
    const measuredRightDrift = deps.getMeasuredRightDrift?.() ?? null;
    const result = buildSensitivityRecommendation(selectedGame, trials, { measuredRightDrift });
    saveResult(result);
    renderReport(result);
    run.classList.add('hidden');
    report.classList.remove('hidden');
    deps.onReport?.(result);
  }

  function bindReportActions() {
    $('btn-sensitivity-retry').addEventListener('click', beginSequence);
    $('btn-sensitivity-change').addEventListener('click', showSetup);
  }

  function renderInvalidRun(reason) {
    report.innerHTML = `
      <div class="sensitivity-empty">
        <h4>${reason}</h4>
        <p>Keep the white reticle on the moving green target throughout all three rounds. A recommendation without real aim input would be misleading.</p>
      </div>
      <div class="modal-actions">
        <button id="btn-sensitivity-change" class="btn btn-ghost">Change output</button>
        <button id="btn-sensitivity-retry" class="btn btn-primary">Try again</button>
      </div>`;
    bindReportActions();
  }

  function renderReport(result) {
    const settings = result.settings.map(([label, value]) => `
      <div class="sensitivity-setting"><span>${label}</span><b>${value}</b></div>`).join('');
    const rounds = trials.map((trial, index) => `
      <span class="sensitivity-round-score ${trial === result.best ? 'best' : ''}">
        R${index + 1} <b>${trial.score}</b>
      </span>`).join('');
    report.innerHTML = `
      <div class="sensitivity-result-head">
        <div>
          <h4>${result.game}</h4>
          <p>${result.style} · ${result.multiplier}× personal multiplier · ${result.evidence}</p>
        </div>
      </div>
      <div class="sensitivity-settings">${settings}</div>
      <div class="sensitivity-rounds">${rounds}</div>
      <p class="sensitivity-caveat">Use these as a starting point, then adjust one step inside the game. FOV, aim assist and weapon feel cannot be reproduced perfectly in a browser.</p>
      <div class="modal-actions">
        <button id="btn-sensitivity-change" class="btn btn-ghost">Change output</button>
        <button id="btn-sensitivity-retry" class="btn btn-primary">Test again</button>
      </div>`;
    bindReportActions();
  }

  function sampleTrial(ts, sticks) {
    if (ts - lastTs > MAX_FRAME_GAP_MS) {
      invalidReason = 'The tab was interrupted during a round.';
      finishSequence();
      return;
    }
    const dt = Math.min(0.04, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;
    const input = shapedStick(sticks.rx, sticks.ry);
    const speed = 1.72 * state.multiplier;
    cursor.x = clamp(cursor.x + input.x * speed * dt, -0.94, 0.94);
    cursor.y = clamp(cursor.y + input.y * speed * dt, -0.9, 0.9);
    trail.push({ ...cursor });
    if (trail.length > 70) trail.shift();

    const elapsed = ts - state.start;
    const target = targetAt(elapsed, state.roundIndex);
    if (elapsed >= TRIAL_SETTLE_MS) {
      const ex = target.x - cursor.x;
      const ey = target.y - cursor.y;
      const error = Math.hypot(ex, ey);
      state.errors.push(error);
      state.inputs.push(input.mag);
      if (input.mag > 0.06 && error > 0.04) {
        state.alignments.push((input.x * ex + input.y * ey) / (input.mag * error));
      }
      const prev = state.previousInput;
      if ((Math.abs(input.x) > 0.18 && Math.abs(prev.x) > 0.18 && Math.sign(input.x) !== Math.sign(prev.x))
        || (Math.abs(input.y) > 0.18 && Math.abs(prev.y) > 0.18 && Math.sign(input.y) !== Math.sign(prev.y))) {
        state.reversals += 1;
      }
      state.previousInput = { x: input.x, y: input.y };
    }

    const pct = (state.roundIndex + elapsed / TRIAL_MS) / ROUND_MULTIPLIERS.length * 100;
    progress.style.width = `${clamp(pct, 0, 100)}%`;
    const rollingCount = Math.min(90, state.errors.length);
    if (rollingCount) {
      let rollingTotal = 0;
      for (let i = state.errors.length - rollingCount; i < state.errors.length; i += 1) {
        rollingTotal += state.errors[i];
      }
      const mean = rollingTotal / rollingCount;
      scoreLive.textContent = String(Math.round(clamp(100 - mean / 0.82 * 100, 0, 100)));
    }
    canvas.draw(target, cursor, trail);
    if (elapsed >= TRIAL_MS) finishTrial(ts);
  }

  function step(ts) {
    if (!state) return;
    if (state.kind === 'countdown') {
      const elapsed = ts - state.start;
      const left = Math.max(1, 3 - Math.floor(elapsed / (COUNTDOWN_MS / 3)));
      canvas.draw({ x: 0, y: 0 }, cursor, trail, String(left));
      if (elapsed >= COUNTDOWN_MS) beginTrial(state.roundIndex, ts);
      return;
    }
    sampleTrial(ts, deps.getSticks());
  }

  function saveResult(result) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...result, ts: Date.now() }));
    } catch (_) { /* il finder continua anche senza storage */ }
  }

  function loadPrevious() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch (_) { return null; }
  }

  function open(bypassGate = false) {
    if (!bypassGate && !deps.isAvailable()) return;
    showSetup();
    deps.showModal ? deps.showModal() : modal.classList.remove('hidden');
    startLoop();
  }

  function close() {
    running = false;
    state = null;
    if (transitionTimer != null) clearTimeout(transitionTimer);
    transitionTimer = null;
    stopLoop();
    deps.hideModal ? deps.hideModal() : modal.classList.add('hidden');
  }

  for (const button of gameButtons) {
    button.addEventListener('click', () => selectGame(button.dataset.sensitivityGame));
  }
  btnStart.addEventListener('click', beginSequence);
  btnExit.addEventListener('click', close);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) {
      invalidReason = 'The tab was hidden during a round.';
      finishSequence();
    }
    lastTs = performance.now();
  });
  // I riferimenti iniziali servono solo a documentare gli ID nel markup; dopo
  // il primo report i bottoni sono ricreati dentro renderReport().
  void btnRetry;
  void btnChange;
  selectGame(selectedGame);

  return { open, close };
}

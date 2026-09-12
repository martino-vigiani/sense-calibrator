'use strict';

const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const FIXED_DT = 1 / 120;
const MAX_FRAME_DT = 0.05;
const MAX_STEPS = 6;
const RUN_MS = 30000;
const TRAIL_SIZE = 96;

function percentile(values, p) {
  if (!values.length) return 0;
  const copy = values.slice().sort((a, b) => a - b);
  return copy[Math.min(copy.length - 1, Math.floor((copy.length - 1) * p))];
}

export function summarizePlaytestSession(raw) {
  const durationSeconds = Math.max(0.001, raw.durationMs / 1000);
  const meanError = raw.trackingSamples ? raw.errorTotal / raw.trackingSamples : 1;
  const tracking = Math.round(clamp(1 - meanError / 0.78, 0, 1) * 100);
  const simultaneous = Math.round(clamp(raw.dualStickSeconds / durationSeconds, 0, 1) * 100);
  const coverage = Math.round(clamp(raw.visitedCells / 48, 0, 1) * 100);
  const reportMedianMs = percentile(raw.reportIntervals || [], 0.5);
  const reportP95Ms = percentile(raw.reportIntervals || [], 0.95);
  const reportRate = reportMedianMs > 0 ? Math.round(1000 / reportMedianMs) : 0;
  const frameP95Ms = percentile(raw.frameIntervals || [], 0.95);
  const centeredNoise = raw.centerSamples
    ? Math.sqrt(raw.centerNoiseSq / raw.centerSamples) * 100
    : null;
  const readiness = Math.round(tracking * 0.68 + simultaneous * 0.18 + coverage * 0.14);

  return {
    tracking,
    simultaneous,
    coverage,
    readiness,
    reportRate,
    reportMedianMs: +reportMedianMs.toFixed(2),
    reportP95Ms: +reportP95Ms.toFixed(2),
    frameP95Ms: +frameP95Ms.toFixed(2),
    centeredNoise: centeredNoise == null ? null : +centeredNoise.toFixed(2),
    reportSamples: (raw.reportIntervals || []).length,
  };
}

function applyDeadzone(x, y, deadzone = 0.035) {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadzone) return { x: 0, y: 0, magnitude: 0 };
  const scaled = clamp((magnitude - deadzone) / (1 - deadzone), 0, 1);
  return { x: x / magnitude * scaled, y: y / magnitude * scaled, magnitude: scaled };
}

export function initPlaytest(deps) {
  const modal = $('modal-playtest');
  const canvas = $('playtest-canvas');
  const ctx = canvas.getContext('2d');
  const status = $('playtest-status');
  const timer = $('playtest-timer');
  const progress = $('playtest-progress').querySelector('i');
  const report = $('playtest-report');
  const startButton = $('btn-playtest-start');
  const pauseNote = $('playtest-pause-note');

  const logicalWidth = 960;
  const logicalHeight = 520;
  const trailX = new Float32Array(TRAIL_SIZE);
  const trailY = new Float32Array(TRAIL_SIZE);
  const visited = new Uint8Array(48);

  let open = false;
  let running = false;
  let rafId = null;
  let lastFrame = 0;
  let accumulator = 0;
  let simSeconds = 0;
  let runStart = 0;
  let lastReport = 0;
  let trailIndex = 0;
  let trailCount = 0;
  let playerX = 0;
  let playerY = 0;
  let aimX = 0;
  let aimY = 0;
  let targetX = 0;
  let targetY = 0;
  let raw = null;

  function resetMetrics() {
    visited.fill(0);
    raw = {
      durationMs: 0,
      errorTotal: 0,
      trackingSamples: 0,
      dualStickSeconds: 0,
      centerNoiseSq: 0,
      centerSamples: 0,
      visitedCells: 0,
      reportIntervals: [],
      frameIntervals: [],
    };
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const nextW = Math.round(logicalWidth * dpr);
    const nextH = Math.round(logicalHeight * dpr);
    if (canvas.width === nextW && canvas.height === nextH) return;
    canvas.width = nextW;
    canvas.height = nextH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function targetAt(t) {
    targetX = Math.sin(t * 0.83) * 0.64 - playerX * 0.11;
    targetY = Math.sin(t * 1.21 + 0.8) * 0.5 - playerY * 0.08;
  }

  function simulate(dt) {
    const sticks = deps.getSticks();
    const move = applyDeadzone(sticks.lx, sticks.ly, 0.06);
    const aim = applyDeadzone(sticks.rx, sticks.ry);

    playerX = clamp(playerX + move.x * dt * 0.86, -0.9, 0.9);
    playerY = clamp(playerY + move.y * dt * 0.86, -0.86, 0.86);
    aimX = clamp(aimX + aim.x * dt * 1.78, -0.96, 0.96);
    aimY = clamp(aimY + aim.y * dt * 1.78, -0.92, 0.92);
    simSeconds += dt;
    targetAt(simSeconds);

    trailX[trailIndex] = aimX;
    trailY[trailIndex] = aimY;
    trailIndex = (trailIndex + 1) % TRAIL_SIZE;
    trailCount = Math.min(TRAIL_SIZE, trailCount + 1);

    if (!running) return;
    const dx = targetX - aimX;
    const dy = targetY - aimY;
    raw.errorTotal += Math.hypot(dx, dy);
    raw.trackingSamples += 1;
    if (move.magnitude > 0.14 && aim.magnitude > 0.14) raw.dualStickSeconds += dt;
    const cellX = clamp(Math.floor((playerX * 0.5 + 0.5) * 8), 0, 7);
    const cellY = clamp(Math.floor((playerY * 0.5 + 0.5) * 6), 0, 5);
    const cell = cellY * 8 + cellX;
    if (!visited[cell]) {
      visited[cell] = 1;
      raw.visitedCells += 1;
    }
  }

  function point(x, y) {
    return { x: (x * 0.5 + 0.5) * logicalWidth, y: (y * 0.5 + 0.5) * logicalHeight };
  }

  function draw() {
    resize();
    ctx.clearRect(0, 0, logicalWidth, logicalHeight);
    ctx.fillStyle = '#080a09';
    ctx.fillRect(0, 0, logicalWidth, logicalHeight);
    ctx.strokeStyle = 'rgba(216,255,87,.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= logicalWidth; x += 80) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, logicalHeight); ctx.stroke();
    }
    for (let y = 0; y <= logicalHeight; y += 65) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(logicalWidth, y); ctx.stroke();
    }

    if (trailCount > 1) {
      ctx.beginPath();
      for (let i = 0; i < trailCount; i += 1) {
        const index = (trailIndex - trailCount + i + TRAIL_SIZE) % TRAIL_SIZE;
        const p = point(trailX[index], trailY[index]);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,.18)';
      ctx.stroke();
    }

    const player = point(playerX, playerY);
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.lineWidth = 2;
    ctx.strokeRect(player.x - 11, player.y - 11, 22, 22);

    const target = point(targetX, targetY);
    const error = Math.hypot(targetX - aimX, targetY - aimY);
    ctx.strokeStyle = '#d8ff57';
    ctx.lineWidth = error < 0.12 ? 4 : 2;
    ctx.beginPath(); ctx.arc(target.x, target.y, 18, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(216,255,87,.2)';
    ctx.beginPath(); ctx.arc(target.x, target.y, 7, 0, Math.PI * 2); ctx.fill();

    const aim = point(aimX, aimY);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(aim.x - 13, aim.y); ctx.lineTo(aim.x + 13, aim.y);
    ctx.moveTo(aim.x, aim.y - 13); ctx.lineTo(aim.x, aim.y + 13);
    ctx.stroke();
  }

  function finishRun(reason = 'complete') {
    if (!running) return;
    running = false;
    raw.durationMs = performance.now() - runStart;
    if (reason !== 'complete') {
      status.textContent = 'Run discarded because the tab was interrupted. Start a clean run when ready.';
      pauseNote.classList.remove('hidden');
      startButton.textContent = 'Start clean 30s run';
      startButton.disabled = false;
      return;
    }
    const result = summarizePlaytestSession(raw);
    status.textContent = 'Run complete';
    startButton.textContent = 'Run again';
    startButton.disabled = false;
    progress.style.width = '100%';
    report.classList.remove('hidden');
    report.innerHTML = `
      <div class="playtest-score"><span>Play readiness</span><b>${result.readiness}</b></div>
      <div class="playtest-metrics">
        <div><span>Tracking</span><b>${result.tracking}%</b></div>
        <div><span>Two-stick control</span><b>${result.simultaneous}%</b></div>
        <div><span>Movement coverage</span><b>${result.coverage}%</b></div>
        <div><span>USB reports</span><b>${result.reportRate ? `${result.reportRate} Hz` : 'No HID data'}</b></div>
        <div><span>Report p95</span><b>${result.reportP95Ms ? `${result.reportP95Ms} ms` : '—'}</b></div>
        <div><span>Frame p95</span><b>${result.frameP95Ms} ms</b></div>
      </div>
      <p class="playtest-caveat">This compares browser runs, not console latency. Aim assist, game FOV and display latency are outside this measurement.</p>`;
    deps.onReport?.(result);
  }

  function tick(ts) {
    if (!open) return;
    rafId = requestAnimationFrame(tick);
    if (!lastFrame) lastFrame = ts;
    const frameDt = Math.min(MAX_FRAME_DT, Math.max(0, (ts - lastFrame) / 1000));
    if (running && ts - lastFrame < 250) raw.frameIntervals.push(ts - lastFrame);
    lastFrame = ts;
    accumulator = Math.min(accumulator + frameDt, FIXED_DT * MAX_STEPS);
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      simulate(FIXED_DT);
      accumulator -= FIXED_DT;
      steps += 1;
    }
    draw();

    if (running) {
      const elapsed = ts - runStart;
      const remaining = Math.max(0, RUN_MS - elapsed);
      timer.textContent = `${Math.ceil(remaining / 1000)}s`;
      progress.style.width = `${clamp(elapsed / RUN_MS * 100, 0, 100)}%`;
      if (elapsed >= RUN_MS) finishRun();
    }
  }

  function startRun() {
    resetMetrics();
    playerX = 0; playerY = 0; aimX = 0; aimY = 0;
    trailIndex = 0; trailCount = 0;
    running = true;
    runStart = performance.now();
    lastReport = 0;
    report.classList.add('hidden');
    pauseNote.classList.add('hidden');
    status.textContent = 'Track the green target while moving with the left stick';
    timer.textContent = '30s';
    progress.style.width = '0%';
    startButton.textContent = 'Running…';
    startButton.disabled = true;
  }

  function feedSample(sticks, ts = performance.now()) {
    if (!open || !running || !raw) return;
    if (lastReport) {
      const interval = ts - lastReport;
      if (interval > 0 && interval < 100) raw.reportIntervals.push(interval);
    }
    lastReport = ts;
    const left = Math.hypot(sticks.lx, sticks.ly);
    const right = Math.hypot(sticks.rx, sticks.ry);
    if (left < 0.08 && right < 0.08) {
      raw.centerNoiseSq += left * left + right * right;
      raw.centerSamples += 1;
    }
  }

  function show(bypassGate = false) {
    if (!bypassGate && !deps.isAvailable()) return;
    open = true;
    running = false;
    lastFrame = 0;
    accumulator = 0;
    simSeconds = 0;
    status.textContent = 'Free play is live. Start a run when you are comfortable.';
    timer.textContent = 'FREE';
    progress.style.width = '0%';
    report.classList.add('hidden');
    pauseNote.classList.add('hidden');
    startButton.textContent = 'Start 30s run';
    startButton.disabled = false;
    deps.showModal ? deps.showModal() : modal.classList.remove('hidden');
    rafId = requestAnimationFrame(tick);
  }

  function close() {
    open = false;
    running = false;
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
    deps.hideModal ? deps.hideModal() : modal.classList.add('hidden');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running) finishRun('hidden');
    lastFrame = 0;
    accumulator = 0;
  });
  startButton.addEventListener('click', startRun);

  return { open: show, close, feedSample };
}

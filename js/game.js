'use strict';

/* ============================================================
   Test di precisione — tre prove diagnostiche di calibrazione.
   Modulo autonomo: legge solo la posizione degli stick via deps,
   non tocca l'HID e non conosce lo stato di app.js.

   Ogni prova misura una proprietà della calibrazione, non
   l'abilità dell'utente:
     Center    -> offset residuo a riposo (drift)
     Reach     -> copertura del fondo corsa (range)
     Snap-back -> dove si ferma lo stick rilasciato (ricentraggio)

   initGame(deps, opts)
     deps.getSticks  -> () => ({ lx, ly, rx, ry })   (-1..1, y giù)
     deps.isAvailable -> () => bool                   (gate apertura)
     deps.onReport   -> (res) => void  opzionale: punteggi a fine sequenza

   Ritorna { open } ma il wiring usa anche window.__senseGameOpen
   come hook dev che bypassa il gate.
   ============================================================ */

const INK = '#0a0a0a';
const GRID = '#e4e4e0';
const MID = '#c9c9c5';

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------- parametri (fissi: punteggi stabili) ---------------- */

// Center: media della distanza dal centro a riposo.
const CENTER_MS = 6000;
const CENTER_SETTLE_MS = 600;   // scartati all'inizio (la mano lascia lo stick)
const CENTER_ZERO = 0.05;       // 5% di offset medio -> punteggio 0

// Reach: rotazione a fondo corsa, massimo raggio per settore.
const REACH_MS = 10000;
const REACH_BINS = 12;
const REACH_OK = 0.9;           // raggio minimo perché un settore conti

// Snap-back: flick al bordo, rilascio, misura del punto di riposo.
const SNAP_FLICKS = 3;          // flick richiesti per stick
const SNAP_ARM = 0.75;          // raggio oltre cui il flick è "armato"
const SNAP_RELEASE = 0.25;      // raggio sotto cui lo stick è stato rilasciato
const SNAP_SETTLE_MS = 450;     // attesa perché lo stick si fermi davvero
const SNAP_MEASURE_MS = 400;    // finestra di misura del punto di riposo
const SNAP_TIMEOUT_MS = 25000;  // tempo massimo per la prova intera
const SNAP_ZERO = 0.05;         // 5% di riposo medio -> punteggio 0

// Countdown tra prove
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 800;

// Pesi del punteggio complessivo per stick (somma = 1).
const W_CENTER = 0.40;
const W_REACH = 0.25;
const W_SNAP = 0.35;

// v3: prove cambiate (center/reach/snap) — i punteggi v2 non sono confrontabili.
const STORAGE_KEY = 'senseGameLastScore.v3';

/* ---------------- canvas di gioco ---------------- */

// Quadrante di gioco: stesso scaling DPR di StickDial in app.js.
// Disegna anello bersaglio e posizione corrente in coordinate -1..1.
class GameCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.x = 0;
    this.y = 0;
    this.trail = [];
    const dpr = window.devicePixelRatio || 1;
    this.size = canvas.width; // dimensione logica dal markup
    canvas.width = this.size * dpr;
    canvas.height = this.size * dpr;
    this.ctx.scale(dpr, dpr);
  }

  setPos(x, y) {
    this.x = x;
    this.y = y;
    this.trail.push({ x, y });
    if (this.trail.length > 48) this.trail.shift();
  }

  clearTrail() { this.trail = []; }

  draw(scene) {
    const { ctx, size } = this;
    const c = size / 2;
    const R = size / 2 - 14;
    const px = u => c + u * R;
    ctx.clearRect(0, 0, size, size);

    // griglia di riferimento, identica per linguaggio visivo a StickDial
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(c, c, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c, R / 2, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
    ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
    ctx.stroke();

    // scia del puntatore utente
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      ctx.strokeStyle = `rgba(10,10,10,${(i / this.trail.length) * 0.3})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px(a.x), px(a.y));
      ctx.lineTo(px(b.x), px(b.y));
      ctx.stroke();
    }

    // anello bersaglio: al centro (Center/Snap) o sul bordo (Reach)
    if (scene && scene.ring) {
      const r = scene.ring;
      ctx.strokeStyle = r.locked ? INK : MID;
      ctx.lineWidth = r.locked ? 2.5 : 1.5;
      ctx.setLineDash(r.locked ? [] : [4, 4]);
      ctx.beginPath();
      ctx.arc(c, c, r.radius * R, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // settori mancanti della prova Reach (tacche sul perimetro)
    if (scene && scene.bins) {
      for (let i = 0; i < REACH_BINS; i++) {
        if (scene.bins[i] >= REACH_OK) continue;
        const ang = (i + 0.5) / REACH_BINS * 2 * Math.PI - Math.PI;
        ctx.strokeStyle = MID;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c, c, R + 6, ang - 0.18, ang + 0.18);
        ctx.stroke();
      }
    }

    // punto corrente dell'utente
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(px(this.x), px(this.y), 5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

/* ---------------- punteggi (mappature monotone, deterministiche) ---------------- */

// Tutte le mappature errore->punteggio sono lineari e prive di casualità:
// la stessa prestazione produce sempre lo stesso punteggio.

// Center e Snap: distanza dal centro (unità stick). 0 -> 100, ZERO -> 0.
function scoreOffset(meanDist, zero) {
  return Math.round(clamp(100 - (meanDist / zero) * 100, 0, 100));
}

// Reach: frazione di settori che raggiungono il fondo corsa.
function scoreReach(bins) {
  const ok = bins.filter(v => v >= REACH_OK).length;
  return Math.round((ok / REACH_BINS) * 100);
}

// Snap: media dei punti di riposo misurati; nessun flick registrato -> 0.
function scoreSnap(rests) {
  if (!rests.length) return 0;
  const mean = rests.reduce((a, b) => a + b, 0) / rests.length;
  return scoreOffset(mean, SNAP_ZERO);
}

function overallScore(s) {
  return Math.round(s.center * W_CENTER + s.reach * W_REACH + s.snap * W_SNAP);
}

function verdictFor(score) {
  if (score >= 90) return 'Excellent calibration';
  if (score >= 75) return 'Good calibration';
  if (score >= 55) return 'Fair calibration';
  if (score >= 35) return 'Poor calibration';
  return 'Critical calibration';
}

/* ============================================================
   initGame
   ============================================================ */

export function initGame(deps) {
  const getSticks = deps.getSticks;
  const isAvailable = deps.isAvailable;
  // Apertura/chiusura del modale delegate ad app.js quando fornite: lì vive
  // l'animazione di uscita. Senza di esse il gioco resta autonomo.
  const showModal = deps.showModal;
  const hideModal = deps.hideModal;

  // Elementi DOM (tutti presenti in index.html).
  const modal = $('modal-game');
  const canvasL = new GameCanvas($('game-dial-l'));
  const canvasR = new GameCanvas($('game-dial-r'));
  const elPhase = $('game-phase');
  const elInstr = $('game-instr');
  const elProgress = $('game-progress');
  const elProgressBar = elProgress.querySelector('i');
  const elCountdown = $('game-countdown');
  const elDials = $('game-dials');
  const elIntro = $('game-intro');
  const elReport = $('game-report');
  const elReportActions = $('game-report-actions');
  const btnStart = $('btn-game-start');
  const btnExit = $('btn-game-exit');
  const btnRetry = $('btn-game-retry');

  let rafId = null;
  let running = false;       // true mentre una sequenza di prove è attiva
  let phase = null;          // stato della prova corrente
  let scene = { L: {}, R: {} }; // cosa disegnare per ciascun quadrante

  // Punteggi accumulati per stick.
  let scores = null;

  /* ---------------- loop rAF (attivo solo a modale aperto) ---------------- */

  function startLoop() {
    if (rafId != null) return;
    const tick = ts => {
      rafId = requestAnimationFrame(tick);
      step(ts);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  /* ---------------- helper di stato ---------------- */

  function setProgress(pct) {
    elProgressBar.style.width = clamp(pct, 0, 100) + '%';
  }

  function showCountdown(n) {
    elCountdown.textContent = n > 0 ? String(n) : 'Go';
    elCountdown.classList.remove('hidden');
  }
  function hideCountdown() { elCountdown.classList.add('hidden'); }

  /* ---------------- sequenza prove ---------------- */

  function startSequence() {
    scores = {
      L: { center: 0, reach: 0, snap: 0 },
      R: { center: 0, reach: 0, snap: 0 },
    };
    elIntro.classList.add('hidden');
    elReport.classList.add('hidden');
    elReportActions.classList.add('hidden');
    elDials.classList.remove('hidden');
    elProgress.classList.remove('hidden');
    canvasL.clearTrail();
    canvasR.clearTrail();
    running = true;
    enterCountdown('Center', 'Leave the sticks alone. Measuring the resting offset.', beginCenter);
  }

  // Countdown 3-2-1 prima di ogni prova, così l'utente si prepara.
  function enterCountdown(title, instr, next) {
    elPhase.textContent = title;
    elInstr.textContent = instr;
    setProgress(0);
    scene = { L: {}, R: {} };
    phase = {
      kind: 'countdown',
      next,
      stepsLeft: COUNTDOWN_FROM,
      nextSwitch: performance.now() + COUNTDOWN_STEP_MS,
      shownVia: false,
    };
    showCountdown(COUNTDOWN_FROM);
  }

  function tickCountdown(ts) {
    if (ts < phase.nextSwitch) return;
    phase.nextSwitch = ts + COUNTDOWN_STEP_MS;
    phase.stepsLeft -= 1;
    if (phase.stepsLeft > 0) {
      showCountdown(phase.stepsLeft);
    } else if (!phase.shownVia) {
      phase.shownVia = true;
      showCountdown(0); // "Go"
    } else {
      hideCountdown();
      const next = phase.next;
      next();
    }
  }

  /* --- Prova 1: Center --- */

  function beginCenter() {
    elPhase.textContent = 'Center';
    elInstr.textContent = 'Don’t touch the sticks. Measuring the resting offset.';
    phase = {
      kind: 'center',
      start: performance.now(),
      L: { sum: 0, n: 0 },
      R: { sum: 0, n: 0 },
    };
    scene = {
      L: { ring: { radius: 0.12, locked: false } },
      R: { ring: { radius: 0.12, locked: false } },
    };
  }

  function tickCenter(ts, s) {
    const elapsed = ts - phase.start;
    setProgress((elapsed / CENTER_MS) * 100);
    if (elapsed > CENTER_SETTLE_MS) {
      phase.L.sum += Math.hypot(s.lx, s.ly); phase.L.n++;
      phase.R.sum += Math.hypot(s.rx, s.ry); phase.R.n++;
    }
    scene.L.ring.locked = Math.hypot(s.lx, s.ly) <= 0.12;
    scene.R.ring.locked = Math.hypot(s.rx, s.ry) <= 0.12;
    if (elapsed >= CENTER_MS) {
      scores.L.center = scoreOffset(phase.L.n ? phase.L.sum / phase.L.n : 0, CENTER_ZERO);
      scores.R.center = scoreOffset(phase.R.n ? phase.R.sum / phase.R.n : 0, CENTER_ZERO);
      enterCountdown('Reach', 'Rotate both sticks slowly along the edge, full circles.', beginReach);
    }
  }

  /* --- Prova 2: Reach --- */

  function beginReach() {
    elPhase.textContent = 'Reach';
    elInstr.textContent = 'Rotate both sticks along the edge. Cover the whole perimeter.';
    phase = {
      kind: 'reach',
      start: performance.now(),
      L: { bins: new Array(REACH_BINS).fill(0) },
      R: { bins: new Array(REACH_BINS).fill(0) },
    };
    canvasL.clearTrail();
    canvasR.clearTrail();
    scene = {
      L: { ring: { radius: REACH_OK, locked: false }, bins: phase.L.bins },
      R: { ring: { radius: REACH_OK, locked: false }, bins: phase.R.bins },
    };
  }

  function reachAccumulate(bins, x, y) {
    const r = Math.hypot(x, y);
    const bin = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * REACH_BINS) % REACH_BINS;
    if (r > bins[bin]) bins[bin] = r;
    return r;
  }

  function tickReach(ts, s) {
    const elapsed = ts - phase.start;
    setProgress((elapsed / REACH_MS) * 100);
    scene.L.ring.locked = reachAccumulate(phase.L.bins, s.lx, s.ly) >= REACH_OK;
    scene.R.ring.locked = reachAccumulate(phase.R.bins, s.rx, s.ry) >= REACH_OK;
    if (elapsed >= REACH_MS) {
      scores.L.reach = scoreReach(phase.L.bins);
      scores.R.reach = scoreReach(phase.R.bins);
      enterCountdown('Snap-back', 'Flick each stick to the edge and let it go. Three times per stick.', beginSnap);
    }
  }

  /* --- Prova 3: Snap-back --- */

  // Macchina a stati per stick: wait -> armed -> settling -> measuring -> wait.
  // Il punto di riposo si misura solo dopo un flick vero (armato oltre SNAP_ARM)
  // e dopo che lo stick ha avuto il tempo di fermarsi.
  function snapState() {
    return { rests: [], stage: 'wait', stageAt: 0, sum: 0, n: 0 };
  }

  function beginSnap() {
    elPhase.textContent = 'Snap-back';
    elInstr.textContent = 'Flick each stick to the edge and let it go. Three times per stick.';
    phase = {
      kind: 'snap',
      start: performance.now(),
      L: snapState(),
      R: snapState(),
    };
    canvasL.clearTrail();
    canvasR.clearTrail();
    scene = {
      L: { ring: { radius: 0.12, locked: false } },
      R: { ring: { radius: 0.12, locked: false } },
    };
  }

  function tickSnapStick(ts, st, x, y) {
    if (st.rests.length >= SNAP_FLICKS) return;
    const r = Math.hypot(x, y);
    if (st.stage === 'wait') {
      if (r >= SNAP_ARM) { st.stage = 'armed'; st.stageAt = ts; }
    } else if (st.stage === 'armed') {
      if (r <= SNAP_RELEASE) { st.stage = 'settling'; st.stageAt = ts; }
    } else if (st.stage === 'settling') {
      // Se l'utente riparte durante l'assestamento, il flick si riarma.
      if (r >= SNAP_ARM) { st.stage = 'armed'; st.stageAt = ts; return; }
      if (ts - st.stageAt >= SNAP_SETTLE_MS) {
        st.stage = 'measuring'; st.stageAt = ts; st.sum = 0; st.n = 0;
      }
    } else if (st.stage === 'measuring') {
      if (r >= SNAP_ARM) { st.stage = 'armed'; st.stageAt = ts; return; }
      st.sum += r; st.n++;
      if (ts - st.stageAt >= SNAP_MEASURE_MS) {
        st.rests.push(st.n ? st.sum / st.n : r);
        st.stage = 'wait';
      }
    }
  }

  function tickSnap(ts, s) {
    tickSnapStick(ts, phase.L, s.lx, s.ly);
    tickSnapStick(ts, phase.R, s.rx, s.ry);
    scene.L.ring.locked = phase.L.rests.length >= SNAP_FLICKS;
    scene.R.ring.locked = phase.R.rests.length >= SNAP_FLICKS;
    const total = phase.L.rests.length + phase.R.rests.length;
    setProgress((total / (SNAP_FLICKS * 2)) * 100);
    elInstr.textContent = `Flick and release. Left ${phase.L.rests.length}/${SNAP_FLICKS}, right ${phase.R.rests.length}/${SNAP_FLICKS}.`;

    const done = phase.L.rests.length >= SNAP_FLICKS && phase.R.rests.length >= SNAP_FLICKS;
    const timedOut = ts - phase.start >= SNAP_TIMEOUT_MS;
    if (done || timedOut) {
      scores.L.snap = scoreSnap(phase.L.rests);
      scores.R.snap = scoreSnap(phase.R.rests);
      finishSequence();
    }
  }

  /* ---------------- fine sequenza e report ---------------- */

  function finishSequence() {
    running = false;
    phase = null;
    scene = { L: {}, R: {} };
    setProgress(100);

    const totalL = overallScore(scores.L);
    const totalR = overallScore(scores.R);
    const overall = Math.round((totalL + totalR) / 2);

    const prev = loadPrevious();
    const report = { L: { ...scores.L, total: totalL }, R: { ...scores.R, total: totalR }, overall };
    renderReport(report, prev);
    saveResult(overall);
    deps.onReport?.(report);

    elDials.classList.add('hidden');
    elProgress.classList.add('hidden');
    hideCountdown();
    elReport.classList.remove('hidden');
    elReportActions.classList.remove('hidden');
  }

  function renderReport(res, prev) {
    const row = (label, val) =>
      `<div class="game-score-row"><span>${label}</span><b>${val}</b></div>`;

    let compare = '';
    if (prev != null) {
      const delta = res.overall - prev;
      const sign = delta > 0 ? '+' : '';
      compare = `<p class="game-compare">Previous ${prev} &rarr; Today ${res.overall} `
        + `<span class="game-delta">(${sign}${delta})</span></p>`;
    } else {
      compare = `<p class="game-compare">First result saved. Run the test again after a calibration to compare it.</p>`;
    }

    elReport.innerHTML = `
      <div class="game-overall">
        <span class="game-overall-num">${res.overall}</span>
        <span class="game-overall-cap">out of 100</span>
      </div>
      <p class="game-verdict">${verdictFor(res.overall)}</p>
      ${compare}
      <div class="game-breakdown">
        <div class="game-stick-col">
          <h4>Left stick &middot; ${res.L.total}</h4>
          ${row('Center', res.L.center)}
          ${row('Reach', res.L.reach)}
          ${row('Snap-back', res.L.snap)}
        </div>
        <div class="game-stick-col">
          <h4>Right stick &middot; ${res.R.total}</h4>
          ${row('Center', res.R.center)}
          ${row('Reach', res.R.reach)}
          ${row('Snap-back', res.R.snap)}
        </div>
      </div>
      <p class="game-formula">Score = Center 40% + Reach 25% + Snap-back 35%. Same performance, same score.</p>
    `;
  }

  /* ---------------- localStorage ---------------- */

  function loadPrevious() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return typeof v.overall === 'number' ? v.overall : null;
    } catch (_) {
      return null;
    }
  }

  function saveResult(overall) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ overall, ts: Date.now() }));
    } catch (_) { /* storage non disponibile: il gioco funziona comunque */ }
  }

  /* ---------------- step del loop ---------------- */

  function step(ts) {
    const s = getSticks();

    if (phase) {
      if (phase.kind === 'countdown') tickCountdown(ts);
      else if (phase.kind === 'center') tickCenter(ts, s);
      else if (phase.kind === 'reach') tickReach(ts, s);
      else if (phase.kind === 'snap') tickSnap(ts, s);
    }

    // disegno sempre, anche a riposo (intro/report): mostra la posizione viva
    canvasL.setPos(s.lx, s.ly);
    canvasR.setPos(s.rx, s.ry);
    canvasL.draw(scene.L);
    canvasR.draw(scene.R);
  }

  /* ---------------- apertura / chiusura ---------------- */

  function showIntro() {
    elIntro.classList.remove('hidden');
    elReport.classList.add('hidden');
    elReportActions.classList.add('hidden');
    elDials.classList.remove('hidden'); // i quadranti restano vivi per provare gli stick
    elProgress.classList.add('hidden');
    hideCountdown();
    elPhase.textContent = 'Precision test';
    elInstr.textContent = 'Three quick checks, about 40 seconds. Press Start when you’re ready.';
    scene = { L: {}, R: {} };
    const prev = loadPrevious();
    btnStart.textContent = prev != null ? `Start (previous ${prev})` : 'Start';
  }

  // open(bypassGate): bypassGate=true salta isAvailable (hook dev senza controller).
  function open(bypassGate = false) {
    if (!bypassGate && !isAvailable()) return;
    running = false;
    phase = null;
    scene = { L: {}, R: {} };
    canvasL.clearTrail();
    canvasR.clearTrail();
    showIntro();
    showModal ? showModal() : modal.classList.remove('hidden');
    startLoop();
  }

  function close() {
    stopLoop();          // niente loop fantasma
    running = false;
    phase = null;
    // usa la chiusura animata di app.js quando disponibile, così l'uscita del
    // gioco è coerente con gli altri modali
    hideModal ? hideModal() : modal.classList.add('hidden');
    hideCountdown();
  }

  /* ---------------- wiring bottoni del gioco ---------------- */

  btnStart.addEventListener('click', () => { if (!running) startSequence(); });
  btnExit.addEventListener('click', close);
  if (btnRetry) btnRetry.addEventListener('click', () => { if (!running) startSequence(); });

  return { open, close };
}

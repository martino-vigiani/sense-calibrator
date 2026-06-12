'use strict';

/* ============================================================
   Test di precisione — mini-gioco di diagnostica degli stick.
   Modulo autonomo: legge solo la posizione degli stick via deps,
   non tocca l'HID e non conosce lo stato di app.js.

   initGame(deps, opts)
     deps.getSticks  -> () => ({ lx, ly, rx, ry })   (-1..1, y giù)
     deps.isAvailable -> () => bool                   (gate apertura)

   Ritorna { open } ma il wiring usa anche window.__senseGameOpen
   come hook dev che bypassa il gate.
   ============================================================ */

const INK = '#0a0a0a';
const GRID = '#e4e4e0';
const MID = '#c9c9c5';

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------- parametri di gioco (fissi: punteggi stabili) ---------------- */

// Fermezza
const STEADY_MS = 10000;
const STEADY_SETTLE_MS = 600;      // scartati all'inizio (la mano lascia lo stick)

// Bersagli: posizioni fisse (centro, cardinali a piena corsa, diagonali).
// L'ordine è deterministico così la prova è identica ogni volta.
const TARGET_FULL = 0.92;          // piena deflessione richiesta sui bordi
const TARGET_DIAG = 0.65;          // componente diagonale (~0.92 di modulo)
const TARGETS = [
  { x: 0, y: 0 },
  { x: TARGET_FULL, y: 0 },
  { x: -TARGET_FULL, y: 0 },
  { x: 0, y: -TARGET_FULL },
  { x: 0, y: TARGET_FULL },
  { x: TARGET_DIAG, y: -TARGET_DIAG },
  { x: -TARGET_DIAG, y: TARGET_DIAG },
];
const TARGET_RADIUS = 0.16;        // raggio della zona valida (in unità stick)
const TARGET_HOLD_MS = 400;        // permanenza richiesta dentro il bersaglio
const TARGET_TIMEOUT_MS = 6000;    // tempo massimo per acquisire un bersaglio
const TARGET_IDEAL_MS = 900;       // tempo "perfetto" di acquisizione (per il punteggio)

// Inseguimento: traiettoria di Lissajous fissa (passa per centro e bordi).
const TRACK_MS = 20000;
const TRACK_SETTLE_MS = 700;       // primo tratto escluso dal punteggio (rincorsa iniziale)
const TRACK_AMP = 0.82;
const TRACK_FREQ_X = 1.0;          // giri/periodo
const TRACK_FREQ_Y = 2.0;
const TRACK_PERIOD_MS = 6500;      // durata di un periodo della figura

// Countdown tra prove
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP_MS = 800;

// Pesi del punteggio complessivo per stick (somma = 1).
const W_STEADY = 0.25;
const W_TARGETS = 0.40;
const W_TRACK = 0.35;

const STORAGE_KEY = 'senseGameLastScore';

/* ---------------- canvas di gioco ---------------- */

// Quadrante di gioco: stesso scaling DPR di StickDial in app.js.
// Disegna bersaglio, traiettoria e posizione corrente in coordinate -1..1.
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

  // toPx: da unità stick (-1..1) a pixel logici nel quadrante.
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

    // traiettoria di inseguimento (fantasma)
    if (scene && scene.path && scene.path.length > 1) {
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < scene.path.length; i++) {
        const p = scene.path[i];
        i === 0 ? ctx.moveTo(px(p.x), px(p.y)) : ctx.lineTo(px(p.x), px(p.y));
      }
      ctx.stroke();
    }

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

    // bersaglio (anello + crocino) o segnalino mobile dell'inseguimento
    if (scene && scene.target) {
      const t = scene.target;
      const rr = (t.radius != null ? t.radius : TARGET_RADIUS) * R;
      ctx.strokeStyle = INK;
      ctx.lineWidth = t.locked ? 3 : 1.5;
      ctx.setLineDash(t.locked ? [] : [4, 4]);
      ctx.beginPath();
      ctx.arc(px(t.x), px(t.y), rr, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
      // crocino interno
      ctx.strokeStyle = MID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px(t.x) - 5, px(t.y)); ctx.lineTo(px(t.x) + 5, px(t.y));
      ctx.moveTo(px(t.x), px(t.y) - 5); ctx.lineTo(px(t.x), px(t.y) + 5);
      ctx.stroke();
    }

    // bersaglio fisso al centro (prova Fermezza)
    if (scene && scene.centerHold) {
      ctx.strokeStyle = MID;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(c, c, TARGET_RADIUS * R, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // punto corrente dell'utente
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(px(this.x), px(this.y), 5, 0, 2 * Math.PI);
    ctx.fill();
  }
}

/* ---------------- punteggi (mappature monotone, deterministiche) ---------------- */

// Tutte le mappature error->score sono lineari a tratti e prive di casualità:
// la stessa prestazione produce sempre lo stesso punteggio.

// Fermezza: errore = distanza radiale media dal centro (in unità stick).
// 0 -> 100, 0.20 (=20% deflessione) -> 0.
function scoreSteady(meanDist) {
  return Math.round(clamp(100 - (meanDist / 0.20) * 100, 0, 100));
}

// Bersagli: combina tempo di acquisizione e overshoot, mediati sui bersagli.
// timeScore: ideale TARGET_IDEAL_MS -> 100, timeout -> 0.
// overshoot = quanto si supera il bersaglio prima di stabilizzarsi.
function scoreTargets(records) {
  if (!records.length) return 0;
  let sum = 0;
  for (const r of records) {
    if (!r.acquired) continue; // bersaglio mancato entro il timeout: contributo 0
    const t = clamp((r.time - TARGET_IDEAL_MS) / (TARGET_TIMEOUT_MS - TARGET_IDEAL_MS), 0, 1);
    const timeScore = 100 - t * 100;
    // overshoot in unità stick oltre il bordo del bersaglio: 0 -> 100, 0.35 -> 0
    const overScore = clamp(100 - (r.overshoot / 0.35) * 100, 0, 100);
    sum += timeScore * 0.7 + overScore * 0.3;
  }
  return Math.round(sum / records.length);
}

// Inseguimento: errore = distanza media puntatore-bersaglio durante il tratto utile.
// 0 -> 100, 0.40 -> 0.
function scoreTrack(meanErr) {
  return Math.round(clamp(100 - (meanErr / 0.40) * 100, 0, 100));
}

function overallScore(s) {
  return Math.round(s.steady * W_STEADY + s.targets * W_TARGETS + s.track * W_TRACK);
}

function verdictFor(score) {
  if (score >= 90) return 'Precisione eccellente';
  if (score >= 75) return 'Buona precisione';
  if (score >= 55) return 'Precisione discreta';
  if (score >= 35) return 'Precisione scarsa';
  return 'Precisione critica';
}

/* ---------------- posizione traiettoria di inseguimento ---------------- */

// Lissajous deterministica: passa per il centro e sfiora i bordi.
function trackPoint(elapsedMs) {
  const ph = (elapsedMs / TRACK_PERIOD_MS) * 2 * Math.PI;
  return {
    x: TRACK_AMP * Math.sin(TRACK_FREQ_X * ph),
    y: TRACK_AMP * Math.sin(TRACK_FREQ_Y * ph),
  };
}

// Campiona la figura per disegnarla come riferimento (un periodo completo).
function trackPathSamples(n = 160) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(trackPoint((i / n) * TRACK_PERIOD_MS));
  return pts;
}

/* ============================================================
   initGame
   ============================================================ */

export function initGame(deps) {
  const getSticks = deps.getSticks;
  const isAvailable = deps.isAvailable;

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

  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

  function setProgress(pct) {
    elProgressBar.style.width = clamp(pct, 0, 100) + '%';
  }

  function showCountdown(n) {
    elCountdown.textContent = n > 0 ? String(n) : 'Via';
    elCountdown.classList.remove('hidden');
  }
  function hideCountdown() { elCountdown.classList.add('hidden'); }

  /* ---------------- sequenza prove ---------------- */

  function startSequence() {
    scores = {
      L: { steady: 0, targets: 0, track: 0 },
      R: { steady: 0, targets: 0, track: 0 },
    };
    elIntro.classList.add('hidden');
    elReport.classList.add('hidden');
    elReportActions.classList.add('hidden');
    elDials.classList.remove('hidden');
    elProgress.classList.remove('hidden');
    canvasL.clearTrail();
    canvasR.clearTrail();
    running = true;
    enterCountdown('Fermezza', 'Lascia gli stick al centro senza toccarli.', beginSteady);
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
      showCountdown(0); // "Via"
    } else {
      hideCountdown();
      const next = phase.next;
      next();
    }
  }

  /* --- Prova 1: Fermezza --- */

  function beginSteady() {
    elPhase.textContent = 'Fermezza';
    elInstr.textContent = 'Non toccare gli stick. Misuriamo il drift residuo.';
    phase = {
      kind: 'steady',
      start: performance.now(),
      L: { sum: 0, n: 0 },
      R: { sum: 0, n: 0 },
    };
    scene = { L: { centerHold: true }, R: { centerHold: true } };
  }

  function tickSteady(ts, s) {
    const elapsed = ts - phase.start;
    setProgress((elapsed / STEADY_MS) * 100);
    if (elapsed > STEADY_SETTLE_MS) {
      phase.L.sum += Math.hypot(s.lx, s.ly); phase.L.n++;
      phase.R.sum += Math.hypot(s.rx, s.ry); phase.R.n++;
    }
    if (elapsed >= STEADY_MS) {
      scores.L.steady = scoreSteady(phase.L.n ? phase.L.sum / phase.L.n : 0);
      scores.R.steady = scoreSteady(phase.R.n ? phase.R.sum / phase.R.n : 0);
      enterCountdown('Bersagli', 'Porta entrambi i punti dentro i bersagli e tienili fermi.', beginTargets);
    }
  }

  /* --- Prova 2: Bersagli (simultanea sui due stick) --- */

  function beginTargets() {
    elPhase.textContent = 'Bersagli';
    elInstr.textContent = 'Porta i punti dentro i bersagli e mantienili per un istante.';
    phase = {
      kind: 'targets',
      index: 0,
      L: { records: [], state: newTargetState() },
      R: { records: [], state: newTargetState() },
    };
    setTargetScene();
  }

  function newTargetState() {
    return { start: performance.now(), insideSince: null, entered: false, overshoot: 0, done: false };
  }

  function setTargetScene() {
    const t = TARGETS[phase.index];
    phase.L.state = newTargetState();
    phase.R.state = newTargetState();
    canvasL.clearTrail();
    canvasR.clearTrail();
    scene = {
      L: { target: { x: t.x, y: t.y, radius: TARGET_RADIUS, locked: false } },
      R: { target: { x: t.x, y: t.y, radius: TARGET_RADIUS, locked: false } },
    };
  }

  // Aggiorna lo stato di acquisizione di un singolo stick verso il bersaglio.
  function tickTargetStick(ts, side, ux, uy, t) {
    const st = phase[side].state;
    if (st.done) return;
    const d = dist(ux, uy, t.x, t.y);
    const inside = d <= TARGET_RADIUS;

    if (inside) {
      st.entered = true;
      if (st.insideSince == null) st.insideSince = ts;
      scene[side].target.locked = true;
      if (ts - st.insideSince >= TARGET_HOLD_MS) {
        st.done = true;
        st.acquired = true;
        phase[side].records.push({
          acquired: true,
          time: ts - st.start - TARGET_HOLD_MS,
          overshoot: clamp(st.overshoot, 0, 0.35),
        });
      }
    } else {
      // overshoot = entrare nel bersaglio e poi sforare di nuovo fuori:
      // misura di quanto si è "tirato" l'ingresso, non la centratura.
      if (st.entered) st.overshoot = Math.max(st.overshoot, d - TARGET_RADIUS);
      st.insideSince = null;
      scene[side].target.locked = false;
    }

    // timeout: bersaglio mancato
    if (!st.done && ts - st.start >= TARGET_TIMEOUT_MS) {
      st.done = true;
      st.acquired = false;
      phase[side].records.push({ acquired: false, time: TARGET_TIMEOUT_MS, overshoot: 0 });
    }
  }

  function tickTargets(ts, s) {
    const t = TARGETS[phase.index];
    tickTargetStick(ts, 'L', s.lx, s.ly, t);
    tickTargetStick(ts, 'R', s.rx, s.ry, t);
    setProgress((phase.index / TARGETS.length) * 100);

    if (phase.L.state.done && phase.R.state.done) {
      phase.index += 1;
      if (phase.index >= TARGETS.length) {
        scores.L.targets = scoreTargets(phase.L.records);
        scores.R.targets = scoreTargets(phase.R.records);
        enterCountdown('Inseguimento', 'Segui il bersaglio che si muove con il punto.', beginTrack);
      } else {
        setTargetScene();
      }
    }
  }

  /* --- Prova 3: Inseguimento --- */

  function beginTrack() {
    elPhase.textContent = 'Inseguimento';
    elInstr.textContent = 'Tieni il punto sopra il bersaglio in movimento.';
    const path = trackPathSamples();
    phase = {
      kind: 'track',
      start: performance.now(),
      path,
      L: { sum: 0, n: 0 },
      R: { sum: 0, n: 0 },
    };
    canvasL.clearTrail();
    canvasR.clearTrail();
  }

  function tickTrack(ts, s) {
    const elapsed = ts - phase.start;
    const tp = trackPoint(elapsed);
    setProgress((elapsed / TRACK_MS) * 100);
    scene = {
      L: { path: phase.path, target: { x: tp.x, y: tp.y, radius: 0.10, locked: false } },
      R: { path: phase.path, target: { x: tp.x, y: tp.y, radius: 0.10, locked: false } },
    };
    if (elapsed > TRACK_SETTLE_MS) {
      phase.L.sum += dist(s.lx, s.ly, tp.x, tp.y); phase.L.n++;
      phase.R.sum += dist(s.rx, s.ry, tp.x, tp.y); phase.R.n++;
    }
    if (elapsed >= TRACK_MS) {
      scores.L.track = scoreTrack(phase.L.n ? phase.L.sum / phase.L.n : 1);
      scores.R.track = scoreTrack(phase.R.n ? phase.R.sum / phase.R.n : 1);
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
    renderReport({ L: { ...scores.L, total: totalL }, R: { ...scores.R, total: totalR }, overall }, prev);
    saveResult(overall);

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
      compare = `<p class="game-compare">Precedente ${prev} &rarr; Oggi ${res.overall} `
        + `<span class="game-delta">(${sign}${delta})</span></p>`;
    } else {
      compare = `<p class="game-compare">Primo risultato salvato. Ripeti il test dopo una calibrazione per confrontarlo.</p>`;
    }

    elReport.innerHTML = `
      <div class="game-overall">
        <span class="game-overall-num">${res.overall}</span>
        <span class="game-overall-cap">su 100</span>
      </div>
      <p class="game-verdict">${verdictFor(res.overall)}</p>
      ${compare}
      <div class="game-breakdown">
        <div class="game-stick-col">
          <h4>Stick sinistro &middot; ${res.L.total}</h4>
          ${row('Fermezza', res.L.steady)}
          ${row('Bersagli', res.L.targets)}
          ${row('Inseguimento', res.L.track)}
        </div>
        <div class="game-stick-col">
          <h4>Stick destro &middot; ${res.R.total}</h4>
          ${row('Fermezza', res.R.steady)}
          ${row('Bersagli', res.R.targets)}
          ${row('Inseguimento', res.R.track)}
        </div>
      </div>
      <p class="game-formula">Punteggio = Fermezza 25% + Bersagli 40% + Inseguimento 35%. Stessa prestazione, stesso punteggio.</p>
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
      else if (phase.kind === 'steady') tickSteady(ts, s);
      else if (phase.kind === 'targets') tickTargets(ts, s);
      else if (phase.kind === 'track') tickTrack(ts, s);
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
    elPhase.textContent = 'Test di precisione';
    elInstr.textContent = 'Tre prove, circa un minuto. Premi Inizia quando sei pronto.';
    scene = { L: {}, R: {} };
    const prev = loadPrevious();
    btnStart.textContent = prev != null ? `Inizia (precedente ${prev})` : 'Inizia';
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
    modal.classList.remove('hidden');
    startLoop();
  }

  function close() {
    stopLoop();          // niente loop fantasma
    running = false;
    phase = null;
    modal.classList.add('hidden');
    hideCountdown();
  }

  /* ---------------- wiring bottoni del gioco ---------------- */

  btnStart.addEventListener('click', () => { if (!running) startSequence(); });
  btnExit.addEventListener('click', close);
  if (btnRetry) btnRetry.addEventListener('click', () => { if (!running) startSequence(); });

  return { open, close };
}

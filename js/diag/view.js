'use strict';

// Viste del registratore diagnostico: funzioni pure che dal report (o dalle
// sue parti) producono stringhe HTML/SVG e testi. Nessun DOM, nessun timer: la
// pagina scrive il risultato con setLive. Palette: solo i token della pagina
// (classi in css/style.css), nessun colore nuovo; i due stick si distinguono
// per tratto (pieno/tratteggiato) e marcatore (pieno/vuoto), non per colore.

import { formatOffset } from '../calib/lattice.js';
import { TRACE_STILL_LSB } from './recorder.js';

const LSB_PCT = 100 / 127.5;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// m:ss dall'inizio della registrazione (mai un orario).
export function clockOf(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Lettera e nome dei marcatori sul grafico.
export const MARKERS = Object.freeze({
  connect: ['C', 'connected'],
  disconnect: ['D', 'disconnected'],
  quick: ['Q', 'Quick calibration'],
  guided: ['G', 'Guided calibration'],
  range: ['R', 'Range calibration'],
  flash: ['W', 'Write to memory'],
  restart: ['X', 'Restart'],
  'power-cycle': ['P', 'power cycle needed'],
});

function markerFor(e) {
  if (e.type === 'connect' || e.type === 'disconnect') return MARKERS[e.type];
  if (e.type === 'start' && MARKERS[e.op] && e.op !== 'drift') return MARKERS[e.op];
  if (e.type === 'power-cycle' && e.lock === 'marked') return MARKERS['power-cycle'];
  return null;
}

const radialPct = (x, y) => Math.hypot(x, y) * LSB_PCT;

// Grafico "offset a riposo nel tempo" per stick: la distanza dal centro della
// mediana di ogni secondo FERMO (spread entro la soglia di movimento), con i
// secondi in movimento come buchi nella linea; i rilasci come punti, gli
// eventi come linee verticali con una lettera.
export function diagChartSvg({ trace = [], landings = [], events = [], durMs = 0 }, { width = 640, height = 180 } = {}) {
  const pad = { l: 34, r: 8, t: 16, b: 20 };
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const span = Math.max(60_000, durMs);
  let top = 5;
  for (const row of trace) {
    for (const p of [row.l, row.r]) if (p[2] <= TRACE_STILL_LSB) top = Math.max(top, radialPct(p[0], p[1]));
  }
  for (const l of landings) top = Math.max(top, l.landPct);
  top = Math.min(20, Math.ceil(top));
  const X = t => pad.l + (Math.min(t, span) / span) * w;
  const Y = v => pad.t + h - (Math.min(v, top) / top) * h;
  const f = v => v.toFixed(1);

  const path = key => {
    let d = '';
    let prev = null;
    for (const row of trace) {
      const p = row[key];
      if (p[2] > TRACE_STILL_LSB) { prev = null; continue; }
      const cmd = prev !== null && row.t - prev <= 1000 ? 'L' : 'M';
      d += `${cmd}${f(X(row.t))} ${f(Y(radialPct(p[0], p[1])))}`;
      prev = row.t;
    }
    return d;
  };

  const parts = [];
  // Griglia: 0, il limite "centrato" (1,2%) e la cima.
  for (const v of [0, 1.2, top]) {
    parts.push(`<line class="diag-grid" x1="${pad.l}" x2="${pad.l + w}" y1="${f(Y(v))}" y2="${f(Y(v))}"/>`);
    parts.push(`<text class="diag-axis" x="${pad.l - 4}" y="${f(Y(v) + 3)}" text-anchor="end">${v}%</text>`);
  }
  parts.push(`<text class="diag-axis" x="${pad.l}" y="${height - 4}">0:00</text>`);
  parts.push(`<text class="diag-axis" x="${pad.l + w}" y="${height - 4}" text-anchor="end">${clockOf(span)}</text>`);
  for (const e of events) {
    const m = markerFor(e);
    if (!m) continue;
    const x = f(X(e.t));
    parts.push(`<line class="diag-mark" x1="${x}" x2="${x}" y1="${pad.t}" y2="${pad.t + h}"/>`);
    parts.push(`<text class="diag-mark-label" x="${x}" y="${pad.t - 4}" text-anchor="middle">${m[0]}</text>`);
  }
  const left = path('l');
  const right = path('r');
  if (left) parts.push(`<path class="diag-line diag-left" d="${left}"/>`);
  if (right) parts.push(`<path class="diag-line diag-right" d="${right}"/>`);
  for (const l of landings) {
    parts.push(`<circle class="diag-dot diag-${l.stick}" cx="${f(X(l.t))}" cy="${f(Y(l.landPct))}" r="2.5"/>`);
  }
  // Disegnato alla larghezza reale del contenitore (la pagina la passa): il
  // testo e i punti non si deformano scalando.
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}

// Etichetta accessibile del grafico: cosa mostra e l'ultimo valore per stick.
export function diagChartLabel({ trace = [], landings = [] }) {
  if (!trace.length) return 'Resting offset over time: no data yet.';
  const last = trace.at(-1);
  const now = key => (last[key][2] > TRACE_STILL_LSB ? 'moving' : `${radialPct(last[key][0], last[key][1]).toFixed(1)}%`);
  return `Resting offset over time, ${clockOf(last.t)} recorded. Now: left ${now('l')}, right ${now('r')}. ${landings.length} release${landings.length === 1 ? '' : 's'} marked.`;
}

const signed = v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;

// Righe della tabella degli ultimi rilasci, il più recente in alto.
export function landingRowsHtml(landings, count = 8) {
  return landings.slice(-count).reverse().map(l => `<tr><td>${clockOf(l.t)}</td><td>${l.stick === 'left' ? 'Left' : 'Right'}</td>`
    + `<td>x ${signed(l.landAxes[0])} · y ${signed(l.landAxes[1])}</td><td>${esc(formatOffset(l.landPct))}</td>`
    + `<td>${Math.round(l.peak)}%</td><td>${l.settleMs} ms</td></tr>`).join('');
}

// Una frase per stick dal riassunto di summarizeLandings: numeri, non un verdetto.
export function landingSummaryText(summary) {
  const line = (name, s) => {
    if (!s || s.count === 0) return `${name}: no releases yet.`;
    return `${name}: ${s.count} release${s.count === 1 ? '' : 's'}, typical stop ${s.medianPct.toFixed(1)}% from center, `
      + `stops vary by ${s.spreadLsb[0].toFixed(1)} LSB (95% within ${s.spreadLsb[1].toFixed(1)}).`;
  };
  return `${line('Left', summary.left)} ${line('Right', summary.right)}`;
}

// Riepilogo per la conferma d'invio.
export function sendSummaryText({ bytes, seconds, minutes, events, landings, trace }) {
  const kb = Math.max(1, Math.round(bytes / 1024));
  const span = seconds < 60 ? `${seconds} second${seconds === 1 ? '' : 's'}` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `About ${kb} KB: ${span} of recording, ${events} event${events === 1 ? '' : 's'}, `
    + `${landings} release${landings === 1 ? '' : 's'} and ${trace} one-second resting positions.`;
}

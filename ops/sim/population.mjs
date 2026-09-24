// Popolazione empirica: decodifica i valori `off` (ipotenusa quantizzata) nel
// reticolo di byte (|bx - 127.5|, |by - 127.5|) e fornisce statistiche target.
//
// La telemetria reale (data/telemetry/sessions.jsonl) è gitignored e non entra
// mai nel repo pubblico, nemmeno in forma derivata: i test automatici usano la
// popolazione sintetica qui sotto, gli script ops/ leggono il file reale dal
// percorso indicato da SENSE_TELEMETRY (default: data/telemetry nel checkout).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const LSB = 100 / 127.5; // 0.7843 punti percentuali per LSB
export const SRC = process.env.SENSE_TELEMETRY ?? path.join(REPO_ROOT, 'data/telemetry/sessions.jsonl');

export function loadSessions(src = SRC) {
  if (!fs.existsSync(src)) {
    throw new Error(`telemetry not found at ${src}: set SENSE_TELEMETRY to the sessions.jsonl path`);
  }
  return fs.readFileSync(src, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

export const worstOf = pair => Math.max(...pair.off);
export const plausible = r => Math.max(...r.before.off, ...r.after.off) < 15;

// Coorti del piano (§1.1). PG = dopo il guard di avvio (7c25998,
// 2026-09-16 17:17Z), senza le righe di test `fw:1234`. È la coorte canonica.
export const GUARD_CUTOFF = '2026-09-16T17:17:00.000Z';
export const COHORTS = {
  ALL: r => r.fw !== 1234,
  PG: r => r.fw !== 1234 && r.t >= GUARD_CUTOFF,
  PGP: r => r.fw !== 1234 && r.t >= GUARD_CUTOFF && plausible(r),
  MC: r => r.fw !== 1234 && r.t >= GUARD_CUTOFF && worstOf(r.before) > 1.24,
};
export function cohort(rows, name = 'PG') {
  const keep = COHORTS[name];
  if (!keep) throw new Error(`unknown cohort ${name}`);
  return rows.filter(keep);
}

// off% -> coppia reticolo [minor, major] in LSB (0.5, 1.5, ...); null se fuori reticolo
export function decodeOff(v) {
  let best = null;
  for (let a = 0; a <= 40; a++) for (let b = a; b <= 40; b++) {
    for (const h of [0.5, 0]) {
      const x = a + h, y = b + h, d = Math.abs(Math.hypot(x, y) * LSB - v);
      if (!best || d < best.d) best = { d, minor: x, major: y };
    }
  }
  return best.d < 0.02 ? [best.minor, best.major] : null;
}
export const latticeOff = (ax, ay) => Math.hypot(ax, ay) * LSB;
// bucket del worst-offset per istogrammi
export const BUCKETS = [0.6, 1.3, 2.1, 2.8, 3.6, 4.4, 6, 99];
export function bucket(v) { return BUCKETS.findIndex(b => v < b); }

// Statistiche di confronto sulle sequenze di passate. `plateau` è la quota di
// transizioni da un residuo ≥1.2 che ripetono lo stesso valore (trSame).
export function passStats(rows) {
  const n = rows.length;
  const passLen = [0, 0, 0, 0];
  const pass1Hist = new Array(BUCKETS.length).fill(0);
  let from = 0, same = 0, better = 0;
  for (const r of rows) {
    passLen[Math.min(r.passes.length, 4) - 1] += 1 / n;
    pass1Hist[bucket(r.passes[0])] += 1 / n;
    for (let k = 0; k + 1 < r.passes.length; k++) {
      if (r.passes[k] < 1.2) continue;
      from++;
      if (Math.abs(r.passes[k + 1] - r.passes[k]) < 0.05) same++;
      else if (r.passes[k + 1] < r.passes[k]) better++;
    }
  }
  return { n, passLen, pass1Hist, trSame: same / from, trBetter: better / from, trN: from };
}

export function targetStats(rows) {
  const P = rows.filter(plausible);
  const n = P.length;
  const s = passStats(P);
  s.afterPass = P.filter(r => Math.max(...r.after.off) < 1.2).length / n;
  s.after124 = P.filter(r => Math.abs(Math.max(...r.after.off) - 1.24) < 0.01).length / n;
  s.byBefore = [[0, 1.2], [1.2, 3.5], [3.5, 8], [8, 15]].map(([lo, hi]) => {
    const g = P.filter(r => { const b = Math.max(...r.before.off); return b >= lo && b < hi; });
    return g.filter(r => r.passes[0] < 1.2).length / g.length;
  });
  const nz = P.flatMap(r => r.before.noise);
  s.noiseZero = nz.filter(v => v === 0).length / nz.length;
  s.noise1 = nz.filter(v => Math.abs(v - 0.784) < 0.01).length / nz.length;
  s.n = n;
  return s;
}
// template per il replay: per stick [minor, major] del before (reticolo) + noise
export function templates(rows) {
  const out = [];
  for (const r of rows.filter(plausible)) {
    const sticks = r.before.off.map((v, i) => ({ lat: decodeOff(v), noise: r.before.noise[i] }));
    if (sticks.every(s => s.lat)) out.push({ board: r.board, sticks });
  }
  return out;
}

// Popolazione sintetica deterministica, indipendente dalla telemetria: copre
// stick al pavimento (0.555), a un passo (1.24), drift lieve e marcato, e un
// rumore diverso da zero. Serve ai test (CI non ha i dati reali) e non pretende
// di rappresentare la distribuzione reale.
const SYNTHETIC_LATTICE = [
  [[0.5, 0.5], [0.5, 0.5]], [[0.5, 1.5], [0.5, 0.5]], [[0.5, 2.5], [0.5, 0.5]], [[1.5, 2.5], [0.5, 1.5]],
  [[0.5, 4.5], [0.5, 0.5]], [[2.5, 3.5], [0.5, 0.5]], [[0.5, 0.5], [0.5, 6.5]], [[3.5, 7.5], [1.5, 1.5]],
  [[0.5, 11.5], [0.5, 0.5]], [[0.5, 1.5], [0.5, 1.5]], [[4.5, 9.5], [0.5, 2.5]], [[0.5, 16.5], [0.5, 0.5]],
];
const SYNTHETIC_NOISE = [0, 0, 0.784, 0, 1.109, 0, 0, 0.784, 0, 0, 1.568, 0];
const SYNTHETIC_BOARDS = ['BDM-010', 'BDM-020', 'BDM-030', 'BDM-040', 'BDM-050', 'SIM'];
export function syntheticTemplates() {
  return SYNTHETIC_LATTICE.map((pair, i) => ({
    board: SYNTHETIC_BOARDS[i % SYNTHETIC_BOARDS.length],
    sticks: pair.map((lat, k) => ({ lat, noise: k === 0 ? SYNTHETIC_NOISE[i] : 0 })),
  }));
}

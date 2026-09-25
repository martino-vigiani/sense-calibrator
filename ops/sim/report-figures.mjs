#!/usr/bin/env node
// Gate 5 del piano §4.2: "Report v2 reproduces the §1 figures per cohort".
// Solo sviluppo: legge la telemetria reale (SENSE_TELEMETRY), mai committata,
// e stampa solo aggregati. release-gates.mjs lo esegue insieme ai gate 2 e 4;
// da solo:
//
//   SENSE_TELEMETRY=/path/sessions.jsonl node ops/sim/report-figures.mjs
//
// Le cifre attese sono quelle di §1 del piano, con due correzioni registrate
// qui e nel README (le cifre del piano erano sbagliate, non il report):
// - after ambigui 22, non 21: 686 + 22 = 708 = 354 × 2 stick, quindi 21 era
//   un errore di somma nel piano;
// - "converged but worse" 14, non 13: convergedWorseCheck di
//   replay-sequences.mjs sulle 354 sessioni PG (12 continuano, 2 ≥15% si
//   fermano al tetto), lo stesso numero che il README riporta dal gate 4.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Cifre di §1 (coorte → metrica → valore). Le percentuali si confrontano
// arrotondate a 0.1 punti, come sono scritte nel piano.
export const PLAN_FIGURES = Object.freeze({
  PG: { n: 354, passing: 267, passingPct: 75.4, withinOneStep: 298, withinOneStepPct: 84.2, runaways: 5, worseThanStart: 14 },
  PGP: { n: 349, passingPct: 76.5, withinOneStepPct: 85.4 },
  ALL: { n: 368 },
  MC: { n: 295, passingPct: 73.9 },
  boards: { 'BDM-030': 64.5, 'BDM-020': 69.1, others: [86, 93] },
  lattice: { afterSingleAxis: 686, afterAmbiguous: 22, afterTwoAxis: 0 },
  convergedWorse: 14,
});
export const PLAN_CORRECTIONS = Object.freeze([
  'after ambiguous: 22, the plan says 21 (686 + 22 = 708 = 354 × 2; 21 was an arithmetic slip)',
  '"converged but worse": 14, the plan says 13 (replay-sequences convergedWorseCheck on PG: 12 continue, 2 stop at the 15% ceiling)',
]);

const pct1 = rate => Math.round(rate * 1000) / 10;

// Righe del gate 5 da un report v2 già costruito. `pg` è il report di default
// (coorte PG, con i sottoinsiemi plausibile e matched), `all` lo stesso senza
// il taglio del guard; `convergedWorse` il conteggio di convergedWorseCheck.
export function reportFigureRows({ pg, all, convergedWorse = null }, figures = PLAN_FIGURES) {
  const rows = [];
  const gate = (metric, value, expected) => rows.push({
    id: '5', metric, value: String(value), threshold: String(expected), pass: String(value) === String(expected), info: false,
  });
  const P = figures.PG;
  gate('PG sessions', pg.sessions.total, P.n);
  gate('PG pass <1.2 (count, %)', `${pg.publicThreshold.passingAfter}, ${pct1(pg.publicThreshold.passingRate)}%`, `${P.passing}, ${P.passingPct}%`);
  gate('PG within one step (count, %)', `${pg.withinOneStep.withinAfter}, ${pct1(pg.withinOneStep.withinOneStepRate)}%`, `${P.withinOneStep}, ${P.withinOneStepPct}%`);
  gate('PG runaways ≥15%', pg.safety.runaways, P.runaways);
  gate('PG worse than start >0.8', pg.safety.worseThanStart, P.worseThanStart);
  const pgp = pg.cohorts.plausible.metrics;
  gate('PGP sessions, pass %, within one step %', `${pgp.sessions}, ${pct1(pgp.passingRate)}%, ${pct1(pgp.withinOneStepRate)}%`,
    `${figures.PGP.n}, ${figures.PGP.passingPct}%, ${figures.PGP.withinOneStepPct}%`);
  const mc = pg.cohorts.matched.metrics;
  gate('MC sessions, pass %', `${mc.sessions}, ${pct1(mc.passingRate)}%`, `${figures.MC.n}, ${figures.MC.passingPct}%`);
  if (all) gate('ALL sessions', all.sessions.total, figures.ALL.n);
  const boards = pg.breakdowns.board;
  for (const id of ['BDM-030', 'BDM-020']) gate(`${id} pass %`, `${pct1(boards[id].passingRate)}%`, `${figures.boards[id]}%`);
  const [lo, hi] = figures.boards.others;
  const others = ['BDM-010', 'BDM-040', 'BDM-050'].map(id => pct1(boards[id].passingRate));
  const inRange = others.every(v => Math.round(v) >= lo && Math.round(v) <= hi);
  rows.push({ id: '5', metric: 'BDM-010/040/050 pass %', value: others.map(v => `${v}%`).join(', '), threshold: `${lo}–${hi}%`, pass: inRange, info: false });
  const L = pg.lattice.after;
  gate('after lattice: single axis / ambiguous / two axes', `${L.singleAxis} / ${L.ambiguous} / ${L.twoAxis}`,
    `${figures.lattice.afterSingleAxis} / ${figures.lattice.afterAmbiguous} / ${figures.lattice.afterTwoAxis}`);
  if (convergedWorse !== null) gate('"converged but worse" (replay-sequences)', convergedWorse, figures.convergedWorse);
  return rows;
}

// Costruisce i report dal file reale e ne ricava le righe.
export async function reportFigureGates(file) {
  const { buildQualityReport } = await import('../calib-telemetry/quality-report.mjs');
  const { QUICK_DEFAULTS } = await import('../../js/calib/quick.js');
  const { VARIANTS } = await import('./variants.mjs');
  const { cohort, loadSessions } = await import('./population.mjs');
  const { convergedWorseCheck } = await import('./replay-sequences.mjs');
  const text = fs.readFileSync(file, 'utf8');
  const pg = buildQualityReport(text);
  const all = buildQualityReport(text, { excludeReceivedBefore: null });
  const cw = convergedWorseCheck(cohort(loadSessions(), 'PG'), QUICK_DEFAULTS, { ...QUICK_DEFAULTS, ...VARIANTS.legacyStop });
  return reportFigureRows({ pg, all, convergedWorse: cw.legacyConvergedWorse });
}

export function telemetryFile() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const file = process.env.SENSE_TELEMETRY ?? path.join(root, 'data/telemetry/sessions.jsonl');
  if (!fs.existsSync(file)) throw new Error('set SENSE_TELEMETRY: gate 5 reads the real telemetry (aggregates only)');
  return file;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const rows = await reportFigureGates(telemetryFile());
  console.log('== gate 5 [real-data report v2 against the plan §1 figures]');
  for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'} 5     ${r.metric}: ${r.value}   [${r.threshold}]`);
  for (const c of PLAN_CORRECTIONS) console.log(`note  5     correction to the plan: ${c}`);
  process.exitCode = rows.every(r => r.pass) ? 0 : 1;
}

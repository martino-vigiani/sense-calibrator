// Discriminazione del punteggio Center del test di precisione v4 (WS8).
// Solo sviluppo. Due domande, dal piano:
//   1. sui valori "before" della telemetria, le mediane del punteggio Center
//      dei livelli Mild e Marked distano almeno 20 punti?
//   2. un cambiamento di 1 LSB sposta il punteggio di almeno 8 punti?
// Il punteggio è centerScoreFor (lattice.js), cioè quello che il test mostra
// per un offset misurato: qui si valuta la mappatura offset → punteggio su
// offset reali, non la misura (quella la coprono test/game-scoring.test.js e
// ops/sim/precision-user.mjs, model-verified).
//
//   SENSE_TELEMETRY=/path/sessions.jsonl node ops/sim/precision-discrimination.mjs [--cohort PG]
//
// La telemetria è gitignored: questo script stampa solo aggregati, e nulla di
// ciò che produce va committato.
import { centerScoreFor, decodeOff, tierForOffset, LSB_PCT } from '../../js/calib/lattice.js';

const median = a => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
};

// Zero del punteggio Center: oltre, un LSB in più non può spostare nulla.
export const CENTER_ZERO_PCT = 8;

// offsets: valori per stick (%). Ritorna mediane per livello, la distanza
// Mild–Marked e la sensibilità a 1 LSB lungo l'asse dominante (il residuo
// reale sta su un asse, F5) per gli offset che restano sotto lo zero.
export function discrimination(offsets) {
  const byTier = {};
  for (const v of offsets) {
    const t = tierForOffset(v)?.id;
    if (!t) continue;
    (byTier[t] ??= []).push(centerScoreFor(v));
  }
  const medians = Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, { n: v.length, median: median(v) }]));
  const gap = medians.mild && medians.marked ? medians.mild.median - medians.marked.median : null;

  const deltas = [];
  for (const v of offsets) {
    const d = decodeOff(v);
    if (!d) continue;
    // un LSB in più sull'asse dominante
    const next = Math.hypot(d.a + 1.5, d.b + 0.5) * LSB_PCT;
    if (next >= CENTER_ZERO_PCT) continue;
    deltas.push(Math.abs(centerScoreFor(v) - centerScoreFor(next)));
  }
  return {
    medians,
    mildMarkedGap: gap,
    oneLsb: {
      n: deltas.length,
      min: deltas.length ? Math.min(...deltas) : null,
      median: median(deltas),
      atLeast8: deltas.length ? deltas.filter(x => x >= 8).length / deltas.length : null,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadSessions, cohort } = await import('./population.mjs');
  const i = process.argv.indexOf('--cohort');
  const name = i > 0 ? process.argv[i + 1] : 'PG';
  const rows = cohort(loadSessions(), name);
  const offsets = rows.flatMap(r => r.before.off);
  const out = discrimination(offsets);
  console.log(`cohort ${name}: ${rows.length} sessions, ${offsets.length} stick "before" values`);
  for (const [k, v] of Object.entries(out.medians)) console.log(`  ${k.padEnd(14)} n=${String(v.n).padStart(4)}  median Center ${v.median}`);
  console.log(`  Mild − Marked median gap: ${out.mildMarkedGap} (required ≥ 20)`);
  console.log(`  +1 LSB on the dominant axis, below ${CENTER_ZERO_PCT}%: n=${out.oneLsb.n}, min ${out.oneLsb.min}, median ${out.oneLsb.median}, share ≥8: ${(out.oneLsb.atLeast8 * 100).toFixed(1)}%`);
}

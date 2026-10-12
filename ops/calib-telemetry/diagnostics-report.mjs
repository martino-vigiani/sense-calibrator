// Solo aggregati di diagnostiche validate; assenza storica resta ignota.
import { GUIDED_ONLY_MIN } from '../../js/calib/lattice.js';
export function diagnosticsReport(events) {
  const quick = { n: 0, withVerification: 0, withoutVerification: 0, attempts: 0, missingMeasurements: 0,
    criteria: {}, holds: {}, catastrophic: { n: 0, stableMeasurement: 0, unstableMeasurement: 0, unknownMeasurement: 0 } };
  const range = { n: 0, withCompletion: 0, withoutCompletion: 0,
    incomplete: { n: 0, reversalOnly: 0, coverageOnly: 0, rotationOnly: 0, mixed: 0, unknown: 0, byStick: { left: {}, right: {} } },
    // Il contratto ha un solo 'error' per tre storie diverse. Si separano
    // dai campi esistenti (euristica, nessun campo nuovo): `start` = rangeBegin
    // non accettato o senza risposta (nessun tracker: durS 0, copertura e giri
    // 0, niente completion); `close` = rangeEnd partito o scaduto
    // (committed); `interrupted` = sessione aperta lasciata senza rangeEnd
    // (pagina chiusa o controller staccato a metà rotazione).
    error: { n: 0, start: 0, interrupted: 0, close: 0 } };
  const count = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for (const e of events) {
    if (e.type === 'quick') {
      quick.n++;
      if (e.verification) quick.withVerification++; else quick.withoutVerification++;
      const attempts = e.verification?.attempts ?? [];
      for (const a of attempts) {
        quick.attempts++;
        if (!a.off) quick.missingMeasurements++;
        count(quick.criteria, a.criterion); count(quick.holds, a.hold);
      }
      if (e.outcome === 'catastrophic') {
        quick.catastrophic.n++;
        // Il fallback conserva l'ultima misura estrema della passata finale,
        // anche quando il gate di stabilità non l'ha accettata.
        const lastPass = attempts.at(-1)?.pass;
        const extreme = attempts.findLast(a => a.pass === lastPass && a.off && Math.max(...a.off) >= GUIDED_ONLY_MIN);
        if (!extreme || extreme.criterion === 'legacy') quick.catastrophic.unknownMeasurement++;
        else if (extreme.criterion === 'none') quick.catastrophic.unstableMeasurement++;
        else quick.catastrophic.stableMeasurement++;
      }
    } else if (e.type === 'range') {
      range.n++;
      if (e.completion) range.withCompletion++; else range.withoutCompletion++;
      if (e.outcome === 'error') {
        range.error.n++;
        const still = e.durS === 0 && !e.completion && [...e.coverage, ...e.turns].every(v => v === 0);
        if (e.committed) range.error.close++;
        else if (still) range.error.start++;
        else range.error.interrupted++;
        continue;
      }
      if (e.outcome !== 'incomplete') continue;
      range.incomplete.n++;
      if (!e.completion) { range.incomplete.unknown++; continue; }
      const reasons = new Set(e.completion.missing.flat());
      if (!reasons.size) range.incomplete.unknown++;
      else if (reasons.size === 1 && reasons.has('reverse')) range.incomplete.reversalOnly++;
      else if (reasons.size === 1 && reasons.has('coverage')) range.incomplete.coverageOnly++;
      // Bordo e lati completi, mancano giri (e forse l'inversione): non è un
      // limite fisico (RANGE_DEFAULTS.rotationUnlockMs).
      else if ([...reasons].every(r => r === 'turns' || r === 'reverse')) range.incomplete.rotationOnly++;
      else range.incomplete.mixed++;
      e.completion.missing.forEach((list, side) => {
        for (const reason of list) count(range.incomplete.byStick[side ? 'right' : 'left'], reason);
      });
    }
  }
  return { quick, range };
}

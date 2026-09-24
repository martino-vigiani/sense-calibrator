#!/usr/bin/env node
// Gate di sicurezza WS1 (quick-safety) su due uscite di run.mjs appaiate
// (stesso seed, stesso scenario, stessa n): una baseline e un candidato.
// Tutti i numeri sono "model-verified": il codice reale contro un DualSense
// simulato, mai una verifica hardware.
//
// Esito "effettivo" di una sessione, cioè cosa monta il controller alla fine
// secondo la misura dell'app:
//   - `after` se la sessione l'ha misurato;
//   - il `before` per 'already-centered' (nessun comando: lo stick resta lì);
//   - null altrimenti (preflight, stallo, passata non verificata, scollegato).
// Il pass rate "all" conta i null come fallimenti, quindi uno stallo o un
// blocco non migliorano mai il numero. Intervalli: bootstrap a cluster per
// template (score.mjs), differenze appaiate sessione per sessione.
//
//   node ops/sim/safety-gates.mjs --baseline base.json candidate.json [--boot 2000]
//        [--reference-baseline base-normal.json --reference cand-normal.json]
// `--reference*`: le uscite dello scenario 'normal' con lo stesso seed, una per
// codice (baseline e candidato). Le sessioni sono appaiate per indice (lo
// scenario aggiunge solo disturbi con un generatore proprio), quindi una
// sessione ≥15% che è ≥15% anche senza disturbo non è colpa del disturbo: è
// l'errore di cattura del firmware nel modello. Il gate "rim hold → 0" si
// legge sul conteggio attribuibile.
import fs from 'node:fs';
import { clusterBootstrap } from './score.mjs';
import { MODEL_LABEL } from './run.mjs';

const worst = pair => Math.max(...pair.off);
const f = x => (x === null || x === undefined || Number.isNaN(x) ? null : +x.toFixed(4));

export function effective(r) {
  if (r.s.after) return worst(r.s.after);
  if (r.outcome === 'already-centered' && r.s.before) return worst(r.s.before);
  return null;
}
const before = r => (r.s.before ? worst(r.s.before) : null);
const pct = (xs, q) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null);

export function safetyStats(res, { boot = 2000 } = {}) {
  const n = res.length;
  const tpl = res.map(r => r.tpl);
  const eff = res.map(effective);
  const withEff = res.filter((r, i) => eff[i] !== null);
  const passAll = eff.map(e => (e !== null && e < 1.2 ? 1 : 0));
  const final15 = eff.map(e => (e !== null && e >= 15 ? 1 : 0));
  const worse = res.map((r, i) => (eff[i] === null || before(r) === null ? null : eff[i] - before(r) > 0.8 ? 1 : 0));
  const durs = res.map(r => r.dur).sort((a, b) => a - b);
  const cmd = r => r.counts.begin + r.counts.sample + r.counts.end;
  // Ogni passata chiusa con calibEnd deve avere esattamente 12 campioni; una
  // passata interrotta (stallo, controller scollegato) resta aperta e non
  // viene mai chiusa.
  const twelveOk = r => {
    const open = r.counts.begin - r.counts.end;
    const interrupted = ['stalled', 'disconnected', 'error'].includes(r.outcome);
    if (open === 0) return r.counts.sample === 12 * r.counts.end;
    return interrupted && open === 1 && r.counts.sample - 12 * r.counts.end <= 12;
  };
  const outcomes = {};
  for (const r of res) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const replugged = res.filter(r => r.extra?.replugged);
  const startsBelowOk = res.filter(r => before(r) !== null && before(r) < 1.2);
  return {
    n,
    outcomes,
    passRateAll: clusterBootstrap(passAll, tpl, { boot }),
    passRateEffective: f(withEff.filter(r => effective(r) < 1.2).length / (withEff.length || 1)),
    withinOneStepEffective: f(withEff.filter(r => effective(r) < 1.25).length / (withEff.length || 1)),
    worseThanStart: clusterBootstrap(worse, tpl, { boot }),
    final15: clusterBootstrap(final15, tpl, { boot }),
    final15Count: final15.reduce((a, b) => a + b, 0),
    // Verità del modello: residuo reale dopo l'ultimo calibEnd applicato.
    trueFinal15Count: res.filter(r => r.trueQuant !== null && r.trueQuant >= 15).length,
    stalled: outcomes.stalled ?? 0,
    moved: outcomes.moved ?? 0,
    commandsOnStartsBelowOk: startsBelowOk.reduce((a, r) => a + cmd(r), 0),
    startsBelowOk: startsBelowOk.length,
    committedPassesWith12Samples: f(res.filter(twelveOk).length / n),
    samplesAfterTimeout: res.reduce((a, r) => a + (r.probe?.samplesAfterTimeout ?? 0), 0),
    sessionsWithSamplesAfterTimeout: res.filter(r => (r.probe?.samplesAfterTimeout ?? 0) > 0).length,
    p95DurS: f(pct(durs, 0.95) / 1000),
    maxDurS: f(durs.at(-1) / 1000),
    ...(replugged.length ? {
      replugged: replugged.length,
      commandsToB: replugged.reduce((a, r) => a + r.extra.commandsB, 0),
      // unsaved corretto: `committed` vero se e solo se A ha applicato un calibEnd
      unsavedCorrect: f(replugged.filter(r => r.committed === (r.extra.calibEndsA > 0)).length / replugged.length),
    } : {}),
  };
}

function paired(base, cand, key, { boot }) {
  const diff = cand.map((r, i) => {
    const a = key(r), b = key(base[i]);
    return a === null || b === null ? null : a - b;
  });
  return clusterBootstrap(diff, cand.map(r => r.tpl), { boot });
}

if (process.argv[1]?.endsWith('safety-gates.mjs')) {
  const argv = process.argv.slice(2);
  let baseline = null, boot = 2000, reference = null, referenceBaseline = null;
  const files = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] === '--baseline') baseline = argv[++k];
    else if (argv[k] === '--boot') boot = Number(argv[++k]);
    else if (argv[k] === '--reference') reference = argv[++k];
    else if (argv[k] === '--reference-baseline') referenceBaseline = argv[++k];
    else files.push(argv[k]);
  }
  if (!baseline || files.length !== 1) throw new Error('usage: safety-gates.mjs --baseline base.json candidate.json');
  const base = JSON.parse(fs.readFileSync(baseline, 'utf8'));
  const cand = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  if (base.sessions.length !== cand.sessions.length) throw new Error('runs are not paired');
  const passKey = r => { const e = effective(r); return e !== null && e < 1.2 ? 1 : 0; };
  const worseKey = r => { const e = effective(r), b = before(r); return e === null || b === null ? null : e - b > 0.8 ? 1 : 0; };
  let attributable = undefined;
  if (reference && referenceBaseline) {
    const read = file => JSON.parse(fs.readFileSync(file, 'utf8')).sessions;
    const high = r => { const e = effective(r); return e !== null && e >= 15; };
    const count = (runs, ref) => runs.filter(r => high(r) && !(ref[r.i] && high(ref[r.i]))).length;
    attributable = { final15NotInReference: { baseline: count(base.sessions, read(referenceBaseline)), candidate: count(cand.sessions, read(reference)) } };
  }
  console.log(JSON.stringify({
    label: MODEL_LABEL,
    ...(attributable ? { attributable } : {}),
    scenario: cand.opts?.scenario,
    baseline: { file: baseline, ...safetyStats(base.sessions, { boot }) },
    candidate: { file: files[0], ...safetyStats(cand.sessions, { boot }) },
    paired: {
      passRateAllDelta: paired(base.sessions, cand.sessions, passKey, { boot }),
      worseThanStartDelta: paired(base.sessions, cand.sessions, worseKey, { boot }),
    },
  }, null, 2));
}

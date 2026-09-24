# Headless DualSense simulator

Dev-only tooling. Nothing here is loaded by the page, and nothing here is a
runtime dependency.

The simulator runs the **real** calibration code (`js/calib/quick.js`,
`js/calib/sampling.js`, `js/calib/quick-policy.js`, `js/ds5.js`) against a
virtual DualSense whose model was fitted to the collected telemetry. A variant
is a `params` override of `QUICK_DEFAULTS`, never a patch to the code.

**Every simulator number is "model-verified".** It says what the code does
against a model of the controller. It is not hardware verification, and the
model cannot represent things nobody has measured (for example which frame the
input reports use while a calibration session is open).

## Files

| File | Purpose |
|---|---|
| `vclock.mjs` | Virtual clock: `setTimeout`/`clearTimeout`/`now`, drains real microtasks between events |
| `fake-dualsense.mjs` | WebHID-level fake: input report `0x01` at ~250 Hz, feature reports `0x82`/`0x83` with the fitted firmware model, minimal NVS (`0x80`/`0x81`), range status, unplug, fault injection, command counters. For R1 only (`ops/hw-probe`): the module calibration read `[12,2]` and write `[12,1]`, a power-cycle that restores the NVS copy, and switches for each unverified hypothesis (`MODULE_DEFAULTS`). `[12,x]` commands have their own `moduleCounts` and consume no random numbers, so the golden runs do not move |
| `population.mjs` | Loads telemetry, cohorts (`PG`, `PGP`, `ALL`, `MC`), lattice decoding, templates, synthetic population for tests |
| `harness.mjs` | Wires the fake to `parseSticks` → stick source → `runQuick` |
| `run.mjs` | Runs N sessions (optionally in worker threads) and writes a JSON output |
| `score.mjs` | Scores a run against the real cohort; cluster bootstrap by template; paired variant deltas |
| `replay-sequences.mjs` | Real pass sequences through `decideAfterPass`: where a variant stops earlier or later, and the extra irreversible passes it would request |
| `replay-telemetry.mjs` | Real sessions through `classifyOutcome` (and an optional pure renderer): which outcome each user saw |
| `fit.mjs` | Grid fit of the firmware/noise model with a minimal emulator that uses the real stop rule |
| `fits.json` | Top-3 fitted parameter sets (`best`, `alt1`, `alt2`) |
| `variants.mjs` | Named `params` overrides; `baseline` must stay empty. `legacyStop` restores the stop rule before quick-stopping-policy (paired comparisons, pre-refactor goldens); `plateau1` is the plateau-continuation candidate |
| `scenarios/*.mjs` | Extra scenarios for `run.mjs --scenario` (WS1): `forced-hold`, `rim-hold`, `moving-hold`, `noisy-hold`, `replug`, `already-centered`, `one-step`. Disturbances use their own random generator, so sessions stay paired by index with `normal` |
| `safety-gates.mjs` | WS1 safety gates on two paired runs: effective outcome, pass-rate and worse-than-start deltas (cluster bootstrap), sessions ≥15% (and how many are not ≥15% without the disturbance), commands on starts below 1.2, 12 samples per committed pass, `calibSample` after a timeout (instrumented in `harness.mjs`), replug checks, durations |
| `equivalence.mjs` | Runs the pre-refactor harness and `runQuick` on the same sessions and diffs them |
| `legacy/load-app.mjs` | The pre-refactor harness: extracts the monolithic `quickCalibrate` from `git show 40a08ed:js/app.js` |

## Data

The telemetry file is gitignored and never enters the repository, not even in
derived form. Scripts read it from `SENSE_TELEMETRY`, or from
`data/telemetry/sessions.jsonl` in the checkout. `npm test` uses only the
synthetic population and committed golden files, so it runs in CI.

## Commands

```sh
export SENSE_TELEMETRY=/path/to/data/telemetry/sessions.jsonl

# baseline, 1,785 sessions (357 templates × 5), seed 1
node ops/sim/run.mjs --n 1785 --seed 1 --out out-baseline.json          # ~1 min single thread
node ops/sim/run.mjs --n 1785 --seed 1 --workers 4 --out out-baseline.json

# a variant, paired with the baseline, and the forced-hold scenario
node ops/sim/run.mjs --n 1785 --params '{"convergeEps":0}' --workers 4 --out out-noplateau.json
node ops/sim/run.mjs --n 714 --scenario hold --workers 4 --out out-hold.json
node ops/sim/run.mjs --n 1785 --fit alt1 --seed 2 --out out-alt1-s2.json

node ops/sim/score.mjs --baseline out-baseline.json out-noplateau.json

# WS1 safety gates: run the same scenario on the old code (a `git archive` of
# the base commit with this ops/sim copied over) and on this tree, then
node ops/sim/run.mjs --n 714 --scenario rim-hold --workers 4 --out ws1-rim-hold.json
node ops/sim/safety-gates.mjs --baseline base-rim-hold.json ws1-rim-hold.json \
  --reference-baseline base-normal.json --reference ws1-normal.json

# real data, no model
node ops/sim/replay-sequences.mjs [--params '{"convergeEps":0}'] [--details]
node ops/sim/replay-telemetry.mjs [--renderer path/to/pure-renderer.mjs]

# refactor equivalence against the pre-refactor app.js
node ops/sim/equivalence.mjs --n 1785 --workers 4
node ops/sim/equivalence.mjs --n 714 --scenario hold --workers 4
```

Sessions depend only on `(seed, index)`, so worker count never changes a result.

## Reference numbers (seed 1, `best` fit, 1,785 sessions, model-verified)

| Metric | Simulator | Real PG (354) |
|---|---|---|
| Pass rate (after < 1.2%) | 0.749 (cluster CI 0.728–0.769) | 0.754 |
| Passes 1/2/3/4 | .658/.252/.027/.064 | .678/.243/.037/.042 (240/86/13/15) |
| Pass-count L1 distance | 0.061 | — |
| Plateau (next pass identical) | 0.469 | 0.516 (0.533 on all plausible sessions) |
| Worse than start (> 0.8 pt) | 0.057 | 0.040 |
| Mean / p95 duration | 9.9 s / 23.3 s | — |

The model under-produces plateaus and over-produces worse-than-start results.
Recalibrate it before trusting any gain that depends on either.

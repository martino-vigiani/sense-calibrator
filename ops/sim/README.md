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
| `equivalence.mjs` | Runs the pre-refactor harness and `runQuick` on the same sessions and diffs them. `--restricted 1` (release gate 2) compares only the sessions no WS1 rule can touch (`untouchedByWs1`, shared with `test/sim-equivalence.test.js`) and allows only the WS2 outcome changes in `ALLOWED_OUTCOME_CHANGES` |
| `release-gates.mjs` | Release gates of the plan §4.2 in one command: builds the baseline (and optionally WS1) tree with `git archive` plus this `ops/sim`, runs the fit × seed × scenario matrix on both trees (cached by a source hash), and prints every number next to its threshold with PASS/FAIL, plus gate 2 (restricted equivalence), gate 4 (real-data replay) and gate 5 (report v2 figures) |
| `report-figures.mjs` | Gate 5: builds the quality report v2 from `SENSE_TELEMETRY` (PG, PGP, ALL, MC, boards, lattice) plus the replay's converged-worse count, and compares each with the plan §1 figure; prints aggregates only |
| `range-sweep.mjs` | WS7: range coverage of one synthetic turn (8-bit quantized, stored range 0.8–1.4× off, 60/250 Hz), old rule against `js/calib/range-coverage.js`. No telemetry |
| `precision-user.mjs` | WS8: a model controller (8-bit lattice, noise, spring return, square-ish gate) and a model user who reacts to the precision test's view (lets go, flicks toward the lit mark, rolls the sticks, presses Retry/Skip) driving the real `createPrecisionTest` at ~250 Hz. Scenarios: brush, slow push, endless hold, report gap, hidden tab, no flicks. It also runs the dead-wait instrument (a stall over 2 s without a `why`). Reaction times are assumptions: durations are model-verified |
| `precision-discrimination.mjs` | WS8: Center score medians per drift tier and the 1-LSB sensitivity, on the real "before" values (`SENSE_TELEMETRY`); prints aggregates only |
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

# release gates (plan §4.2): full matrix, 3 fits × 3 seeds, ~15 min on 10 cores
node ops/sim/release-gates.mjs --baseline 57621c0 --ws1 26732b0 --dir /tmp/sense-gates --json gates.json
# an experiment: only some runs of a params variant of the candidate, no evaluation
node ops/sim/release-gates.mjs --baseline 57621c0 --dir /tmp/sense-gates \
  --params '{"refToleranceLsb":1000}' --runs-only normal,one-step

# refactor equivalence against the pre-refactor app.js (full, then restricted to
# the sessions no WS1 rule can touch)
node ops/sim/equivalence.mjs --n 1785 --workers 4
node ops/sim/equivalence.mjs --n 714 --scenario hold --workers 4
node ops/sim/equivalence.mjs --n 1785 --workers 4 --restricted 1
```

`replay-sequences.mjs` also prints `convergedWorse`: the sessions the previous
stop rule (`legacyStop`) ended as "converged" on a value worse than the start,
and whether the current rule asks for another pass on each (14 in the PG
cohort: 12 continue, 2 are ≥15% and stop at the ceiling as `catastrophic`).

## Release gates (§4.2), as re-specified on 2026-09-25

`release-gates.mjs` is the reference implementation; everything it prints is
model-verified (gate 3) or a real-data replay (gate 4). The baseline is
`57621c0` (the tree before WS1/WS2) with this `ops/sim` copied over.

Three gates of the plan could not be met as written because of the model, not
the code, and were re-specified. **The plan owner has not signed off on these
re-specifications yet**: until then they are proposals, and none of the three
may be reported as passing "as written". Their raw values are always printed as
INFO rows (3.3i, 3.4i, 3.5i).

- **Final ≥15%, normal population.** The plan asked for ≤0.1%. The model's
  first-pass capture error produces runaways on the very first `calibEnd`
  (candidate/baseline counts, all 9 fit × seed runs, after the near-ceiling
  guard below: best 16/16, 20/23, 11/11; alt1 21/21, 29/30, 15/15; alt2 3/3,
  2/2, 1/1). No Quick rule can prevent a first pass that the firmware model
  gets wrong. The gate is now **no more sessions ≥15% than the paired
  baseline**; the raw rate and the paired extras are printed as INFO. A single
  session can move either way between two trees by one LSB of capture (for
  example alt1-s1 #1309: 13.78 → [14.52, 14.52] in the baseline, [14.52, 15.3]
  in the candidate, on the ordinary pass 2 both trees run; #1092 the other
  way), which is why the gate is a count and not "0 extra".
  *Correction (review, 2026-09-25):* an earlier version of this section said
  every such session was a first-pass runaway "identical in the baseline".
  That was false for two sessions where the candidate's own **recovery
  continuation** made the crossing: normal alt1-s2 #144 (before [0.555, 8.393];
  baseline [14.52, 14.52] worse-than-start, candidate [14.52, 14.52, 15.3]
  catastrophic) and noisy-hold alt1-s3 #459 (before [2.987, 4.471]; same
  passes). The count gates hid them because another session moved the other
  way. `decideAfterPass` now takes no recovery or plateau pass within one
  lattice step of the ceiling (`QUICK_CEILING_MARGIN` = 1 LSB·√2 ≈ 1.109, reason
  `near-ceiling`); both sessions now stop at [14.52, 14.52] as in the baseline
  (model-verified, this runner). Real PG data has 0 sessions plateauing in
  [12, 15), so the real-world exposure was small.
- **Final ≥15%, forced hold.** The WS1 value was never recorded; it is now
  measured by running the WS1 tree (`26732b0`, tip of the quick-safety branch,
  with this `ops/sim`) with `--ws1`. Values (n=714, model-verified): best
  0.56% / 0.70% / 0.70%, alt1 0.84% / 1.26% / 0.98%, alt2 0.00% / 0.00% / 0.14%
  for seeds 1 / 2 / 3; baseline 1.26–2.52%. The CI bound (<1.7%) is read on
  the sessions **attributable to the hold** (≥15% with the hold and not ≥15% in
  the same session without it): at most 1 session per run, upper bound ≤0.4%.
  The raw CI upper bound exceeds 1.7% on alt1-s2 (2.0%) and alt1-s3 (1.8%)
  only because of the normal-population runaways above; it is printed as INFO.
- **Final ≥15%, rim hold.** The plan asks for 0 (a regression test). Raw
  counts (candidate / baseline, n=714, seeds 1/2/3): best 4/5, 5/5, 5/5;
  alt1 5/7, 8/9, 8/9; alt2 0/1, 0/0, 1/2. So the gate **as written fails on 7
  of 9 fit × seed runs**. Every one of those sessions is a first-pass model
  runaway that is also ≥15% in the paired normal session (no hold at all), so
  the gate counts only the sessions **attributable to the rim hold** (≥15% with
  the hold, not ≥15% in the same session without it): 0 in all 9 runs. The raw
  count, candidate against baseline, is the INFO row 3.5i. An earlier commit
  (716830c) described the matrix as "all gates PASS except 3.6 noisy hold"
  without saying that 3.5 had been re-specified; this entry corrects that.

Gate 5 (report v2 reproduces the §1 figures per cohort) runs in
`report-figures.mjs`, called by the runner with gates 2 and 4 (or alone:
`SENSE_TELEMETRY=… node ops/sim/report-figures.mjs`). It matches the plan on
every figure except two, where the plan was wrong and the expected values are
recorded as corrections: **22** ambiguous after-values, not 21 (686 + 22 = 708
= 354 × 2), and **14** "converged but worse" sessions, not 13 (the same
`convergedWorseCheck` count gate 4 prints). Gate 6 (public surface) needs
headless Chromium and is run separately: `ops/ui-check/a11y-check.mjs` and
`ops/ui-check/game-check.mjs` (Playwright passed by path; the runner prints the
commands).

Gates that stay as written and are **not claimed** for this release:

- **Final ≥15%, moving or noisy hold ≤ baseline** fails on alt1-s2 noisy hold
  (9 against 8). The extra session is #479: before 8.245, pass 1 at 14.52 in
  both trees; both trees run pass 2 (the stop rule has always continued after a
  first pass that is not at the target), and the candidate's pass 2 captured
  one LSB more (15.3 against 14.52). Unlike #144 and #459 above, #479 is not a
  recovery continuation, so the near-ceiling guard on recovery and plateau
  passes does not change it; a general "stop near the ceiling" rule on every
  pass would, but on the real PG sequences the only other session in that
  state (1.24 → 8.24 → 0.55) recovered to the floor on its next pass, so no
  such rule was added.
- **1.24 starts within 2 pp** is evaluated on the `one-step` scenario (30 real
  1.24 starts × 20, n≈680 per run), where every run passes (Δ −1.8 to +0.4 pp).
  On the ~150 1.24 starts inside the normal population the Δ is noisier
  (−5.4 to +1.3 pp) and printed as INFO. Why pass 2 after a 1.24 first pass
  recovers less often in the model is recorded below (short answer: it is
  not the 4-LSB filter); it depends on H0 and goes on the hardware list.

### 1.24 starts: why pass 2 recovers less often in the model

The review hypothesis was that WS1's in-session reference (each `calibSample`
needs a window within 4 LSB of the first in-session reading) re-captures the
same 1-LSB error. A paired run of the candidate with the filter disabled
(`--params '{"refToleranceLsb":1000}'`, normal and one-step, 3 fits × 3 seeds)
rules that out:

| 1.24 starts, pass rate | baseline | candidate | candidate, no 4-LSB filter |
|---|---|---|---|
| normal subset, 9 runs (n≈148 each) | 69.7–84.7% | 69.1–83.3% | identical to the candidate in every run |
| one-step scenario, 9 runs (n≈680 each) | 76.1–79.3% | 75.1–79.2% | within 0.2 pp of the candidate |
| pass 2 < 1.2 after a 1.24 pass 1, pooled | 993/2409 (41.2%) | 871/2215 (39.3%) | 870/2208 (39.4%) |

The lost sessions (`[1.24, 0.55]` in the baseline, `[1.24, 1.24]` in the
candidate) are the same with and without the filter. What the pairing cannot
show is the cause: `fake-dualsense.mjs` draws report timing, stick noise and
the `calibEnd` capture error from **one** random generator, so any change in
how many reports a pass reads (WS1 reads an in-session reference and waits on
report-driven windows) makes the pass-2 capture a different draw. Pass 1 stays
paired; pass 2 and later are not. The pooled difference (−1.9 pp, about 1.3
standard errors) and the one-step runs (all within 2 pp) are consistent with
that noise. Conclusion: a model artefact of pairing, not a code effect we can
see; H0-b in `docs/hardware-checks.md` checks it on hardware.

Two side effects of the filter that the same run shows (model-verified):

- "Pass 2 after a first pass ≥ 2 reaches < 1.2" falls from 4.4% to 0.5%
  (3.8% without the filter). This is selection, not harm: the first passes
  that the baseline spoiled with a touch during sampling (and then recovered)
  are refused by the filter in the candidate, which goes straight to 0.55. What
  remains ≥ 2 after pass 1 is the model's persistent capture bias, which a
  second pass rarely fixes.
- `stalled` outcomes in the normal population: 84 of 16,065 sessions with the
  filter, 21 without (0.5% against 0.1%). Each stall asks for a power cycle.
  That is the cost of never sampling a stick that moved away from the
  in-session reference; it stays, and depends on H0.

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

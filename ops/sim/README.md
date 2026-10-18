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
| `scenarios/*.mjs` | Extra scenarios for `run.mjs --scenario` (WS1): `forced-hold`, `rim-hold`, `moving-hold`, `noisy-hold`, `replug`, `already-centered`, `one-step`. Disturbances use their own random generator, so sessions stay paired by index with `normal`. Also `left-x-capture` (BDM-040 left-X capture error, see below; not part of the release gates) |
| `safety-gates.mjs` | WS1 safety gates on two paired runs: effective outcome, pass-rate and worse-than-start deltas (cluster bootstrap), sessions ≥15% (and how many are not ≥15% without the disturbance), commands on starts below 1.2, 12 samples per committed pass, `calibSample` after a timeout (instrumented in `harness.mjs`), replug checks, durations |
| `equivalence.mjs` | Gate 2 (`--restricted 1`) compares every field of 400 normal and 400 hold synthetic sessions, seed 7, to the reviewed module golden, excluding only telemetry-only `passXY`. The full historical pre-refactor comparison remains available without `--restricted`. `restrictedCompare` and `ALLOWED_OUTCOME_CHANGES` describe that historical diagnostic, not an equivalence claim for the new timing. |
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

### Gate 2 rebaseline (second audit, 2026-09-28)

The 300 ms fully observed hold changes the phase of synthetic noise even for
sessions once called `untouchedByWs1`. With the old pre-refactor reference,
1,016 of 1,031 restricted real-template sessions changed fields; 29 changed
outcome (`centered → within-1-step` 22, `centered → preflight` 4,
`centered → worn` 3). Those differences are **model-verified**, not hardware
evidence and not a pass of the old equivalence criterion. The explicit
`ALLOWED_OUTCOME_CHANGES` checks require a measured one-step result, a
preflight with no Begin, or noise above the worn threshold respectively.
The revised gate pins the corrected algorithm on 800 synthetic sessions and
compares before/after medians, pass counts, gate values, command counts,
true residual and outcomes field by field. Regenerate only after reviewing a
deliberate algorithm change:

```sh
node ops/sim/equivalence.mjs --restricted 1 --refresh-golden 1
node ops/sim/equivalence.mjs --restricted 1
```

### Gate 2 rebaseline (Quick preflight wait, 2026-10-12)

The first Quick wait went from 3 s to `preflightTimeoutMs` = 8 s, with an
early stop after 3 s of sticks held still past the 15% radius, and preflight
sessions now carry `preflight: { stage, reason, side?, offset? }`. Before the
refresh, the new code against the old goldens changed **only sessions that
were `preflight` in the golden** (0 other sessions): normal
`preflight>centered` 1 and one preflight with new fields; hold
`preflight>centered` 1, `preflight>within-1-step` 1, `preflight>stalled` 1.
Paired runs on 714 real-template sessions per scenario (seed 1; old timing as
`{"preflightTimeoutMs":3000,"preflightOffCenterMs":1e12}`): preflight 24 → 17
(normal, rim-hold, moving-hold, noisy-hold) and 33 → 27 (hold, forced-hold);
final ≥15% unchanged (4 → 4, attributable 0 → 0 on rim-hold), no
`calibSample` after a timeout, worse-than-start delta 0, one more `stalled`
per 714 in four scenarios (a rescued start disturbed later in pass 1). All
model-verified.

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

# Historical pre-refactor comparison (diagnostic; full equivalence no longer
# expected after the 300 ms hold). Gate 2 uses the corrected synthetic golden.
node ops/sim/equivalence.mjs --n 1785 --workers 4
node ops/sim/equivalence.mjs --n 714 --scenario hold --workers 4
node ops/sim/equivalence.mjs --restricted 1
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

## Left-X capture error (BDM-040, 2026-10-18)

Scenario `left-x-capture` (`scenarios/left-x-capture.mjs`). **Model-verified, pending hardware check
R1-X in `docs/hw-probe-bdm040.md`: nothing here says the firmware does this.** It is not in the
release-gates matrix; that is the plan owner's decision.

**What it models.** The left stick has a persistent capture error on X: each `calibEnd` writes the
center `B` LSB to the +X side of where the stick rested during the samples, so the output after the
pass reads about −`B` and Y comes out exact. The fitted random bias of the left stick is switched
off; the right stick is the normal model. `B` is drawn once per session and moves at each later
`calibBegin` (jumps of 0, a few LSB, or rarely tens of LSB). With the real population only the
`BDM-040` templates are used; the synthetic one keeps all of them. It uses only the scenario's own
generator (`r2`), always the same number of draws, so sessions stay paired by index with `normal`.

**Why.** Telemetry v2, 27 Sep–18 Oct 2026 (aggregates only): on some BDM-040 controllers Quick,
Guided and Range leave the left stick X toward −X with Y exact, and 5 of the 6 catastrophic
(≥15%) Quick sessions are BDM-040. The fitted model draws the bias axis and sign at random, so it
never produces that direction. Parameters come from the aggregates (56 verified passes in 10
affected visits), not from the rows: the header of the scenario file lists them.

**Fit to the aggregates (model-verified, 714 BDM-040 sessions, seed 1, default params).**

| Quantity | Model | Observed |
|---|---|---|
| Passes within ±1 half-LSB | 11% | 7/56 (12.5%) |
| Bulk (below −1 half-LSB), median | −21 half-LSB | −21 |
| Passes at −47 half-LSB or beyond | 2.9% | 2/56 (3.6%) |
| Jumps between consecutive passes: 0 / 1–2 / 3–6 / 7–10 / >10 half-LSB | 34 / 35 / 25 / 2 / 4% | 38 / 28 / 24 / 7 / 3% |
| First pass ≥15% | 10.3% (68/662) | 4/27 (15%) |
| Later pass ≥15% | 4.5% | 1/29 (3%) |
| Sessions with final true residual ≥15% | 16.7% (seeds 2 and 3: 16.1%, 16.8%) | 18.5% (scratch model: 16%) |

What was tuned (7 runs of 714 sessions on the real BDM-040 templates; the aggregates above were
the target): `zeroP`, the share of sessions with `B`≈0, 0.12 → 0.25, because sessions with no error
stop after 1–2 passes, so a 12% share of sessions gave only 4–5% of passes within ±1 half-LSB; the
lognormal `sigma` 0.55 (median fixed at the observed 10.5 LSB), which brings the tail and the
session rate close (sigma 0.45 gave 19% with the first jump values, 0.35 gave 16%, with a thinner
tail than observed); the jump probabilities 0.4 / ±1–5 LSB → 0.60 / ±0.5–3.5 LSB, because the
fake's own firmware noise (`sf`) and the 8-bit lattice already add spread: the first values gave
22% of jumps of 7–10 half-LSB against 7% observed and only 22% of zero jumps against 38%. The
first-pass ≥15% share stays under the observed one (4/27 is a small sample); raising it needs a
heavier tail and overshoots the session rate.

**What the code does with it (model-verified, 714 sessions, seed 1).**

| `maxPasses` | Final true residual ≥15% | `catastrophic` outcome | Mean `calibEnd`s | Final true residual <1.25% | Centered outcome |
|---|---|---|---|---|---|
| 4 (default) | 16.7% | 16.5% | 2.48 | 22.3% | 21.1% |
| 2 | 12.2% | 12.0% | 1.56 | 21.6% | 20.7% |
| 1 | 9.7% | 9.5% | 0.93 | 22.1% | 18.9% |

Other outcomes at the default: worse-than-start 30.8%, residual-deterministic 12.3%, residual 5.7%,
already-centered 3.4%, preflight 3.2%, lost-ground 2.9%, within-1-step 1.1%, stalled 1.0%, worn
1.0%, moved 0.8%. Of the 119 sessions ≥15% at the default, 97 end on left −X, 21 on left +X (a
rare large jump crosses zero) and 1 elsewhere. The synthetic population gives the same picture (15.8%
catastrophic at 4 passes, 12.0% at 2, 9.7% at 1). Going from 1 to 4 passes adds 7 points of final ≥15% (9.7% → 16.7%) and 2 points of centered outcome (18.9% → 21.1%): 68 of
the 119 sessions at the default are over the ceiling after pass 1 already. More passes also
keep writing the same error, which is why the model cannot show an advantage for them here.

**Left-X signature: one-pass cap, in-run stop off (2026-10-19).** The page remembers a controller
whose verified Quick pass or done Guided showed the signature (`hasLeftXSignature`: left X ≤ −4 LSB,
|left Y| ≤ 1 LSB, right stick within one step) and runs later Quicks on it with `maxPasses: 1` (the
`maxPasses` 1 row above; the simulator has no visits, so the cap is not run here). A stop inside the
run (`leftXSignatureStop`) exists only as a simulator switch and is **off by default**: the model
favours it, real data does not (replay below), and worse-than-start rises even in the model. The
gate 2 goldens are unchanged. Paired runs with the switch, off → `--params '{"leftXSignatureStop":true}'`
(model-verified, 714 sessions):

| Scenario, seed | Final true residual ≥15% | `catastrophic` | Final true residual <1.25% | Centered outcome | Worse-than-start | Mean `calibEnd`s | Signature stops |
|---|---|---|---|---|---|---|---|
| left-x-capture, 1 | 16.7% → 10.9% | 16.5% → 10.8% | 22.3% → 21.8% | 21.1% → 20.9% | 30.8% → 37.0% | 2.48 → 1.16 | 383 |
| left-x-capture, 2 | 16.1% → 11.3% | 16.1% → 11.3% | 21.8% → 21.3% | 18.9% → 18.6% | 32.1% → 38.1% | 2.51 → 1.19 | 390 |
| left-x-capture, 3 | 16.8% → 11.5% | 16.8% → 11.5% | 22.0% → 21.1% | 20.2% → 19.9% | 31.0% → 37.4% | 2.49 → 1.19 | 387 |
| normal, 1 | 0.6% → 0.6% | 0.6% → 0.6% | 76.2% → 76.2% | 66.7% → 66.7% | 4.1% → 4.1% | 1.39 → 1.37 | 8 |
| hold, 1 | 1.1% → 1.1% | 0.7% → 0.7% | 74.6% → 74.6% | 67.5% → 67.5% | 3.8% → 3.8% | 1.38 → 1.35 | 8 |
| rim-hold, 1 | 0.6% → 0.6% | 0.6% → 0.6% | 76.2% → 76.2% | 67.5% → 67.5% | 3.6% → 3.6% | 1.40 → 1.38 | 9 |

Worse-than-start rises on left-x-capture because sessions that used to end over the ceiling
(`catastrophic` takes precedence) now end on their first pass, which is often worse than the start.
On the stopped sessions the true residual is better in 130–147, the same in 117–135 and worse in
105–128 of about 385 (mean −1.7 to −2.4 points); 3–6 of them would have ended centered with more
passes. In normal, hold and rim-hold the safety gates (`safety-gates.mjs`) are identical on and off:
final ≥15% 4/5/4, attributable 0/1/0, pass rate and worse-than-start deltas 0, 12 samples per commit,
no sample after a timeout; the 8–9 stopped sessions change only `residual-deterministic` ↔ `residual`
labels and the true residual by −0.17 to +0.10 points on average.

**Real-data replay (v2 events 27 Sep–18 Oct, 1,106 Quick events with `passAxes`, aggregates only).**
Verified passes with the signature: BDM-040 40/206, BDM-030 1/277, every other board 0. 18 sessions
show it (17 BDM-040, 1 BDM-030), 17 on pass 1. 13 would have stopped earlier (12 BDM-040), 28 passes
fewer. Their 27 later passes: none reached 15%, 1 was within one step (5.11 → 0.55 on pass 4), 13
were better than the signature pass, 10 worse, 4 the same; final against the stop point: better 6
(two by more than a point), same 4, worse 3. The 4 catastrophic sessions with the signature were
already ≥15% on that pass, so the stop prevents none of the real catastrophic results. Across runs
(same visit and board, after a Quick or a done Guided with the signature; Guided showed it on BDM-040
7, BDM-050 5, BDM-010 1): 15 later Quicks, 8 with more than one pass; their 13 passes after the
first: 1 reached 15% (one of the 6 catastrophic results), none within one step, 5 better and 5
worse than pass 1. So the cap would have prevented one real catastrophic result and lost no centered
one, while the in-run stop would have prevented none and given up one centering and two improvements
of more than a point: that is why it ships off.

Run it with `node ops/sim/run.mjs --n 714 --scenario left-x-capture --workers 4 --out left-x.json`
(real population needs the telemetry; add `--population synthetic` without it). The test
`test/sim-left-x-capture.test.js` covers the draw, the pairing and the bias placement on the
synthetic population.

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

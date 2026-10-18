# R1-X: the left-stick X capture error on BDM-040

**Status: research only, not run on hardware.** This extends [R1](hw-probe-protocol.md) to one
question. The steps listed under *Probe changes* are implemented in `ops/hw-probe/` and
model-verified against the fake firmware (`test/hw-probe.test.js`); none has run on a real
controller. Nothing here ships in `js/`, and the irreversibility invariant in `CLAUDE.md` stays in
force.

## Why

Telemetry v2, 27 Sep–18 Oct 2026 (aggregates only, the file stays out of the repo):

- 6 of 672 committed Quick sessions ended catastrophic (verified residual ≥15%). 5 are BDM-040.
  In all 6 the **left** stick ended pushed toward **−X** and its Y read exactly centered; the right
  stick ended at the floor.
- A verified pass leaving left X at −4 LSB or beyond: 43 of 206 BDM-040 passes, about 1 per other
  board. Those 43 sit in 10 of 79 BDM-040 visits: it follows the controller.
- On the same controllers Guided and Range leave the same −X residual (−8 to −16 LSB).
- Within a session the residual barely moves (consecutive passes: 11 of 29 identical, 22 of 29
  within 2 LSB). The large jumps come mostly on the first pass of a session (4 of 27), rarely
  later (1 of 29).
- Starting drift on BDM-040 has no direction preference, and the resting windows of those visits
  show no contact jumps (see `js/calib/contact-fault.js`).

The simulator (model-verified) reproduces the rate with a persistent per-session capture error on
left X (16% catastrophic sessions against 18.5% real). The fitted model in `ops/sim/fits.json`
draws the bias sign and axis at random and never produces the direction. That fits the
hypothesis but does not prove it: the hardware has to.

## Hypotheses

| Code | What happens | What the probe would see |
|---|---|---|
| **X1** capture error | The firmware writes a left X center several LSB to the +X side of where the stick rested during the samples. | Stick untouched, `[12,2]` LX moves more than the measured offset needs; the output after the pass is about −error. Writing the computed ideal LX brings the output to 0. |
| **X2** non-linear mapping | The center is right, but the output does not respond linearly to it, or the range edges are asymmetric. | H-e on LX: R² < 0.9, or the +/− slopes differ by more than 25%; LL and LR not symmetric around LX. |
| **X3** the stick moves | The rest point changes by itself or depends on the release direction. Calibration cannot hold. | Output drifts while untouched, or landing medians differ by release direction. |
| **X4** in-session frame | The reports read during the session (H0) put the reference and the samples somewhere else. | In-session means differ from the pre-session output by more than the in-session noise, together with X1. |

More than one can be true. X1 is the only one with a software fix (write the right center).

## Controller

- A **spare** BDM-040 that shows the signature. Never Martino's controller.
- To check a candidate before using it (on the public page, it is a spare): drift test, then one
  Quick. The signature is a left X after-value of −4 LSB or beyond (≥3.1% on that axis) with Y at
  the floor. Telemetry puts it at about 1 BDM-040 in 8; it is not visible before connecting. The
  page shows the board after connecting.
- Write down the starting state, but do **not** Write to memory on the public page. NVS must stay
  as it came, so that a power-off restores it.

## Order

1. **R1 first** ([hw-probe-protocol.md](hw-probe-protocol.md)) on this controller: preflight, H-a,
   H-b, H-c, restore, H-e, H-f. R1-X starts only if read-back and restore are GO **and** H-f shows
   that a power-off brings RAM back to the baseline with NVS locked. Without that, a bad pass in
   R1-X cannot be undone: stop.
2. Power-cycle, Connect, Preflight (NVS `locked`), Arm, then **H-e again**: X-pass and X-fix use
   the slope `u` measured on the same connection and refuse without it.
3. The R1-X steps below, in order. Hands off both sticks except in X-release.
4. Power-cycle, Connect, Preflight, then H-f-check against the R1 baseline. Download the JSON.

## Steps

| # | Step | Writes? | What it records |
|---|---|---|---|
| 1 | **X-idle** | no | 5 min hands-off: per second, the median and spread of each axis; total drift of left X (first minute vs last minute). Fresh reports only: continuous reports (no gap over 100 ms) must cover at least 95% of the run and each of the two minutes needs at least 100 reports, otherwise the step is marked incomplete and the rules treat X-idle as missing. |
| 2 | **X-release** | no | Flick the left stick and let go, 3 times in each of 8 directions (the page prompts the direction). Each landing via `createLandingDetector` (`js/calib/landing.js`); median landing per direction. A landing counts only if the deepest point of that flick lies within ±45° of the prompted direction; otherwise it is recorded as `wrong-direction` and left out of the medians. |
| 3 | **X-pass** ×5 | RAM | Each pass as H-b (centered hold, in-session reference, 12 samples, `calibEnd`), plus: the window mean of every sample, the reference, the pre-session output; then `[12,2]` and the output. Per pass: `ΔLX`, `ΔLY`, `outBefore`, `outAfter`, the ideal ΔLX (`outBefore.lx × u`, u = the H-e slope from R1 on this controller) and the capture error `E = (ΔLX − idealΔLX) / u` in LSB. Restore the R1 baseline with `[12,1]` (and read it back) before the first pass and after each pass, so the 5 passes start from the same point. |
| 4 | **X-fix** | RAM | From a fresh read: measure the output, prompt one flick-and-release, measure again, and write only if left X agrees within 1 LSB between the two (a thumb resting still on the stick gives a steady but wrong reading that a release does not repeat). Then write `LX_ideal = LX + out.lx × u` (and the same for LY if |out.ly| ≥ 1 LSB), only on the left stick. Read back (exact?), then the output at once, after 60 s untouched, and after 8 flick-and-release landings. |
| 5 | **X-replug** | no | Unplug the USB cable, wait 5 s, plug it back in (no power-off), Connect, Preflight: `[12,2]` and the output. This is also H11. |
| 6 | Power-cycle + **H-f-check** | no | Back to the R1 baseline? |

X-pass restores between passes because a capture error that only shows up once would otherwise be
hidden by the next pass's starting point. If a pass ends with the output at 15% or more, stop there
and go to step 6. The probe restores the baseline first, but any X-pass stop with RAM changed or
uncertain (the 15% ceiling, no output after a pass, a restore that does not read back, an HID error)
marks the connection for a power-cycle: every later write step is refused until the controller is
turned off and reconnected.

## Decision rules

**X1 confirmed** if all of these hold:

- X-idle: left X moves by at most 1 LSB between the first and last minute;
- in at least 3 of the 5 passes, |E| ≥ 4 LSB on LX with the same sign every time, and the output
  after the pass is within 1 LSB of −E;
- on LY and on the right stick, |E| ≤ 1 LSB;
- the window means of the samples are within 1 LSB of the in-session reference (the stick was still
  where the firmware sampled it).

**Fix works** (X1 has a software fix) if X-fix reads back exactly and the output on left X is
within 1 LSB of 0 at once, after 60 s, and in the median of the landings.

**X2** if the R1 H-e fit on LX has R² < 0.9, or the +/− slopes differ by more than 25%, or
`(LR − LX)` and `(LX − LL)` differ by more than 10%.

**X3** if X-idle drifts by more than 2 LSB, or the X-release medians differ by more than 2 LSB
between opposite directions on X. Then a center write cannot hold; the copy should say so and
suggest a deadzone or a stick replacement.

**X4** (= H0 on this controller) if the in-session window means differ from the pre-session output
by more than 2 LSB on any axis. Record it in `hardware-checks.md` under H0.

**X-replug** answers H11 for RAM: `[12,2]` identical before and after a replug means a USB unplug
keeps the calibration.

## What each outcome would change

- **X1 and fix works:** a separate workstream can propose a Quick step that reads `[12,2]` after
  `calibEnd`, computes the ideal center from the verified output, and writes it with `[12,1]`. That
  brings a `[12,1]` write into `js/`, so it needs its own plan, the R1 GO on more than one
  controller, simulator gates with this error in the model (a scenario `left-x-capture`), and a
  telemetry build bump. Not before.
- **X1 without a working fix:** keep the routing as it is. Recognise the signature per controller
  (salted key, memory only), cap Quick at 1 pass on it, and say that calibration may not fix it.
  The model-verified simulator puts that cap at 16% → 7% catastrophic for nearly the same share
  of centered results. That figure leans on a single real jump (a 5.6% pass followed by 100%).
- **X2:** look at the range edges first (Range, H12). No center write.
- **X3:** say it is the hardware, suggest a deadzone and a Hall-effect or TMR stick module.
- **None of these (no signature in 5 passes):** inconclusive on this controller; the signature may
  need wear or temperature that the session did not reproduce.

## Probe changes needed

All in `ops/hw-probe/`, none in `js/`:

1. **Steps** `X-idle`, `X-release`, `X-pass`, `X-fix` and `X-replug` in `protocol.mjs`, each with
   its own entry in `evaluate()` and in the downloaded record (`PROBE_SCHEMA` → `sense-hw-probe/2`).
2. **Per-sample window means** in `pass()`: what the probe already waits for, kept instead of
   thrown away.
3. **X-fix write rule** in `safety.mjs`. Today `checkWriteValues` allows a center only within
   ±512 units of a snapshot (`MAX_CENTER_DELTA`); a 20-LSB correction at an unknown scale can
   exceed it. The new rule allows a larger delta only for `X-fix`, only on LX/LY, only when R1
   H-e on **this connection** fitted LX with R² ≥ 0.9, and only up to 24 LSB × |u|. The range
   edges must stay identical. Every other step keeps ±512.
4. **Tests** in `test/hw-probe.test.js` against the fake, with a `left-x-capture` switch in
   `MODULE_DEFAULTS` (a fixed +X bias on left X at `calibEnd`) so the probe can tell X1 from X3,
   and an X-fix refusal test for every condition in point 3.
   `test/hw-probe-public-surface.test.js` must still pass.

## Results (to fill in)

| Field | Value |
|---|---|
| Date | |
| Controller (board, firmware, build date) | |
| R1 read-back / restore / H-f | |
| u (LX) and R² from H-e | |
| X-idle drift (left X, LSB) | |
| X-release medians by direction (left X) | |
| X-pass E per pass (LX, LY) | |
| X-fix read-back exact, output (now, 60 s, landings) | |
| X-replug: `[12,2]` identical | |
| Power-cycle back to baseline | |
| JSON file | |

### Verdict

- X1 / X2 / X3 / X4: **pending hardware run**
- Fix works: **pending hardware run**
- Decided by / date:

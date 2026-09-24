# R1: calibration read-back probe protocol

**Status: research only.** Nothing described here ships in `js/`. The public page has no
`[12,1]` write path, and `test/hw-probe-public-surface.test.js` keeps it that way. The
`CLAUDE.md` invariant ("a worse pass is irreversible") **stays unchanged** until this protocol has
been run on hardware, the go/no-go at the end is filled in, and a separate workstream implements
read-back in the product.

- Page: `ops/hw-probe/index.html` (localhost only)
- Logic: `ops/hw-probe/protocol.mjs`, `safety.mjs`, `module-cal.mjs`
- Firmware model: `ops/sim/fake-dualsense.mjs` (`MODULE_DEFAULTS`)
- Tests: `test/hw-probe.test.js`, `test/hw-probe-public-surface.test.js`

## Why

Upstream (dualshock-tools, `ds5-controller.js`) reads the calibration in controller RAM with
feature `0x80 [12,2]` → `0x81` and writes it with `0x80 [12,1, 12 × uint16 LE]`. The 12 values are
`LL LT RL RT LR LB RR RB` (range edges) and then `LX LY RX RY` (centers). If our DualSense
firmware behaves the same way, three product changes become possible:

1. snapshot before a Quick pass and restore the best state (the worse-pass problem, F2 and F5);
2. a sub-LSB center correction for results stuck at 1.24% (one axis 1 LSB off);
3. fewer samples per pass, if the firmware does not benefit from 12.

None of this has been checked on our hardware. The questions:

| Question | Step |
|---|---|
| Is `[12,2]` accepted and stable at rest? | H-a |
| Does a Quick pass (`0x82`) change exactly the centers that `[12,2]` reads? | H-b |
| Does writing a snapshot back with `[12,1]` restore it exactly, and does the output follow? | H-c |
| What does `calibEnd` with 0 samples do (the `calibBegin` repair path)? | H-d |
| How many 16-bit units move the output by 1 LSB, with which sign? | H-e |
| With NVS locked, does a power-cycle revert every RAM change? | H-f |
| Is 4 samples per pass as good as 12? | A/B |

## Safety rules (enforced in code)

- **Spare controller only.** Never the controller Martino plays with. H-c and H-d are treated as
  possibly permanent.
- **Localhost only.** `ops/` is published by GitHub Pages with the rest of the repo, so the page
  checks `location.hostname` first. Anywhere else it shows a refusal and does not even load the HID
  code (`probe.mjs` imports only `safety.mjs` statically). It is not linked from any page, carries
  `noindex, nofollow`, and `robots.txt` disallows `/ops/`. On the project-pages URL
  (`…github.io/sense-calibrator/`) crawlers ignore that robots file, so the `noindex` meta and the
  missing links are what actually keep it out of search. A CSP with `connect-src 'none'` blocks
  every network request from the page.
- **Armed per connection.** Write steps stay disabled until the person ticks "spare controller"
  and types `SPARE`. A reconnect disarms.
- **Every write step asks again** (a native confirm dialog). H-c and H-d say "PERMANENTLY".
- **NVS must be `locked`.** The preflight aborts otherwise, and the NVS status is re-read right
  before every write step. With NVS unlocked, a "temporary" write could land in memory.
- **Only values read from this controller.** `[12,1]` accepts only a snapshot read on this
  connection (or the first connection's baseline for the same controller), with the range edges
  identical and each center within ±512 units of the snapshot.
- **No NVS writes.** The probe never unlocks NVS and never flashes. A test scans `ops/hw-probe/`
  for `nvsUnlock`, `.flash(` and `[3,2]`.
- **Quick invariants in the probe's own passes.** A centered hold before every `calibBegin`, a
  sample only after a stable window near the in-session reference, never a `calibSample` after a
  timeout, never a `calibEnd` on an incomplete pass. A stalled pass marks the connection "needs
  power-cycle", and every write is refused until the controller is reconnected.
- **Timeouts poison the connection** (the `DS5` class, unchanged). The step is marked `poisoned`
  and the evaluation says "no-go" until a clean rerun.
- **The serial is never recorded.** It is kept in memory only, to recognise the same controller
  after the power-cycle. The exported JSON has board, firmware version and build date only.

## Setup

1. Use a **spare** DualSense, charged, on a USB data cable. Close every other page using WebHID
   (including Sense Calibrator).
2. Power-cycle it (hold PS for 10 s, then press PS), so RAM matches NVS before the baseline.
3. From the repo root: `python3 -m http.server 8741`, then open
   `http://localhost:8741/ops/hw-probe/` in desktop Chrome or Edge.
4. Put the controller flat on the desk. **Hands off both sticks during every step.**

## Steps, in order

| # | Button | Writes? | What to record |
|---|---|---|---|
| 0 | Connect | no | Board, firmware, build date |
| 1 | Preflight | no | NVS status (must be `locked`), baseline `[12,2]` values, `p2` |
| 2 | H-a | no | Three reads identical? |
| 3 | Arm | no | Tick the box, type `SPARE` |
| 4 | H-b | RAM | Which fields changed, output before and after |
| 5 | H-c | RAM, possibly permanent | Read-back exact? Output back within 1 LSB of the baseline? |
| 6 | H-d | RAM, possibly permanent | `unchanged` or `changed`, and which fields |
| 7 | Restore | RAM | Back to the baseline |
| 8 | H-e | RAM, restored at the end | `unitsPerLsb` and R² per axis, cross-talk, `restored: true` |
| 9 | A/B (5 per arm) | RAM, restored at the end | Center SD and residual per arm |
| 10 | H-b again | RAM | Leaves RAM different from the baseline, on purpose |
| 11 | H-f (1) | no | Snapshot before the power-cycle |
| 12 | Power off (hold PS 10 s), power on, Connect, Preflight | no | New connection, NVS `locked` |
| 13 | H-f (2) | no | `revertedToBaseline`, `unchangedFromPreCycle` |
| 14 | Download JSON | no | Keep the file with the results below |

If H-f (2) shows the calibration survived, arm again and press **Restore**, then power-cycle once
more and re-read.

The A/B takes about 5 × 2 passes. With 5 passes per arm it is still a small sample: treat a "pass"
as a candidate for the simulator gates, not as a decision.

## Decision rules

`protocol.mjs` `evaluate()` applies these rules to the record and shows the result on the page.
The written verdict below is Martino's, not the page's.

**Read-back and restore: GO** only if every item holds:

- the preflight read passed validation with NVS `locked` on every connection, and no command timed
  out;
- **H-a:** three reads at rest are identical;
- **H-b:** after a pass, at least one center value changed and **no** range edge changed. If the
  output moved by ≥1 LSB and no center changed, `[12,2]` does not read the calibration: NO-GO. If
  nothing changed at all, the result is inconclusive: repeat on a stick with a visible offset;
- **H-c:** the read after the write-back equals what was written, field by field, and the output
  returns within 1 LSB per axis of the baseline;
- **H-f:** with NVS locked, a power-cycle brings RAM back to the baseline. If RAM equalled the
  baseline before the power-cycle, the result is inconclusive.

Any failure is **NO-GO**. Missing steps give **incomplete**.

**Sub-LSB correction (research): GO** only with read-back GO and, in H-e, every axis with R² ≥ 0.9,
|units per LSB| ≥ 2 and the same sign on every axis. The magnitude says whether a sub-LSB step
exists at all.

**Sample count:** "4 is enough" is a candidate only with ≥5 passes per arm, the 4-sample center
SD ≤ 1.5 × the 12-sample SD + 1 unit, and a mean residual no more than 0.5 LSB larger, on every
axis. Even then, `QUICK_DEFAULTS` stays at 12 until the model-verified simulator gates pass
(plan §3: "don't cut samples below 12 without the R1 hardware A/B").

**H-d** is descriptive. It tells us what the `calibBegin` repair path writes today.

## Caveats

- The single-axis premise (F5) carries the "21 ambiguous" caveat: 686 after-values decode to one
  axis, 21 are ambiguous, 0 decode unambiguously to two axes. A per-axis correction must not
  assume the second axis is always exact.
- One spare controller is one board and one firmware. A GO covers that combination only. The
  telemetry has BDM-010 to BDM-050 and three firmware versions (97% on `0x110002a`).
- H0 (which frame the input reports use while a session is open) is a separate hardware check and
  is not answered here.
- `p2 == 4` in the `[12,2]` reply is accepted, as upstream does, and recorded. Nobody knows what it
  means.

## The fake firmware (model only)

`ops/sim/fake-dualsense.mjs` answers `[12,2]` and applies `[12,1]` with **assumed** behaviour
(`MODULE_DEFAULTS`): 64 units per LSB (a placeholder), centers at mid-scale, `p2 = 2`, writes that
land in RAM, a power-cycle that restores the NVS copy, and a flash (unlock then lock) that updates
it. Each assumption has a switch (`writeApplies`, `zeroSampleEnd: 'keep' | 'raw'`, `lastN`,
`readP2`, `unlockedWritesPersist`), and the tests check that the probe tells the hypotheses apart.
Every result against the fake is **model-verified**, never hardware-verified. Nothing here was run
on a real controller.

`ops/hw-probe/smoke-headless.mjs` drives the page in headless Chromium, with a fake
`navigator.hid` backed by the same model (see the file for the command).

## Results (to fill in after the hardware session)

| Field | Value |
|---|---|
| Date | |
| Controller (board, firmware, build date) | |
| NVS at preflight | |
| `p2` | |
| H-a identical | |
| H-b fields changed / range untouched | |
| H-c exact / output within 1 LSB | |
| H-d behaviour | |
| H-e units per LSB (LX, LY, RX, RY), R² | |
| H-f reverted to baseline | |
| A/B center SD (12 / 4), residual (12 / 4) | |
| JSON file | |

### Go / no-go

- Read-back and restore: **pending hardware run**
- Sub-LSB correction: **pending hardware run**
- Sample count: **pending hardware run** (keep 12)
- Decided by / date:

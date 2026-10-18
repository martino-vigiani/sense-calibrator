# ops/hw-probe: calibration read-back probe (research, localhost only)

A dev-only page for workstream R1. It checks whether the DualSense calibration in RAM can be read
(`0x80 [12,2]`) and written back (`0x80 [12,1]`) on our hardware. It is not part of Sense
Calibrator: nothing in `js/` imports it, no page links to it, and it refuses to run anywhere but
`localhost`.

**Use a spare controller only.** The protocol, the safety rules and the go/no-go rules are in
[`docs/hw-probe-protocol.md`](../../docs/hw-probe-protocol.md). The R1-X steps for the BDM-040
left-X capture error are in [`docs/hw-probe-bdm040.md`](../../docs/hw-probe-bdm040.md); they start
only after R1 is GO on that controller.

```sh
python3 -m http.server 8741            # from the repo root
# open http://localhost:8741/ops/hw-probe/ in desktop Chrome or Edge
```

| File | Purpose |
|---|---|
| `index.html`, `probe.css` | The page (noindex, CSP with `connect-src 'none'`) |
| `probe.mjs` | DOM wiring. Checks the host before loading any HID code |
| `safety.mjs` | Host check, per-connection arming, write refusal, allowed write values (±512 units), and the separate X-fix rule (`checkFixWrite`) |
| `module-cal.mjs` | `[12,2]` read and `[12,1]` write, upstream validation |
| `protocol.mjs` | Steps H-a…H-f, A/B, restore, the R1-X steps, and `evaluate()` (go/no-go, plus `r1x`) |
| `smoke-headless.mjs` | Headless Chromium check against the fake firmware (needs a local Playwright) |

Tests: `test/hw-probe.test.js` (the probe against `ops/sim/fake-dualsense.mjs`, model-verified)
and `test/hw-probe-public-surface.test.js` (no `[12,1]` in `js/`, no link to the probe, noindex).

## R1-X steps (BDM-040)

Implemented and model-verified against the fake (`leftXCapture` in `MODULE_DEFAULTS`), not run on
hardware. Record schema `sense-hw-probe/2`.

| Step | Writes? | What it records |
|---|---|---|
| `X-idle` | no | 5 min hands off: per second, median and spread of each axis (LSB); drift per axis, last minute minus first minute |
| `X-release` | no | 8 directions × 3 flicks of the left stick, prompted on the page; each landing via `js/calib/landing.js`, median per direction, largest left-X difference between opposite directions. A flick that never lands is `null` after 10 s |
| `X-pass` | RAM | 5 passes as H-b, the baseline restored with `[12,1]` and read back after each; per pass the reference, every sample's window mean, `outBefore`/`outAfter`, Δ per center, ideal Δ and the capture error E (LSB). Stops at an output ≥15% (after the restore) or on an inexact restore |
| `X-fix` | RAM | Writes `LX + round(out.lx × u)` (and LY when \|out.ly\| ≥ 1 LSB and its fit qualifies) from a fresh read, under `checkFixWrite`; read-back, output at once, after 60 s, and the median of 8 landings |
| `X-replug` | no | On a new connection after an unplug without power-off (confirmed): `[12,2]` and the output against the last read of the previous connection, only with both serials known and equal (H11 for RAM) |

`u` is the H-e slope of **this** connection, as units per LSB of center shift (`−unitsPerLsb`):
X-pass and X-fix refuse without it, so run H-e again after the reconnect that starts R1-X.

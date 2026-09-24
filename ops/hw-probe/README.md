# ops/hw-probe: calibration read-back probe (research, localhost only)

A dev-only page for workstream R1. It checks whether the DualSense calibration in RAM can be read
(`0x80 [12,2]`) and written back (`0x80 [12,1]`) on our hardware. It is not part of Sense
Calibrator: nothing in `js/` imports it, no page links to it, and it refuses to run anywhere but
`localhost`.

**Use a spare controller only.** The protocol, the safety rules and the go/no-go rules are in
[`docs/hw-probe-protocol.md`](../../docs/hw-probe-protocol.md).

```sh
python3 -m http.server 8741            # from the repo root
# open http://localhost:8741/ops/hw-probe/ in desktop Chrome or Edge
```

| File | Purpose |
|---|---|
| `index.html`, `probe.css` | The page (noindex, CSP with `connect-src 'none'`) |
| `probe.mjs` | DOM wiring. Checks the host before loading any HID code |
| `safety.mjs` | Host check, per-connection arming, write refusal, allowed write values |
| `module-cal.mjs` | `[12,2]` read and `[12,1]` write, upstream validation |
| `protocol.mjs` | Steps H-a…H-f, A/B, restore, and `evaluate()` (go/no-go) |
| `smoke-headless.mjs` | Headless Chromium check against the fake firmware (needs a local Playwright) |

Tests: `test/hw-probe.test.js` (the probe against `ops/sim/fake-dualsense.mjs`, model-verified)
and `test/hw-probe-public-surface.test.js` (no `[12,1]` in `js/`, no link to the probe, noindex).

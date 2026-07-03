# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sense Calibrator: a browser tool that diagnoses and hardware-recalibrates drifting PS5 DualSense analog sticks over WebHID. Pure static site — vanilla ES modules, no build step, no dependencies, no package.json, no tests or linter.

## Running

WebHID requires a secure context (`file://` does not work) and only works in Chrome/Edge. Serve the folder over HTTP:

```sh
python3 -m http.server 8000
```

A preview server is configured in `.claude/launch.json` (name `sense-calibrator`, port 8741). Note: actual controller interaction cannot be tested headlessly — it needs a physical DualSense connected over **USB** (Bluetooth is detected and rejected for calibration).

## Architecture

Three ES modules under `js/`, loaded from `index.html`:

- **`js/ds5.js`** — DualSense HID protocol layer, no DOM. The `DS5` class wraps a WebHID device: calibration commands (feature reports `0x82` send / `0x83` response, checked against expected status words), NVS lock/unlock/status (`0x80`/`0x81`), device info, battery parsing. Protocol sequences derive from the dualshock-tools project. Key invariant: feature report buffers must be padded to the size declared by the HID descriptor (`allocReq`) or the firmware silently discards the command.
- **`js/app.js`** — all UI and calibration logic: connection/reconnect, input report parsing, automatic drift test, quick calibration (stability-gated sampling with adaptive gate + convergence passes), 4-corner guided wizard, range calibration with coverage bins, NVS write flow, telemetry. Tuning constants (drift thresholds, stability windows, gate spreads) live at the top of the file and of each section.
- **`js/game.js`** — self-contained stick-precision minigame (steadiness / targets / Lissajous tracking). Talks to app.js only through injected deps (`getSticks`, `isAvailable`); never touches HID.

Comments in the JS are in Italian; UI strings are English.

## Domain constraints worth knowing

- Applied calibration lives in controller RAM until explicitly written to NVS (unlock → lock cycle via `flash()`); power-off reverts it. The UI tracks this as the `unsaved` state — don't break that safety net.
- Only the standard DualSense (`054C:0CE6`) is supported; DualSense Edge and DualShock 4 are not.
- Drift is distinguished from user touch by signal *spread* within a short window, never by absolute stick value — a large-but-stable offset is drift, excursion is movement.
- One calibration at a time: app.js guards with the module-level `busy` flag.

## Telemetry

Every significant action emits a typed event via `recordEvent(kind, data)` in app.js — kinds: `connect`, `drift`, `quick`, `wizard`, `range`, `flash`, `game`. Events always go to `localStorage` (`sense-calib-sessions`, capped at 200). Network upload to `https://subralabs.com/api/calib/v1/sessions` is **on by default (opt-out)**: `telemetryEnabled()` is true unless `sense-telemetry-consent` is explicitly `'0'`; a one-time first-launch toast discloses it (`sense-telemetry-notice`), and two synced checkboxes (footer + quick-calibration dialog) control the opt-out. Payload is anonymous — see README table; never add device identifiers to it. The data feeds ML-driven tuning of the calibration algorithm, so keep events rich but always identifier-free. `scripts/pull-telemetry.sh` rsyncs collected sessions from the VPS into `data/telemetry/` (gitignored).

## Dev hooks

Exposed on `window` for console debugging:

- `window.__senseGameOpen()` — open the minigame bypassing the connection gate.
- `window.__senseCalibSessions()` — dump locally stored calibration sessions.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Sense Calibrator: a browser tool that diagnoses and hardware-recalibrates drifting PS5 DualSense analog sticks over WebHID. Pure static site — vanilla ES modules, no build step, no runtime dependencies, no linter. `package.json` exists only to run the tests (`npm test` = `node --test`); dev-only tooling lives under `ops/` and `test/` and is never loaded by the page.

## Running

WebHID requires a secure context (`file://` does not work) and only works in Chrome/Edge. Serve the folder over HTTP:

```sh
python3 -m http.server 8000
```

A preview server is configured in `.claude/launch.json` (name `sense-calibrator`, port 8741). Note: actual controller interaction cannot be tested headlessly — it needs a physical DualSense connected over **USB** (Bluetooth is detected and rejected for calibration).

## Architecture

ES modules under `js/`, loaded from `index.html`:

- **`js/ds5.js`** — DualSense HID protocol layer, no DOM. The `DS5` class wraps a WebHID device: calibration commands (feature reports `0x82` send / `0x83` response, checked against expected status words), NVS lock/unlock/status (`0x80`/`0x81`), device info, battery parsing. Protocol sequences derive from the dualshock-tools project. Key invariant: feature report buffers must be padded to the size declared by the HID descriptor (`allocReq`) or the firmware silently discards the command.
- **`js/calib/`** — the calibration algorithm, with no DOM and no direct timers or HID access. The page and the simulator run the same code.
  - `measure.js`: pure measurement — `parseSticks` (report `0x01` bytes → sticks), `median`, `extractStableSamples`, `analyzeDrift`, `summarizeResult`, `verdictFor`, and the `DRIFT_*` thresholds.
  - `sampling.js`: `waitForStable` and `measureOffset`, driven by a stick `source = { subscribe(fn) → unsubscribe, sticks, now() }` and a `clock = { sleep, setTimeout, clearTimeout }`. In the page the source is fed by HID input reports; in the simulator by a virtual DualSense.
  - `quick.js`: `runQuick({ controller, source, clock, isCurrent, onProgress, log, params, meta }) → { session, outcome, committed, … }`. Never throws: an HID error becomes `outcome: 'error'` with `committed` (true once any `calibEnd` succeeded, or a `calibBegin` repair committed). `QUICK_DEFAULTS` holds today's constants; a variant is a `params` override.
  - `quick-policy.js`: pure rules — `decideAfterPass` (stop rule) and `classifyOutcome` (which result the user is told).
  - `lattice.js`: the 8-bit lattice (1 LSB = 0.784%, floor 0.555%, one step 1.240%) and **`GRID_TABLE`, the single source of truth** for offset tiers, labels, outcome classes, the precision-test Center score and recommendation keys, plus the Pinned/Moving overrides. `formatOffset` is the only offset formatter (`0.6% · at floor`, `1.2% · 1 step`); `decodeOff` splits an offset into per-axis steps. It imports nothing: `measure.js` takes `DRIFT_OK_MAX`/`DRIFT_MILD_MAX` from it and `verdictFor` goes through the table. `ops/calib-telemetry/quality-report.mjs` loads it too. `DRIFT_OK_MAX` (<1.2, the v1 KPI and stop target) is not raised; "within 1 step" (≤1.25) is a label and a second metric only.
  - `ops.js`: `createOpGate()` — the single-operation `busy` flag with an epoch token (`beginOp`/`endOp`/`reset`). `endOp` still clears the flag for a stale token (today's semantics; it only reports it).
- **`js/app.js`** — UI wiring only for calibration: connection/reconnect, input report routing (`stickSource`, `pageClock`), drift test, the Quick modal around `runQuick` (busy, messages, toasts, telemetry, unsaved), 4-corner guided wizard, range calibration with coverage bins, NVS write flow, telemetry. The Quick loop deliberately calls the *global* `ds5` through `liveController` (known defect: a replug mid-pass drives the new controller); binding to the captured controller is a separate, tested change.
- **`js/quick-center-guard.js`** — the conservative Quick startup radius/hold policy (see below).
- **`js/game.js`** — self-contained precision test with three calibration-diagnostic checks (center hold / edge reach / snap-back), each measuring a calibration property rather than user skill. Talks to app.js only through injected deps (`getSticks`, `isAvailable`, optional `onReport`); never touches HID.
- **`js/sensitivity.js`** — experimental local sensitivity finder. Compares right-stick tracking across three virtual control speeds, creates a universal FPS aim profile, then optionally maps it to game-specific starting settings. It receives stick state through injected deps, never touches HID, and keeps results in localStorage.
- **`js/playtest.js`** — experimental fixed-timestep FPS-style controller lab. Separates browser frame pacing from raw HID report timing and scores tracking, movement coverage and simultaneous two-stick use. It receives live stick state and HID sample notifications through injected deps.

Sensitivity Finder and Gameplay Lab are excluded from the public product and search metadata. They are available only on localhost with `?preview=1` while they are developed and tested. Do not promote or expose them in the hosted page without an explicit release decision.

Comments in the JS are in Italian; UI strings are English.

## Domain constraints worth knowing

- Applied calibration lives in controller RAM until explicitly written to NVS (unlock → lock cycle via `flash()`); power-off reverts it. The UI tracks this as the `unsaved` state — don't break that safety net.
- Only the standard DualSense (`054C:0CE6`) is supported; DualSense Edge and DualShock 4 are not.
- Drift measurement classifies stability by signal *spread* within a short window, not absolute stick value. Stability alone cannot prove that the user released the stick. Quick calibration has a separate conservative startup policy in `js/quick-center-guard.js`: both sticks must stay within 15% radial offset for 300 ms, with at least 10 fresh HID reports and no gap over 100 ms. The baseline must also stay within this radius, and a second centered stability hold is required before any calibration command. This is an initial safety policy, not a hardware diagnosis or a threshold validated from production data; a genuine resting offset outside it requires guided calibration. Failed preflight leaves controller RAM/NVS untouched and restores retry/cancel. Cancelling a blocked attempt resumes the drift test.
- One calibration at a time: app.js guards with the op gate (`ops.busy`, `js/calib/ops.js`), the former `busy` flag. Alzalo *prima* di qualunque `await` lungo (es. la misura iniziale del wizard), non dopo: la finestra tra il click e l'alzata è sufficiente ad avviare una seconda calibrazione.
- Ogni `calibEnd()` è applicato subito dal firmware e sovrascrive il precedente; il codice non rilegge mai la calibrazione dal controller, quindi **una passata peggiorativa è irreversibile**. Per questo `quickCalibrate` non si ferma su una regressione (userebbe il budget residuo per recuperare), tiene `bestWorst`, e avvisa se il risultato finale è peggiore della migliore passata o del punto di partenza. Non reintrodurre un `break` sul semplice "non è migliorato".
- Il gate di stabilità non deve mai superare `DRIFT_MOVE_SPREAD`: sarebbe più permissivo della soglia con cui l'app stessa dichiara "questa è una mano sullo stick". Decade verso `baseGate` a ogni passata; `gateOff` invece resta sticky, perché riaprirlo costa 5 s di timeout per campione. `Escape` dismisses only the modals in `ESC_DISMISS` and never while `busy` — the range modal is deliberately excluded, since an open range session must be closed with `rangeEnd()` rather than abandoned.
- Stick sampling is always driven by HID input reports (`stickListeners`), never by `setInterval`/`setTimeout`: page timers are throttled in background tabs, and a fixed interval both under-samples the ~250 Hz report rate and duplicates identical samples, which corrupts the stability fraction and the effective duration of `DRIFT_WINDOW`.

## Tests and simulator

`npm test` runs everything under `test/` (and `ops/calib-telemetry/test/`) with `node --test`, no browser, no controller:

- unit tests for `js/calib/*` (`measure`, `quick-policy`, `quick-preflight`, `quick-center-guard`) and the telemetry v1 contract;
- `test/lifecycle.test.js` and `test/hotfix-production-defects.test.js` run the **real** `js/app.js` in a `vm` context through `test/helpers/app-harness.mjs`: a DOM stub built from the ids in `index.html`, fake WebHID backed by the simulator's virtual DualSense, and a virtual clock for `setTimeout`, `performance.now` and `requestAnimationFrame`. Known defects are written as `{ todo }` tests that describe the desired behaviour; whoever fixes one removes `todo`;
- `test/sim-equivalence.test.js` compares `runQuick` session by session with golden output produced by the pre-refactor harness on a synthetic population.

`ops/sim/` is the headless simulator (see its README): `run.mjs` runs the real `runQuick` against a fitted virtual DualSense, `score.mjs` compares with the real cohort using a cluster bootstrap by template, `replay-sequences.mjs` and `replay-telemetry.mjs` replay the real pass sequences and outcomes through `quick-policy.js`. Label every simulator result **model-verified**: it is never hardware verification. The real telemetry is gitignored and must never be committed, not even in derived form; tests use only the synthetic population.

## Telemetry

Every significant action emits a typed local event via `recordEvent(kind, data)` in app.js. Ogni evento porta `sid`, un valore casuale per caricamento di pagina mai persistito: collega gli eventi di una singola visita, non due visite tra loro. `summarizeResult` include `xy` (componenti per asse): `off` è la loro ipotenusa, quindi senza `xy` la direzione del drift è perduta. Events always go to `localStorage` (`sense-calib-sessions`, capped at 200).

The network contract is deliberately narrower. `js/telemetry.js` maps only complete `quick` sessions to the strict nine-field v1 API schema and strips `kind`, `sid`, `xy` and every unsupported field. All other events stay local. Do not widen the v1 payload or allow unknown properties. Richer network events require a versioned endpoint, matching OpenAPI and privacy documentation, and contract tests. The first-launch banner still holds events until the person chooses **Keep sharing**; choosing **Don't share** discards the queue. `scripts/pull-telemetry.sh` rsyncs collected sessions from the VPS into `data/telemetry/` (gitignored).

## Dev hooks

Exposed on `window` for console debugging:

- `window.__senseGameOpen()` — open the minigame bypassing the connection gate.
- With `?preview=1`, `window.__senseSensitivityOpen()` and `#sensitivity-demo` open the sensitivity finder without HID.
- With `?preview=1`, `window.__sensePlaytestOpen()` and `#playtest-demo` open the gameplay lab without HID.
- `window.__senseCalibSessions()` — dump locally stored calibration sessions.

# Sense Calibrator

A browser tool that tests and recalibrates analog-stick drift on a standard PS5 DualSense controller.

It is for players who want to measure a resting stick, try calibration and compare the result before saving it. Use a desktop computer, Chrome or Edge, and a USB data cable. DualSense Edge and DualShock 4 are not supported.

**[Open the tool](https://martino-vigiani.github.io/sense-calibrator/)**

This is an unofficial tool. Calibration can correct stored center or range values; it cannot repair a worn, dirty or damaged stick. Some controller and recovery behavior still needs [hardware checks](docs/hardware-checks.md).

## Use it

1. Connect the DualSense by USB and open the tool in Chrome or Edge.
2. Select **Connect DualSense** and approve the browser request.
3. Put the controller on a stable surface and leave both sticks untouched for the drift test.
4. Follow the result's recommendation. Use calibration only when there is an offset to correct.
5. Compare the before and after readings, then repeat the drift or precision test.
6. Select **Write to memory** only if you want to keep the result.

Keep the controller connected while calibration is running. A completed pass changes the controller's working calibration immediately; the tool cannot restore an earlier pass.

Calibration is applied to temporary memory first. If the tool reports that saved memory is locked, turning the controller off before **Write to memory** should discard the temporary calibration and return to the saved one. That behavior has not been confirmed on hardware yet (H10). Unplugging the cable alone has also not been verified (H11).

The result stays on screen. The tool disables saving for results such as a severe offset, an incomplete range or a controller that stopped responding. A result worse than the starting measurement needs another confirmation before saving.

## Available tools

| Tool | Purpose | Changes the controller? |
| --- | --- | --- |
| Drift test | Measure resting offset and signal noise | No |
| Quick calibration | Attempt to correct a stable center offset automatically | Yes; temporary until saved |
| Guided calibration | Recalibrate the center with a four-corner procedure | Yes; temporary until saved |
| Range calibration | Recalibrate the full travel of both sticks | Yes; temporary until saved |
| Precision test | Compare resting position, stability, return and range with the controller's previous result | No |

Quick calibration checks that both sticks are stable and within 15% of center before sending commands. A failed initial check leaves the calibration unchanged. Large resting offsets may need Guided calibration.

A centered DualSense can read about **0.6%** rather than zero because each axis reports whole-byte steps. The label **Within 1 step** means the resting position is close to that measurement floor.

## Run locally

Download or clone this repository, open a terminal in its folder and run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [http://localhost:8000](http://localhost:8000) in Chrome or Edge. Opening `index.html` directly does not work: WebHID needs a secure context, and localhost qualifies.

The page has no build step or runtime dependencies. A physical standard DualSense (`054C:0CE6`) connected over USB is needed for controller use. Bluetooth is rejected for calibration; Safari and Firefox do not provide the required WebHID support.

For automated checks, install Node.js and npm, then run:

```sh
npm test
```

The checks use synthetic controllers and recorded fixtures. Simulator results are **model-verified** and do not establish behavior on a physical controller. See [CONTRIBUTING.md](CONTRIBUTING.md) and [the simulator notes](ops/sim/README.md) for development.

Sensitivity Finder and Gameplay Lab are unfinished local experiments. They are available on localhost with `?preview=1` and are not part of the public tool.

## Guides and project notes

- [Stick drift test guide](guides/ps5-controller-stick-drift-test/index.html)
- [DualSense calibration guide](guides/calibrate-dualsense-controller/index.html)
- [Changes](CHANGELOG.md) and [open hardware checks](docs/hardware-checks.md)
- [Telemetry tools](ops/calib-telemetry/README.md)

[ARTICLE.md](ARTICLE.md) is the original launch write-up and describes an earlier version.

## Telemetry & privacy

The tool has no account, ads or third-party analytics.

Calibration events are kept in your browser under `sense-calib-sessions`, with a limit of 200 entries. This local history is stored whether network sharing is enabled or not.

Nothing is uploaded until you choose **Keep sharing** in the notice. Sharing is on by default: the notice holds everything until you answer, and **Don't share** discards what was waiting and turns sharing off. You can change it later with the checkbox in the footer or in the Quick calibration dialog.

What is sent, if you share:

- **Complete Quick calibration** (endpoint v1, unchanged): timestamp, board revision, firmware version, before and after offset and noise, pass measurements and stability settings.
- **Typed events** (endpoint v2, `https://subralabs.com/api/calib/v2/events`), one small JSON object each:
  - `quick`, `guided`, `range`: one per calibration that ran (a Guided start that sent nothing is not one): its outcome class (for Quick: centered, within one step, worse than start, 15% or more, already centered, stopped because a stick moved or stalled, disconnected…), whether the controller's calibration may have changed, the per-stick before and after offset rounded to 0.01%, the result of each pass, the corner step reached or the range coverage, and the duration in whole seconds. Quick and Guided also send the signed left/right and up/down resting offset before and after; Quick sends it after each pass. These are per-axis medians, rounded to half an 8-bit stick step (1 step = 0.784% per axis), capped at ±64 steps; an unavailable measurement is `null`. Quick also includes up to two existing verification attempts per pass: offset, noise, stable fraction, the stability rule that passed, whether the retry hold passed, and whether the reading was accepted. Range includes each stick's reverse-turn progress and a fixed list of missing completion checks. Missing diagnostics from older pages remain unknown. No extra readings are taken for telemetry;
  - `flash`: each Write to memory attempt, its result class (ok, not confirmed, memory state unknown, unlock or lock failed, other error) and the memory status read back;
  - `save`: how each calibration that was not yet saved ended (saved, controller disconnected, page closed), whether Write was locked and why (a fixed list of reasons, such as "15% or more" or "range incomplete"), how many times the Write dialog was opened (from the save block or from the reminder bar) or cancelled, whether the save block was ever on screen, and how long it took in whole seconds;
  - `rest`: a summary of 30 seconds of stick readings taken while the page is visible, no calibration or dialog is open and nobody moves the sticks, at most 8 per visit: report count and intervals, and per stick the distance from its resting point (median, 95th percentile, maximum), the spread per axis, how often it jumps 1, 2 or 4 steps, and the resting offset. The readings themselves never leave the browser.
  - Every event also carries the board revision (and firmware, except `save` and `rest`), the release date of the page, its order in the visit and a random code created when the page loads. The code links the events of one visit, is never stored, and a reload creates a new one.

The v2 events never contain the serial number, a device identifier (the controller key used for local locks is salted and stays in the page), anything you type, error messages or a client timestamp; the server adds only the day it received the event. Every field is a number, a yes/no or a value from a fixed list, and the page and the server both reject anything else. The exact contract is `ops/calib-telemetry/contract/events-v2.schema.json`, also published in the [OpenAPI document](https://subralabs.com/openapi.json).

Like any web request, the upload reaches the server with network metadata such as your IP address. The telemetry service keeps it in memory only for its per-minute rate limit and never writes it to the telemetry records.

The web server in front of the service (nginx on subralabs.com, behind Cloudflare) does keep an access log, as it does for every page of the site, telemetry requests included. For each request it records the IP address, the exact time, the requested path and the browser's user agent. These logs are kept to debug the server and protect it from abuse, never to analyse the telemetry. They are deleted after 14 days (the logs rotate daily and the last 14 are kept). Cloudflare, which proxies the site, processes the same request data under its own policy.

If you accepted an earlier description, the notice appears again when the shared fields change. The updated events are only sent after you choose **Keep sharing** again. Until then nothing from the visit is sent, including the Quick result you had already agreed to.


## Contributions and license

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports, before/after measurements and focused fixes are useful. Remove serial numbers and other device identifiers from reports, screenshots and fixtures.

The project uses the [MIT License](LICENSE). Its calibration protocol comes from [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) by the_al; the original license is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

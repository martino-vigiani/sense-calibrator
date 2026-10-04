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

The checks use synthetic controllers and test fixtures. Simulator results are **model-verified** and do not establish behavior on a physical controller. See [CONTRIBUTING.md](CONTRIBUTING.md) and [the simulator notes](ops/sim/README.md) for development.

Sensitivity Finder and Gameplay Lab are unfinished local experiments. They are available on localhost with `?preview=1` and are not part of the public tool.

## Guides and project notes

- [Stick drift test guide](guides/ps5-controller-stick-drift-test/index.html)
- [DualSense calibration guide](guides/calibrate-dualsense-controller/index.html)
- [Changes](CHANGELOG.md) and [open hardware checks](docs/hardware-checks.md)
- [Telemetry tools](ops/calib-telemetry/README.md)

[ARTICLE.md](ARTICLE.md) is the original launch write-up and describes an earlier version.

## Telemetry & privacy

The tool keeps up to **200 calibration events** in your browser, even when sharing is off. Sharing is selected by default, but nothing is uploaded until you choose **Keep sharing**. **Don't share** discards queued data and turns uploads off. You can change this later with the sharing checkboxes.

Shared data covers calibration results and signed stick positions, Quick verification stability, missing Range checks, memory-write attempts, saving outcomes and short resting-noise summaries. It includes hardware and firmware information; complete Quick uploads include a timestamp. A random code links events within one visit. Controller serial numbers, device identifiers, typed text and error messages are excluded.

Uploads also carry network details. The telemetry service does not store your IP address in its records, but website access logs include IP addresses, request times, paths and browser information. Those logs are kept for **14 days**. Cloudflare also processes request data under its own policy.

[Read the full privacy details](docs/PRIVACY.md) for every shared field, the data contracts, storage and consent.

## Contributions and license

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports, before/after measurements and focused fixes are useful. Remove serial numbers and other device identifiers from reports, screenshots and fixtures.

The project uses the [MIT License](LICENSE). Its calibration protocol comes from [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) by the_al; the original license is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

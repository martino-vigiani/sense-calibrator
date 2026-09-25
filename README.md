# Sense Calibrator

Test and recalibrate stick drift on a standard PS5 DualSense, directly from desktop Chrome or Edge.

**[Open Sense Calibrator](https://martino-vigiani.github.io/sense-calibrator/)**

You need a desktop computer, a USB data cable and a standard DualSense (`054C:0CE6`). DualSense Edge and DualShock 4 are not supported.

[![GitHub stars](https://img.shields.io/github/stars/martino-vigiani/sense-calibrator?style=flat&label=stars)](https://github.com/martino-vigiani/sense-calibrator/stargazers) ![browser](https://img.shields.io/badge/browser-Chrome%20%7C%20Edge-black) ![license](https://img.shields.io/badge/license-MIT-black)

![Sense Calibrator interface](paper/assets/social-card-v2.png)

> Calibration can correct a stored center or range offset. It cannot repair a worn, dirty or damaged stick module.

## Use it

1. Connect the controller to your computer with a USB data cable.
2. Open the [hosted tool](https://martino-vigiani.github.io/sense-calibrator/) in Chrome or Edge.
3. Select **Connect DualSense** and approve the browser request.
4. Put the controller on a stable surface and leave both sticks untouched while the drift test runs.
5. Calibrate only if the result shows a correctable offset.
6. Run the drift and precision tests again to compare the result.
7. Select **Write to memory** only when you want to keep the calibration.

Calibration is applied to controller RAM first. If you turn the controller off (hold PS for 10 s) before **Write to memory**, the temporary calibration should be discarded and the controller should go back to the calibration saved in its memory; that has not been confirmed on hardware yet (check H10). What unplugging the cable alone does has not been verified yet, so the tool never tells you to rely on it.

After every calibration a result panel stays on screen with the before and after reading of each stick. **Write to memory** is switched off when a result must not be saved (15% or more off-center, a stick stuck at the edge, an incomplete range, a controller that stopped responding), and a result that is worse than where you started needs a second confirmation. If the controller doesn't appear in the browser prompt, the page lists what to check: a data cable, a standard DualSense, another port, apps that hold the controller, and Linux permissions.

Before Quick calibration sends any command, both sticks must stay within 15% of center through two short checks and the baseline measurement. If that safety check fails, nothing is written; release the sticks and retry, or use Guided calibration for a severe resting offset.

## What it does

| Tool | What it tells you | Changes the controller? |
|---|---|---|
| **Drift test** | Resting offset and signal noise for each stick | No |
| **Quick calibration** | Automatically corrects a stable center offset | Temporary until saved |
| **Guided calibration** | Recalibrates the center with a four-corner procedure | Temporary until saved |
| **Range calibration** | Recalibrates the full travel of both sticks | Temporary until saved |
| **Precision test** | About 15 seconds: a calibration score (where each stick rests) and a hardware score (how steady it is), plus return and range for information, compared with the same controller's previous result | No |

The public tool stays focused on testing and calibration. Sensitivity Finder and Gameplay Lab are experimental and remain hidden behind the local preview mode while they are developed and tested.

## Guides

- [PS5 controller stick drift test](https://martino-vigiani.github.io/sense-calibrator/guides/ps5-controller-stick-drift-test/): how the automatic test measures a resting DualSense, and how to read a stable offset versus a noisy signal.
- [How to calibrate a DualSense controller](https://martino-vigiani.github.io/sense-calibrator/guides/calibrate-dualsense-controller/): when calibration can help, Quick versus Guided calibration, and how to keep a calibration saved.

## Why calibration can help

A DualSense stores calibration values that describe where each stick rests and how far it can travel. Those values can become inaccurate even when the stick module still produces a stable signal.

Sense Calibrator measures the untouched sticks first. A stable offset can often be corrected by writing a new center or range calibration. A noisy or unstable signal usually points to dirt, wear or mechanical damage, which software cannot repair.

The app applies calibration temporarily, runs the same measurements again and lets you decide whether to save it. For how this release behaves, read the [CHANGELOG](CHANGELOG.md) and the open [hardware checks](docs/hardware-checks.md). [ARTICLE.md](ARTICLE.md) is the original launch write-up and describes an earlier version of the tool; the [SubraLabs technical write-up](https://subralabs.com/lab/sense-calibrator.html) covers the protocol.

## Reading the numbers

The DualSense reports each stick axis as a whole byte, so every offset sits on a fixed grid. One step is 0.78% per axis. The center falls between two bytes, so a perfectly centered stick reads **0.6%**, not 0%: that is the measurement limit. A stick with one axis a single step off reads **1.2%** and is shown as "Within 1 step", which is fine to save. Results are labelled with the step count, for example `0.6% · at floor` or `1.2% · 1 step`.

## Limits and safety

- Only the standard DualSense with USB product ID `054C:0CE6` is supported.
- Calibration works only over USB. Bluetooth is rejected for calibration.
- Chrome and Edge are supported because they provide WebHID. Safari and Firefox do not.
- Calibration can correct stored center and range values. It cannot repair physical wear.
- This is an unofficial tool and is not affiliated with Sony.

Do not disconnect the controller during calibration. Review the before and after result before writing anything to controller memory.

## Telemetry & privacy

The tool has no account, ads or third-party analytics.

Calibration events are kept in your browser under `sense-calib-sessions`, with a limit of 200 entries. This local history is stored whether network sharing is enabled or not.

Nothing is uploaded until you choose **Keep sharing** in the first-launch notice. The current server contract accepts only a complete Quick calibration: timestamp, board revision, firmware version, before and after offset and noise, pass measurements, and stability settings. Other events stay in the browser.

The upload excludes the controller serial number, device identifiers and the local session ID. Like any web request, the server can receive network metadata such as an IP address for routing and rate limiting, but it is not stored in the telemetry record. Select **Don't share** to discard queued uploads and save that preference.

## Run it locally

Clone or download the repository, then start a local server:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000` in Chrome or Edge. Opening `index.html` through `file://` does not work because WebHID requires a secure context.

There is no build step and there are no runtime dependencies. Run the automated checks with:

```sh
npm test
```

The automated suite checks the telemetry contract, keeps experimental tools out of the public search surface, and runs the calibration code and the page lifecycle against a simulated controller (`ops/sim/`). A simulated controller is a model, not proof of controller behavior: calibration changes still require a real DualSense connected over USB.

For local work on the experimental tools, add `?preview=1` to the URL.

## Contribute

Useful contributions include:

- controller results with measurements before and after calibration;
- reproducible bug reports;
- tests for WebHID and calibration failure paths;
- accessibility, documentation and browser compatibility fixes.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). Never include a controller serial number or another device identifier in an issue, screenshot or test fixture.

## License and credits

Sense Calibrator is available under the [MIT License](LICENSE).

The calibration protocol derives from the MIT licensed [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) project by the_al. Its original license is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

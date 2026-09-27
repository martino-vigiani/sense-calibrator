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

Nothing is uploaded until you choose **Keep sharing** in the notice. Sharing is on by default: the notice holds everything until you answer, and **Don't share** discards what was waiting and turns sharing off. You can change it later with the checkbox in the footer or in the Quick calibration dialog.

What is sent, if you share:

- **Complete Quick calibration** (endpoint v1, unchanged): timestamp, board revision, firmware version, before and after offset and noise, pass measurements and stability settings.
- **Typed events** (endpoint v2, `https://subralabs.com/api/calib/v2/events`), one small JSON object each:
  - `quick`, `guided`, `range`: one per calibration that ran (a Guided start that sent nothing is not one): its outcome class (for Quick: centered, within one step, worse than start, 15% or more, already centered, stopped because a stick moved or stalled, disconnected…), whether the controller's calibration may have changed, the per-stick before and after offset rounded to 0.01%, the result of each pass, the corner step reached or the range coverage, and the duration in whole seconds. Quick and Guided also send the signed left/right and up/down resting offset before and after; Quick sends it after each pass. These are per-axis medians, rounded to half an 8-bit stick step (1 step = 0.784% per axis), capped at ±64 steps; an unavailable measurement is `null`. No extra readings are taken for telemetry;
  - `flash`: each Write to memory attempt, its result class (ok, not confirmed, memory state unknown, unlock or lock failed, other error) and the memory status read back;
  - `save`: how each calibration that was not yet saved ended (saved, controller disconnected, page closed), whether Write was locked and why (a fixed list of reasons, such as "15% or more" or "range incomplete"), how many times the Write dialog was opened (from the save block or from the reminder bar) or cancelled, whether the save block was ever on screen, and how long it took in whole seconds;
  - `rest`: a summary of 30 seconds of stick readings taken while the page is visible, no calibration or dialog is open and nobody moves the sticks, at most 8 per visit: report count and intervals, and per stick the distance from its resting point (median, 95th percentile, maximum), the spread per axis, how often it jumps 1, 2 or 4 steps, and the resting offset. The readings themselves never leave the browser.
  - Every event also carries the board revision (and firmware, except `save` and `rest`), the release date of the page, its order in the visit and a random code created when the page loads. The code links the events of one visit, is never stored, and a reload creates a new one.

The v2 events never contain the serial number, a device identifier (the controller key used for local locks is salted and stays in the page), anything you type, error messages or a client timestamp; the server adds only the day it received the event. Every field is a number, a yes/no or a value from a fixed list, and the page and the server both reject anything else. The exact contract is `ops/calib-telemetry/contract/events-v2.schema.json`, also published in the [OpenAPI document](https://subralabs.com/openapi.json).

Like any web request, the upload reaches the server with network metadata such as your IP address. The telemetry service keeps it in memory only for its per-minute rate limit and never writes it to the telemetry records.

The web server in front of the service (nginx on subralabs.com, behind Cloudflare) does keep an access log, as it does for every page of the site, telemetry requests included. For each request it records the IP address, the exact time, the requested path and the browser's user agent. We keep these logs to debug the server and to protect it from abuse, never to analyse the telemetry, and they are deleted after [RETENTION TO CONFIRM BEFORE RELEASE: the nginx log rotation on the VPS]. Cloudflare, which proxies the site, processes the same request data under its own policy.

If you accepted an earlier description, the notice appears again when the shared fields change. The updated events are only sent after you choose **Keep sharing** again. Until then nothing from the visit is sent, including the Quick result you had already agreed to.

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

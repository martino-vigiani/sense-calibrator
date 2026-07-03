# Sense Calibrator

Diagnose and hardware-recalibrate the analog sticks of a drifting **PS5 DualSense**, straight from the browser over WebHID. No installation, no drivers.

![browser](https://img.shields.io/badge/browser-Chrome%20%7C%20Edge-black) ![controller](https://img.shields.io/badge/controller-DualSense-black) ![license](https://img.shields.io/badge/license-MIT-black)

> 📖 **The story behind this tool:** how I fixed my controller's stick drift by building this with Anthropic's Fable 5 model, instead of buying a new one — [**read ARTICLE.md**](ARTICLE.md).

## What it does

- **Automatic drift test** on connect: measures the sticks' resting offset and classifies the drift (centered / mild / marked), with signal-noise detection for a worn potentiometer.
- **Quick calibration**: re-centers the sticks automatically, without touching the controller. Every firmware sample is gated on signal stability (a touch or vibration never contaminates the average), the gate adapts to the controller's own noise so a jittery worn stick still calibrates, and passes repeat until the residual offset converges to the noise floor. The final verdict distinguishes a fixable offset from worn hardware.
- **Guided calibration**: a four-corner procedure (push the sticks into each corner) for more stubborn drift.
- **Range calibration**: recalibrates the full stick travel by rotating the sticks, with a real-time coverage indicator.
- **Permanent write**: calibration is temporary (lost when the controller powers off) until you explicitly write it to the controller's NVS memory. Once written it applies everywhere: PS5, PC, Mac.
- Live stick visualization, HID command log, automatic reconnect.

## How to use it

1. Start a local server in the project folder (WebHID requires a secure context, `file://` does not work):

   ```sh
   python3 -m http.server 8000
   ```

2. Open `http://localhost:8000` in **Chrome** or **Edge** (Safari and Firefox do not support WebHID).
3. Connect the DualSense over a **USB cable** (Bluetooth is not supported for calibration).
4. Click **Connect controller**; the drift test runs on its own.
5. Calibrate if needed. When you are satisfied, click **Write to memory** to make the fix permanent.

## Technical notes

- The calibration protocol (feature reports `0x82`/`0x83`, NVS management via `0x80`/`0x81`) is derived from [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) (MIT, © the_al), the reference open-source tool for calibrating Sony controllers.
- Applied calibration stays in RAM until it is written to NVS (an unlock → lock cycle): powering the controller off before writing reverts everything. That is the safety net of the flow.
- Standard DualSense only (`054C:0CE6`). DualSense Edge and DualShock 4 are not supported.

## Telemetry & privacy

Sense Calibrator can optionally upload anonymous calibration data to a self-hosted endpoint to help improve the algorithm over time. This is **opt-in and off by default**.

**What is sent** (when you enable it):

| Field | Description |
|---|---|
| `t` | ISO 8601 timestamp of the session |
| `board` | Controller board model (e.g. `BDM-030`) |
| `fw` | Firmware version integer |
| `before` | Stick offsets and noise before calibration |
| `passes` | Residual offset after each calibration pass |
| `after` | Stick offsets and noise after calibration |
| `unstableEvents` | Number of times the stability gate widened or was bypassed |
| `gate` | Final stability-gate spread value used |
| `gateOff` | Whether gating was disabled entirely |

**What is never collected:** serial number, any device identifier, IP address (not stored server-side), browser fingerprint, or any personal information.

**Where it goes:** a self-hosted server at `subralabs.com`. No third-party analytics services are used.

**Local copy:** calibration sessions are always stored in `localStorage` under the key `sense-calib-sessions`, regardless of whether upload consent is given.

To enable, check **"Share anonymous calibration data to improve the algorithm"** in the quick-calibration dialog. The preference persists in `localStorage` and can be changed at any time.

## Disclaimer

Unofficial tool, not affiliated with Sony. The NVS write uses widely tested reverse-engineered commands, but you use it at your own risk.

## License

[MIT](LICENSE). The calibration protocol derives from the MIT-licensed [dualshock-tools](https://github.com/dualshock-tools/dualshock-tools.github.io) project by the_al; its copyright notice is preserved in [`LICENSE`](LICENSE).

# Privacy details

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
  - `rest`: a summary of 30 seconds of stick readings taken while the page is visible, no calibration or dialog is open and nobody moves the sticks, at most 8 per visit: report count and intervals, and per stick the distance from its resting point (median, 95th percentile, maximum), the spread per axis, how often it jumps 1, 2 or 4 steps, and the resting offset. Since 13 October 2026 it also says how long ago the last Quick or Guided calibration of the visit was (rounded to 10 seconds, at most one hour, `null` if there was none), which kinds of operation came after it (Range, Write, reconnecting the controller, a restart or confirmed power-off; each kind once, in order) and how many times a stick was let go since. The readings themselves never leave the browser.
  - `landing`: where each stick stopped after you pushed it at least 25% and let go, since the last calibration of the visit (or since the page opened, if there was none): per stick the number of releases, the median stopping point and how much the stopping points vary, and the last 20 stopping points, each as a signed left/right and up/down position rounded to half a step with its time since the calibration rounded to 10 seconds. At most two per visit: after 20 releases following a calibration, and when you leave the page. It only counts releases while no calibration or Write is running, never during Guided or Range. The individual readings never leave the browser.
  - Every event also carries the board revision (and firmware, except `save` and `rest`), the release date of the page, its order in the visit and a random code created when the page loads. The code links the events of one visit, is never stored, and a reload creates a new one.

The v2 events never contain the serial number, a device identifier (the controller key used for local locks is salted and stays in the page), anything you type, error messages or a client timestamp; the server adds only the day it received the event. Every field is a number, a yes/no or a value from a fixed list, and the page and the server both reject anything else. The exact contract is `ops/calib-telemetry/contract/events-v2.schema.json`, also published in the [OpenAPI document](https://subralabs.com/openapi.json).

Like any web request, the upload reaches the server with network metadata such as your IP address. The telemetry service keeps it in memory only for its per-minute rate limit and never writes it to the telemetry records.

The web server in front of the service (nginx on subralabs.com, behind Cloudflare) does keep an access log, as it does for every page of the site, telemetry requests included. For each request it records the IP address, the exact time, the requested path and the browser's user agent. These logs are kept to debug the server and protect it from abuse, never to analyse the telemetry. They are deleted after 14 days (the logs rotate daily and the last 14 are kept). Cloudflare, which proxies the site, processes the same request data under its own policy.

## Diagnostic recording

A diagnostic recording is for a stick that drifts again soon after a calibration. It is not telemetry: it starts only when you press **Start recording** in the panel opened from the footer link, it is kept in memory in that tab, and it stops by itself after 30 minutes. Nothing is sent while it records.

A report contains:

- times in milliseconds from the start of the recording, never a date or time of day;
- connections and disconnections, with the board revision and firmware version, and the memory (NVS) status;
- each drift test result (offset, noise and signed position per stick); the start of each Quick, Guided, Range, Write and Restart, and their results as the same typed events described above (outcome, before and after per axis, whether the calibration was committed, whether a power cycle is needed), built with a fixed code `00000000` instead of the visit code, so they can't be linked to telemetry from the same visit;
- whether the calibration in the controller became unsaved or saved, and whether the page asked for a power cycle;
- each release: where the stick stopped (signed position per axis in 8-bit steps, 0.1 step), how far it had been pushed, and how long it took to settle;
- once per second, per stick, the median position and spread of that second's readings, and how many readings there were. The raw readings (about 250 per second) never leave the browser;
- the thresholds used to detect releases, and how many items were dropped if a cap was reached.

It never contains the serial number, the controller color, the firmware build date, a device identifier, error messages or typed text. The exact contract is `ops/calib-telemetry/contract/diagnostics-v1.schema.json`; the page and the server both reject any other field.

**Download JSON** saves the same report to your computer. **Send to the developer** first shows its size and contents and asks you to confirm; only then is it sent to `https://subralabs.com/api/calib/v2/diagnostics`. Your telemetry setting doesn't change, and you can send a report with sharing off. The server stores the report as it is, plus the day it was received, under a random code (`SC-` and 8 characters) that it shows you to quote in a GitHub issue. Reports are deleted after 180 days. A connection can send at most 3 reports per hour; as for telemetry, the IP address is used in memory for that limit and appears in the web server's access log (14 days), never in the report.

If you accepted an earlier description, the notice appears again when the shared fields change. The updated events are only sent after you choose **Keep sharing** again. Until then nothing from the visit is sent, including the Quick result you had already agreed to.



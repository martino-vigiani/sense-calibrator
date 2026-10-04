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
  - `rest`: a summary of 30 seconds of stick readings taken while the page is visible, no calibration or dialog is open and nobody moves the sticks, at most 8 per visit: report count and intervals, and per stick the distance from its resting point (median, 95th percentile, maximum), the spread per axis, how often it jumps 1, 2 or 4 steps, and the resting offset. The readings themselves never leave the browser.
  - Every event also carries the board revision (and firmware, except `save` and `rest`), the release date of the page, its order in the visit and a random code created when the page loads. The code links the events of one visit, is never stored, and a reload creates a new one.

The v2 events never contain the serial number, a device identifier (the controller key used for local locks is salted and stays in the page), anything you type, error messages or a client timestamp; the server adds only the day it received the event. Every field is a number, a yes/no or a value from a fixed list, and the page and the server both reject anything else. The exact contract is `ops/calib-telemetry/contract/events-v2.schema.json`, also published in the [OpenAPI document](https://subralabs.com/openapi.json).

Like any web request, the upload reaches the server with network metadata such as your IP address. The telemetry service keeps it in memory only for its per-minute rate limit and never writes it to the telemetry records.

The web server in front of the service (nginx on subralabs.com, behind Cloudflare) does keep an access log, as it does for every page of the site, telemetry requests included. For each request it records the IP address, the exact time, the requested path and the browser's user agent. These logs are kept to debug the server and protect it from abuse, never to analyse the telemetry. They are deleted after 14 days (the logs rotate daily and the last 14 are kept). Cloudflare, which proxies the site, processes the same request data under its own policy.

If you accepted an earlier description, the notice appears again when the shared fields change. The updated events are only sent after you choose **Keep sharing** again. Until then nothing from the visit is sent, including the Quick result you had already agreed to.



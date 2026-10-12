# Changelog

Notable changes to Sense Calibrator. Dates are ISO 8601.

## 2026-10-13

### Range recheck

From telemetry v2, 27 September to 12 October: in the first resting window after a Quick or Guided result within one step of center, a stick was off-center (more than 1.25%) in 12 of 13 cases when a complete Range calibration ran in between, against 29 of 93 without one. After Range the worst stick rested between 1.7% and 11.4%, never at 15% or more. The sample is small and Range moving the center (hardware check H12) is still not confirmed on a physical controller, so the copy calls it a hint. These changes are verified with the virtual DualSense and the app harness. No new HID command, no change to the v2 contract.

- **After a complete Range, the page measures the center again before you save.** The drift test that already followed the Range check now also decides the result panel. If both sticks are still within one step, the panel says so and the save invitation comes back. If a stick rests off-center, the panel says "Range applied, but the center moved" (or "is off", when there was no centered reading just before the Range), shows each stick before → after, and offers **Quick calibration**. From 15% off it offers Guided instead, and an axis still at the edge says the stick is likely faulty.
- **Write asks for a second confirmation until the center is checked, and while it is off.** Between Range and the drift test the reason is "The center hasn't been measured since the Range calibration"; after an off-center recheck it is "A stick rests off-center after the Range calibration. Run Quick calibration before saving." It is guarded, not disabled: the range itself is complete, a stick under 15% can be recentered with Quick and then saved in one Write, and the reading before the Range was taken on the old range, so it can't measure how much worse the center got. A recheck at 15% or more, or with an axis at the edge, disables Write with the existing reasons. A moving or failed drift test leaves the check pending; the next still one completes it. A Quick or Guided result replaces it.
- **"Range, then Guided" advice now says to check the center after Range.** The Pinned drift result, the Quick and Guided pinned results and the Quick preflight routes say that the page measures the center again after Range and to run Quick, or Guided from 15%, if a stick is off. They no longer say Guided is the only next step.
- The outcome of each recheck (before, after, verdict) is kept in the local calibration history as a `range-recheck` event. It is not sent. The two new Write reasons are not v2 lock reason codes, so a v2 `save` event in this state reports `guarded` with no reason.
- The calibration guide and the drift test guide say that Range can leave the center off and that the tool rechecks it. `docs/hardware-checks.md` records the telemetry hint and the procedure for H12.

### Telemetry: timing and landings

Telemetry v2 finds a stick off center again in 148 of 282 resting windows (52%) that follow a Quick or Guided result within one step, in the same visit. The events have no time and say nothing about what happened in between, so a calibration that was lost (a Range, an unplug, a restart) can't be told apart from a worn stick that stops somewhere different after every release. Deriving what we can from the event order already says a lot: with a Range after the centering, 63 of 66 windows are off center (95%); without one, 85 of 216 (39%).

- **Rest summaries say how long ago the last calibration was**, rounded to 10 seconds and capped at one hour (`sinceCalS`), which kinds of operation followed it (`opsSince`: the calibration itself, then Range, Write, reconnect, restart or confirmed power-off, each once, in order) and how many times a stick was released since (`landings`). With no Quick or Guided calibration in the visit, or after a different controller was connected, they are `null`. The fields are optional, so pages still open from an earlier release keep working.
- **New `landing` event**: where each stick stops after being pushed at least 25% and let go, since the last calibration (since the page opened if there was none), from `js/calib/landing.js` and its summary: per stick the count, the median stopping point and its spread (50th and 95th percentile, in LSB), the time of the first and last release and the last 20 stopping points, each rounded to half an LSB with its time since calibration. At most two per visit: after 20 releases following a calibration, and when the page is left. It counts only while no calibration, Write or Range is running, and never with sharing refused; turning sharing off forgets the releases collected.
- No clock time, serial number or device ID: apart from durations, the only times are relative to the last calibration. The consent notice and the footer label name the new data, and the description version (scope) is now 5, so people who accepted an earlier one see the notice again before anything is sent. App build 20261013.
- The v2 report adds `afterCalibration`: off-center rate of those resting windows by time since calibration and with or without each operation (from the new fields, and Range and Write from the event order for older rows too), and for the release points, how many sticks have a 95th-percentile spread wider than one lattice step (about 1.58 LSB, the wear signature) or a median past 1.25% (a calibration that moved). It describes; it gives no verdict.
- **Don't share no longer accepts the description.** It used to record the current scope anyway, so ticking the Quick dialog's sharing box later turned on every v2 category, release points included, without the notice. Now only **Keep sharing** (or the footer box, whose label names every category) accepts it; after Don't share, the Quick box turns sharing back on for v1 only and the v2 events wait for the notice on the next visit.
- Contract: `events-v2.schema.json` and fixtures updated and copied to the server, pins updated on both sides. Deploy the server before the site, then regenerate the OpenAPI components on subralabs.com.
- Verified with the virtual DualSense and app harness only, not with a physical controller.

### Diagnostic recording

Telemetry v2 shows the stick off center again in 52% of resting windows after a centering, but its events have no time and don't record where the stick stops after each release, so a calibration that was lost (unplugged or powered off without Write, a Range that moved the center) can't be told apart from a worn stick that stops somewhere different every time.

- **Diagnostic recording**, from a link in the footer: up to 30 minutes, in memory in this tab only, with times counted from the start (never the time of day). It notes connections, board and firmware, memory status, each operation's start and result (the same typed events as telemetry, before and after per axis, committed, power cycle needed), each Write and Restart, the power-cycle lock, where each stick stops after every release, and the resting position once per second. No serial number, device ID or raw readings.
- The panel shows the resting offset over time for each stick, with releases as dots and lettered markers for connections and operations, a table of the last releases, and a per-stick summary (typical stop, how much stops vary). It never gives a verdict: the thresholds that would separate a lost calibration from a worn stick are not validated yet.
- **Download JSON**, and **Send to the developer** after a confirmation that shows the size and what's inside. It is separate from the telemetry consent, which doesn't change. The server answers with a code (`SC-…`) to quote in an issue; the bug report template has a field for it.
- `js/calib/landing.js` detects releases from the HID reports with the existing thresholds (leave the rest point by 8%, then 300 ms still within 3.5%); a thumb held still past 15% is a hold, not a landing. It is pure, so telemetry v2 can reuse it.
- Server: `POST /api/calib/v2/diagnostics` validates the report against `diagnostics-v1.schema.json` (closed at every level, embedded events against the v2 contract), with a 512 KB body limit, 3 reports per hour and 6 per day per IP, one file per report (600, folder 700), a 200 MB and 10,000-file cap (507) and deletion after 180 days. A typical 30-minute recording is about 100 KB.
- A global daily quota on top of the per-IP one: at most 50 reports and 10 MB per UTC day (`DIAG_DAILY_MAX_REPORTS`, `DIAG_DAILY_MAX_BYTES`), then 507 with `Retry-After` until midnight UTC. Each IP is also capped at 6 reports per 24 hours (`DIAG_IP_DAY_MAX`), so a single address at 3 per hour can't use up the whole day's quota and block everyone else's reports until midnight. The periodic rate-limit cleanup keeps 24 hours of history for this limiter; it first kept only one hour, which silently disabled the daily cap. With 3 per hour per IP alone, one address could fill the 200 MB in about five and a half days and close the endpoint for months; now it takes at least 20 days, and the service logs a warning when the folder passes 80% of its cap. The folder's bytes and file count are kept in memory (scanned at startup and by the daily cleanup, updated on every save) instead of being read on every request and `/health`; the file cap is `DIAG_MAX_FILES`.
- The time of receipt isn't kept in the file system either: a report's modification date is set to midnight UTC of the day it arrived (the deletion after 180 days uses it).
- The page and the privacy details are honest about linking: the report's calibration events have their own code and numbering, but their values are the same ones telemetry sends, so with sharing on a report can be matched to the telemetry of the same visit. The send dialog says so; the panel says that nothing is sent unless you press Send. The report's `save` event now points to and counts the calibrations in the report, not the telemetry numbering.
- Verified with the virtual DualSense and app harness only, not with a physical controller.

## 2026-10-12

### Search guides and phones

- **Guides target the searches people make.** The drift test guide is now "PS5 controller stick drift test online" and the calibration guide "DualSense calibration online", with matching titles, descriptions and headings. Both have a short FAQ, and its structured data repeats the visible questions and answers word for word.
- **New guide: Sense Calibrator vs dualshock-tools.** It credits the project the calibration commands come from, says which controllers each tool supports and when to use dualshock-tools instead. Facts about dualshock-tools come from its README and site, checked on 12 October 2026. Its warning about drift is quoted word for word ("This utility cannot fix stick drift", and that calibrating may make the problem worse with no way to undo it), and the GitHub comparison gives dated numbers (765 stars and 265 forks against 6 and 1, on 12 October 2026).
- The drift test guide's FAQ names all three drift labels: Mild drift (below 3.5%), Marked drift (below 15%) and Severe drift (15% or more), the badges the drift test shows. Before, Severe drift was missing.
- Every guide links to every other guide, and the homepage lists all four. The sitemap includes the new page, with every `lastmod` set to 2026-10-12.
- **Phones get a way to keep the link.** Where WebHID is missing on a touch device, the page offers **Send link to my computer** (the system share sheet, when the browser has one) next to **Copy link**, and shows the address to type. Desktop Chrome and Edge are unchanged.
- The homepage FAQ and the guides no longer say a power-off "should" discard an unsaved calibration. They say it has not yet been confirmed on hardware (H10). The in-app copy is unchanged.

### Quick preflight

From telemetry v2 (27 September – 12 October): 250 of 825 Quick runs (30%) ended in `preflight`, with nothing sent. 241 of them expired on the first 3-second wait. In the same visit, about half had a stick resting past 15% (Guided or rest measurements of 15–100%); the others had sticks that rest centered, and 64 of those retries failed again.

- **The first Quick wait lasts up to 8 seconds**, the same time already allowed before every pass. The check is unchanged: both sticks still and within 15% for 300 ms of fresh reports, then the 1-second baseline and a second hold before any command.
- **Quick says why it didn't start.** While it waits, the dialog says whether a stick is moving or held still off-center (with its reading). A blocked start names the cause: a stick held still past 15% is routed to Guided (Range for an edge), saying "if nobody is touching it"; no readings point to the cable, also when they stop partway through the wait (the check used the time of the last report, so a controller that went silent after a few reports was described by its last window and could be routed to Guided); readings that keep pausing, with nothing that looks like a hand, get a connection message instead of "Release both sticks"; a moving stick still gets "Release both sticks". A stick held still past 15% stops the wait after 3 seconds, as before, unless the last drift test saw both sticks resting centered.
- The cause is kept in the local session history only. The v2 event contract is unchanged; the app build is now 20261012, so the report can compare the preflight rate before and after.
- Simulator, model-verified: preflight 24 → 17 in 714 sessions, no change in results at or above 15%, no sample after a timeout; one extra stalled pass in 714. Not tested on a physical controller.

### Guided stop

- **Guided calibration can be stopped without unplugging the controller.** In the v2 telemetry (27 Sep to 12 Oct), 81 of 320 Guided runs ended with the controller unplugged or the page closed mid-session, often after many failed waits. Before the change, Stop appeared only after two missed corners. It now also appears after any failed wait at the current step. Stop sends nothing: it leaves the session uncommitted, keeps the power-cycle lock and opens a result panel with **Restart the controller** and **I already turned it off**.
- **A failed wait now says why.** If a stick stays beyond 50% of center when the session starts, the page says that pressing Continue again won't help. It no longer offers **My stick doesn't rest still**, because that option can't widen the 50% bound. If the stick was already that far out before Start, the page says it is probably stuck near the edge. At a corner, the message says which stick settled away from its rest point and how far. If that is still outside the looser check, the message points to Stop. If the readings stopped before the wait ran out, the page says the controller stopped sending readings, not where the stick last was. The diagnosis only changes the wording. The sample rules, tolerances, escape radius and HID commands are unchanged. The v2 contract is also unchanged, so a stopped run is still reported as `error` with `needsPowerCycle`.
- Verified with the virtual DualSense and app harness only, not with a physical controller.

### Save step

From telemetry v2 (27 September – 12 October): of 346 visits with a calibration, 234 saved one. 49 unsaved periods, in 41 visits, had Write allowed but never opened the Write dialog: 48 of them had seen the save step, none opened the reminder, and the median wait was 114 s (19 s to 58 min). 43 ended with the controller disconnected and 6 with the page closed. The last calibration was a centered Quick in 23, a complete Range in 12, a Guided result in 6 and Quick within 1 step in 2; the other 6 were results to check (noisy, Quick can't get closer, or none). In 24 of the 43 the visit went on after a reconnect, and in 15 of those the next calibration started from sticks off-center again. The data can't tell whether the unplug or a power-off discarded the calibration. App builds: 37 from 20261001, 8 from 20260928, 4 from 20260927.

- **After a good result, the result panel itself offers Write to memory.** For a centered or within-1-step Quick or Guided result and a complete Range, with Write allowed, the panel says it isn't saved yet: turning the controller off should discard it, and unplugging the cable may too (not confirmed). The button opens the same Write dialog. Results to check, a guarded Write and a disabled Write don't show it.
- The save step says that unplugging the cable may lose the calibration too, not confirmed.
- **Leaving the page asks first only when there is something to save**: a calibration in progress, or an unsaved one whose Write is allowed. It no longer asks for a result whose Write is off or needs checking.
- **Reconnecting the same controller after an unsaved calibration says so.** The panel says the last calibration wasn't saved, that we haven't confirmed whether unplugging discards it, and that the drift test shows where the sticks are now. It doesn't offer Write: that still needs a calibration made after reconnecting.
- When the Write dialog closes and the button that opened it is gone, the focus moves to the drift test card instead of the page.
- The v2 contract and the app build (20261012) are unchanged. The report can't tell the panel button from the save step's: both count as `opens`. Verified with the app harness only, not with a physical controller.
- The calibration guide now says **Stop and turn off controller** appears after one failed wait at the same step as well as after two missed corners.

### Range starts and rotation

From telemetry v2, 27 September to 12 October: 215 Range calibrations, of which 124 were complete, 63 incomplete and 28 errors. These changes are verified with the virtual DualSense and app harness, not with a physical controller. Range's completion requirements, the Write lock, the HID commands and the v2 contract are unchanged.

- **A Range start that the controller doesn't accept now asks for a restart.** Nine errors were starts that the firmware refused or didn't confirm, and seven of them were immediate retries in the same visit, after a five-second toast. The result panel now stays on screen with **Restart the controller** and **I already turned it off**. Until the controller has restarted, Range, Quick, Guided and Write stay off for it, so a retry can't be refused the same way again. If it refuses again after a restart, the panel says that restarting didn't help. A start with no reply still shows "The controller stopped responding".
- **Finish anyway no longer appears at 15 s when only rotation is missing.** Of the 39 incomplete ranges that recorded what was missing, 31 had already covered the edge and reached all four sides on both sticks. They were missing only full turns or the reverse half-turn, often on a right stick at about one turn. Their median length was 27 s, so most were finished soon after the button appeared. In that case the button now stays **Done** until 60 s; 90% of complete ranges finish within 58 s. The hint says what each stick still needs, for example "Right stick: 1 more full turn against the rim, then half a turn the other way". The confirmation no longer says that stick travel may become unreachable. If an edge or a side is missing, Finish anyway still appears at 15 s, and once it has appeared it stays for that range even if only rotation is left afterwards (before, it could turn back into a disabled Done until 60 s).
- **The hint names a stick that hasn't moved.** Some ranges were abandoned or finished with one stick still at zero coverage.
- **The Write lock text for a range with an unknown result** no longer says "had already closed" when the range failed, was interrupted or never started. The six `range-already-closed` save reasons in the data all came from such ranges; none came from a real code 3. The v2 code is unchanged.
- **The v2 diagnostics report splits Range `error` events into `start`, `interrupted` and `close`, using fields that already exist.** It also counts incomplete ranges where only rotation was missing. On the real data this gives 9 failed starts, 19 sessions left open by closing the page or unplugging, and 0 failed closes.

## 2026-10-01

- Range shows each stick's edge coverage, four sides, full turns and direction reversal separately. A full coverage bar no longer hides a missing reversal; short sectors are marked on the dials. Completion and Write safety requirements are unchanged.
- Quick records the stability of the verification measurements it already takes, including rejected extreme readings. Range records which completion requirements were missing. These optional v2 fields preserve older pages and logs; sharing waits for renewed consent. No calibration commands, timings, passes or thresholds change.
- The private nightly quality report has a versioned deployment, verified counts and an atomic update, with a separate v2 history and rollback on failure. It uses the existing v2 definitions, rather than the old report's thresholds and exclusions.
- Automated checks use synthetic controllers and real browser rendering. They do not establish the cause of any physical controller's extreme reading.

## 2026-09-28 (night)

- **When Quick can't center a stick, the result names the axis that stays off.** For example: "Pass after pass, the left stick’s Y axis stays about 6.5 steps above center; the other axes are centered." Telemetry v2 showed that failed runs almost always leave one axis at the same value while the other three are centered.

## 2026-09-28 (evening)

- **Guided also sends nothing when the worst stick is within one step of center (≤1.25%).** In the telemetry, Guided made nearly centered sticks worse (1.2% → 2.3%, 1.2% → 3.4%); the page now points to Quick for the last step. **Calibrate anyway** still forces it.

## 2026-09-28 (afternoon)

From the first telemetry after the audit release: a controller already centered at 0.6% came out of Guided at 13%, and the result was saved after the "worse than start" confirmation.

- **Guided sends nothing when both sticks are already centered.** Like Quick, it says "Already centered: nothing was sent" and offers **Calibrate anyway**.
- **A result three steps (2.35 points) or more worse than the start can't be written to memory.** Write is off, not just guarded; smaller regressions still ask for a second confirmation.
- **After a worse Guided result, the panel suggests Quick first**, which usually brings the sticks back to center.

## Unreleased — 2026-09-28 audit safety fixes

These changes are verified with the virtual DualSense and app harness, not with a physical controller. The telemetry v1 payload and v2 contract are unchanged.

1. Center and Range Write locks survive a reconnect and conservatively survive a page reload without storing a device identifier.
2. Interrupted Guided sessions, including page exit and the interval after `calibEnd` but before verification, keep Write locked or guarded and emit one v2 event.
3. Interrupted Range sessions, uncertain starts and failed closes keep Write disabled; page exit and disconnect emit one v2 event.
4. Write counts as saved only when the final NVS status is `locked` or `pending_reboot`. The observed `0x03030201` (`81 03 03 02 01`) is `locked`; any other status keeps the calibration unsaved and reports “Save not confirmed.”
5. A late flash from one controller cannot query or change the next controller's save state.
6. Guided requires a stable final measurement before it calls a result verified.
7. HID reply decoding and full calibration command checks run inside the protected transaction, preserving safety flags on malformed replies.
8. Quick cannot verify a mostly moving signal from a small quiet subset alone.
9. Holds, offset measurements and drift tests require fresh, continuous HID reports for their stated duration.
10. Range needs sufficient sector coverage on both sticks before it is complete.
11. Quick and Guided name and guard a stick that worsened even when the overall worst value improved.
12. A timed-out Restart poisons the connection, preventing later HID commands on it.
13. Revoking sharing discards queued events and is checked again immediately before each upload.
14. A late calibration event cannot claim another controller's save period.
15. A first-pass stall without a commit no longer claims a commit or raises the unsaved state; its power-cycle lock remains.
16. The precision test calls low edge coverage partial and gives no global edge verdict.

## Unreleased — telemetry v2

Needs the telemetry service with `POST /api/calib/v2/events` deployed first; until then the new events get a 404 and are dropped, and nothing else changes.

- **Sharing now covers whether calibrations get saved and how noisy resting sticks are.** If you choose to share, the page sends small typed events to a new, versioned endpoint: each Quick, Guided and Range calibration (type, outcome, before → after offsets, pass results, duration), each Write to memory attempt (result class and memory status), how each unsaved calibration ended (saved, disconnected or page closed, with the reason Write was locked and how often the dialog was opened or cancelled), and at most 8 per visit 30-second summaries of how much the sticks jitter while nobody touches them. Never a serial number, device ID, typed text or exact time; a random code links the events of one visit and is discarded with the page. Complete Quick results still go to the old endpoint too, unchanged.
- **The notice asks again, once.** People who had already answered it see it one more time, headed "What's shared has changed", because the new events are data they did not agree to. Until they answer, nothing from the visit is sent, the old Quick result included; **Don't share** stops all sharing. People who had chosen not to share are not asked again.
- The notice is shorter (three lines on a laptop): it names the three kinds of data and links **Details**, the full description in the README. The footer checkbox carries the longer description.

## 2026-09-27

- **Results that aren't fully centered now say you can try again.** In the collected telemetry, about 4 in 10 people who ran Quick again right after a result that wasn't centered ended fully centered (16 of 40 back-to-back sessions on the same controller; 2 of 40 got worse). The result panel says so, offers **Run Quick again**, and reminds that nothing is permanent until it's written to memory. When two passes land on the same value, Guided stays the first suggestion, with Quick as a second option.

## Unreleased — 2026-09-25

Simulator figures in this section are **model-verified**: the real calibration code run against a model of the controller fitted to the collected telemetry. They are not hardware measurements. Hardware checks H0, H10, H11 and H12 have not been run yet. The copy says so wherever it depends on them: the power-off advice (H10) says the temporary calibration "should" be discarded, not that it is, and nothing presents unplugging (H11) as a way out.

### Calibration safety

- **Quick calibration sends nothing when both sticks already read below 1.2%.** They are at the measurement floor, and a pass from there can only stay or get worse. The panel says "Already centered: nothing was sent" and offers **Calibrate anyway**; that measurement replaces the previous result, so an older "Don't save this result" no longer keeps Write disabled. Starts at one step (1.24%) still calibrate.
- **A stick that rests past 15% is sent to Guided, not told to let go.** When the drift test already found a severe offset (or an axis pinned at the edge), a Quick that can't start says so first and its main button opens Guided (or Range), instead of showing "Stick held".
- **Every pass waits for released, centered sticks first**, not only the first one. A thumb resting on the rim no longer gets written in as the new center; the modal says "Hold detected: let go of the sticks" while it waits.
- **Samples are only taken from a still stick at the point it rests.** Each of the 12 samples in a pass needs a stable reading within 4 steps of where the sticks rested after the pass began, and a timed-out wait never produces a sample.
- **A pass that can't collect its 12 samples is abandoned, not committed.** After 15 s the modal asks you to let go (with Cancel); after 30 s more, or on Cancel, the pass stops without writing anything, and the controller has to be restarted before any other calibration or Write. The same now applies when a pass fails for any other reason while it is open (a refused sample, a failed write, an error in the guided procedure, an unplug). Disconnecting, replugging or reloading the page doesn't clear this: the block follows the controller until **Restart** is sent or you confirm you turned it off, and even then a session still open is refused, never committed. If a later pass stalls, the panel says the earlier pass is active and unsaved instead of "nothing was committed".
- **A result of 15% or more stops the loop.** It is reported as "Don't save this result", Write is disabled, and a single recovery pass is offered but never run automatically.
- **A result worse than the start is never called "converged".** The loop keeps its remaining passes to try to recover, with at most one extra pass when the other stick is already at the floor, and none within one step of 15%, where one more pass could cross it. Warnings about damage now come before explanations such as a worn sensor.
- **A controller that stops answering is never sent another command.** A command without a reply within 1 s marks the connection as not responding until the controller is reconnected; if the stuck command was a write, the page treats the calibration as possibly applied. The panel explains that and asks you to turn the controller off and reconnect it, without the raw error.
- **Unsaved changes are tracked from the moment they happen.** The unsaved banner and the "may still be active" reminder are raised as soon as a pass writes to the controller, so unplugging in the middle of a later pass still warns you.
- **Calibration is blocked when the controller reports its memory as unlocked**, where a "temporary" calibration could become permanent. Firmware built in 2020–2021 asks for confirmation once per connection.

- **A calibration pass left open is caught in more cases.** The page marks a pass as open before it starts it, so reloading or closing the tab in the middle of a pass (or between Guided corners) comes back blocked until the controller is restarted, and never closes the half-finished pass into the controller. A start command that got no reply counts as an open pass too. With more than one controller, each keeps its own block: leaving a pass open on a second controller no longer replaces the block of the first, and restarting one controller never unblocks another. After a reload the page can't tell which controllers had a pass open, so every controller stays blocked until it is restarted itself. Restart re-enables calibration only once the controller actually disconnects; if the restart command doesn't reach it, the page says so and keeps Write off.

### Results and saving

- **Saving is now the obvious next step.** After a calibration, a "Last step: save it to the controller" block appears right under the result, with before → after figures and a large **Write to memory** button, instead of a banner at the bottom of the page below every action. It scrolls into view (instantly with reduced motion), draws a single soft ring once it has settled (none with reduced motion) and is announced once to screen readers. A compact bar at the bottom of the screen keeps reminding you while the block is scrolled away, and disappears after a successful write or when the calibration is discarded. It never opens the Write dialog on its own. When Write is locked (for example a result of 15% or more), the block turns muted with an outlined, disabled button, says why, and does not pull the page away from the result's own next steps; the bar then offers "See why" instead of Write.
- **The result stays on the page.** A persistent panel shows each stick before → after, in the same terms as the drift test (for example "0.6% · at floor", "1.2% · 1 step"), and what to do next.
- **Write is disabled** after a result of 15% or more, a stick pinned at the edge, an abandoned pass, an unresponsive controller, or an incomplete or unknown range. **It asks for a second confirmation** (with Cancel focused) after a result worse than the start, worse than an earlier pass, or not verified.
- **Advice to turn the controller off to discard a calibration appears only when its memory reads "locked", and says it "should" discard it** (H10 not run yet). Whether unplugging the cable alone discards it has not been checked (H11), and the copy says so instead of recommending it.
- **The drift test no longer says "No calibration needed" while a calibration is waiting to be saved.** A centered retest after calibrating says the result is still temporary and should be written to memory, or, if it isn't better than before, points to the result panel.
- **A "may still be active" banner after a reload.** If this tab calibrated without saving, a reload says that a temporary calibration may still be on the controller. It stores no device identifier.

### Motion

- **Banners, notices and results no longer pop in.** The error and help notes under Connect, the "calibration from earlier in this tab" note, the result panel and the reason Write is off open their space and fade in, and close it again when they go away, instead of appearing and vanishing in one frame and pushing the page around. Toasts open their slot at the bottom and slide back out the way they came, so a new one lifts the others instead of making them jump; the reminder bar at the bottom rises in and drops out the same way. Drift-test verdicts fade out when a re-test starts and fade back in with the result.
- **Nothing moves under an open dialog.** A result that arrives while a dialog is closing is already in place as the dialog fades out, so the page doesn't move twice.
- **No flash of the reminder bar.** After a calibration the bar waits a moment before appearing, so it no longer blinks in and out while the page scrolls to the save step.
- **Calmer "save it" cue.** The save step no longer scales up; it draws one soft ring after it has settled. A stick recognised as held gets one short ring on its dot; the movement meter itself, the dials and every live reading stay instant.
- All durations and curves come from one set of tokens (160 ms exits, 240 ms entrances, 280 ms for space opening, all ease-out), and exits are faster than entrances. **With reduced motion** nothing slides or resizes: new elements fade in, elements in the page disappear at once, and the save cue does not play.

### Guided and Range calibration

- **Guided calibration never samples a held stick.** Each corner needs both sticks to have reached it and then to rest, still, where they rested when the session began. A thumb held still at a corner or on the rim is never sampled. A stick that never settles gets an explicit, confirmed "My stick doesn't rest still" option that loosens the position check without removing it. If a stick is touched during the one-second measurement before the procedure starts, nothing is sent and the page asks you to let go and press Start again, and the rest-point check never allows more than 8% per axis, whatever that measurement read (a touch there used to widen it enough to sample a thumb held 57% away).
- **Range opens on an intro step and only starts on Start.** Once running, it can only end when both sticks have covered the whole edge (or by turning the controller off), and the intro says so before anything is sent. With a stick pinned at the edge, the intro warns that the range may never complete.
- **Range Done needs real coverage:** every direction, at least two turns and a change of direction on both sticks. After 15 s a confirmed **Finish anyway** can close an incomplete range, and then Write stays disabled until a complete range replaces it, including after reconnecting the same controller, and including when a different controller was connected in between (connecting another controller no longer clears the lock of the first). Whether Range also moves the center has not been checked yet (H12), so routing a pinned stick to Range is presented as something to try.
- A short check step after Range measures how round the new range is.

### Interface

- **The movement meter describes movement only.** "Not moving", "Moving a little" and "Moving" replace "Hands off: steady" and "Sticks at rest", which a thumb holding a stick still would also produce. When the page knows a stick is held, the meter says "Stick held: let go".
- **Connection help.** An empty device chooser shows a short checklist, and WebHID errors are explained in plain language.
- **×10 dial zoom** shows the byte lattice near the center, so the 0.555% floor and one 1.24% step are visible. It changes the drawing only, never the measurements.

### Accessibility

- Modals keep keyboard focus inside them, start on the right control, and never drop focus when the active button is disabled mid-run.
- Status messages are announced once per change, not on every refresh; errors go to an alert region. While you rotate the sticks in Range, the status line announces milestones (a direction reached, a whole turn, the change of direction) at most about once a second instead of a running turn counter.
- On a phone, the first-launch sharing notice no longer covers the result panel's buttons: the page keeps room for it at the bottom and scrolls the panel's actions into view.
- Progress bars expose their value, the guided steps are announced as text, and verdict details are visible text.
- Text meets 4.5:1 contrast and component edges 3:1.

### Privacy

- **The serial number is masked by default**, with a Show serial button, so a shared screenshot does not publish it.
- The precision test's "previous result" and the range write lock are keyed by a salted local hash of the serial that is never sent anywhere.
- Network telemetry is unchanged: still the same nine fields, and only for complete Quick sessions. A run stopped before its result (a stick held before a later pass) or cut short by the time limit counts as incomplete and stays in this browser.


### Public scope

- The public site is focused on DualSense drift testing and calibration again. Sensitivity Finder and Gameplay Lab are available only through local preview mode while they are still being developed.
- Search metadata, structured data, the main page and the sitemap now describe the stable public workflow consistently.
- The social preview now uses the same stick drift and calibration message as the page.

### Data quality

- Network telemetry now sends only complete Quick calibration records that match the strict server contract. Richer events stay in local browser history until a versioned server contract exists.
- Failed requests are no longer reported as successful uploads. Incomplete or unverified results stay local instead of becoming misleading data.
- Contract tests cover accepted uploads, rejected events and network failures.
- A private daily VPS report now summarizes valid sessions, board cohorts, meaningful improvement, the public 1.2% threshold and suspicious high-deflection readings. It never exposes individual records or adds a public endpoint.

### Repository

- The README now explains setup, use, limits, privacy, contribution and licensing in direct language.
- Contributor guidance, structured issue forms, a pull request template and an automated test workflow were added.

### Calibration

- Quick calibration now requires both sticks to remain near center before starting, including a fresh check after its baseline measurement. Holding a stick steadily far from center can no longer pass the startup stability check. Blocked attempts keep retry and cancel available and send no calibration commands; cancelling resumes the drift test. The initial 15% radial limit is a conservative safety policy; controllers resting outside it are directed to guided calibration.
- **The quick calibration no longer keeps a worse result than one it already reached.** Every pass commits to the controller immediately and the tool never reads the calibration back, so a pass that came out worse was irreversible — and the loop's exit rule fired on exactly that case, freezing the regression. The loop now tracks the best residual it saw, treats a regression as a reason to keep going rather than to stop, and only calls it convergence when the result is genuinely at the floor. For scale: one quantisation step is 0.784 percentage points, while the whole "centered" band is 0.645 points wide, so a single-count fluctuation between passes was enough to hand back a visibly worse controller.
- **The result is now reported honestly.** If the final pass ends above the best one, or above where the controller started, the tool says so instead of announcing the number as a success. The threshold for calling something a regression sits above one quantisation step, so measurement noise alone cannot trigger a false alarm.
- **The stability gate no longer ratchets.** It widened on disturbance and was never narrowed, so a single transient in the first pass degraded every later pass. It now relaxes toward its baseline at each pass, by less than it widens, so a genuinely unstable signal does not re-pay a full timeout every round.
- **The gate can no longer become more permissive than the threshold the drift test uses to call a signal "movement."** Its ceiling was 50% above that threshold, and two widenings were enough to cross it and start feeding a hand on the stick into the firmware average.
- **A calibration that could not be verified no longer reports the previous pass's number.** When the verification measurement returned no usable data, the displayed residual still referred to a calibration that had already been overwritten.
- **A calibration session left open in the controller no longer blocks every later attempt.** If a run was interrupted mid-way, the firmware kept the session open and every subsequent start failed until the controller was restarted. Starting a calibration now closes a stale session and retries once; when that repair writes to the controller, the unsaved-changes banner is raised.

### Telemetry

- **Failed calibrations are recorded.** Only successful runs produced an event, so the most informative cases — the ones where the algorithm does not hold — were invisible.
- **The guided calibration reports real measurements** before and after, instead of a bare completion flag. It is the path taken for stubborn drift, so those were the sessions worth measuring.
- **Per-axis drift direction is kept.** Only the total offset survived, and it is the hypotenuse of the two axes, so direction could not be recovered. Potentiometer wear is axis-asymmetric, which is exactly what makes it worth recording.
- **Events from one visit can be read as a sequence.** A random value is generated on each page load and never written to disk, so the drift test, the calibration and the precision test of a single visit can be related to each other. It is not a device or user identifier: reloading produces a new one, so two visits cannot be linked.
- Stability-gate telemetry now includes the widest gate reached and how many times it widened, not just the final value.

### Interface

- **The page works on phones.** The top bar forced a 428px scroll width at any narrower viewport, which triggers Safari's shrink-to-fit and renders the whole page zoomed out — the worst possible failure for a link opened from social media. Chips wrap, labels drop on narrow screens, and the bar stops being sticky where it would otherwise eat a fifth of the screen.
- **Visiting without WebHID explains what to do** instead of showing a generic error. The landing copy and the FAQ stay readable, since that is what search traffic comes for.
- Dial canvases no longer overflow their panel on small screens, and stay sharp when the device pixel ratio changes.
- Modals taller than the viewport are scrollable instead of clipped at the top.
- Touch targets reach 44px, and safe-area insets are honoured.
- Modals animate out as well as in, and `Escape` closes the ones that are safe to dismiss.
- **The drift verdict morphs between states.** The before/after transition is the point of the tool, and it was a hard cut. Reduced motion keeps this colour transition, since it aids comprehension rather than decorating.

### Precision test

- **The precision test measures the controller, not the player, and a perfect stick now scores 100.** Center uses the same statistics as the drift test on hands-off windows, and its score comes from the same table as the drift labels: 100 at the measurement limit (bytes 127/128), 90 one step of 128 off. The old linear scale capped a perfect stick at 89.
- **Two numbers instead of one blend.** Calibration (where each stick rests, which calibration can fix) and Hardware (how steady the reading is, which it can't), with one plain sentence. Return and Range are shown for information only until real data calibrates them.
- **A touch never scores.** Moving windows are dropped, a slowly pushed stick is caught too, and a run with too much movement restarts by itself (at most twice). A skipped or unfinished Return reads "Not measured", never 0.
- **It feels like a game and explains every wait.** It starts as soon as you let go, lights the direction to flick, rejects a guided release, shows where each flick settled at ×8, fills the range rings as you roll, and says why whenever it waits. About 15 seconds in the simulator's model of a user.
- **Before and after.** The previous result is kept per controller under a salted hash of the serial that never leaves the browser, and a change counts only when a stick moved by a full step.
- Sampling follows the controller's input reports, not the screen refresh; a gap or a background tab interrupts the check with a Retry, and retrying a Return flick redoes that direction for both sticks, so no flick is counted twice.

### Privacy

- **Nothing is uploaded before the first-launch notice has been seen.** The notice was a toast that scrolled away while uploads had already started. It is now a banner that must be answered: keeping sharing on sends what was recorded in the meantime, turning it off discards it. Sharing remains on by default.
- The notice is not shown where the tool cannot run, since no controller means no data to disclose.

### Fixed

- The residual-offset verification sampled on a page timer, which browsers throttle in background tabs: switching away mid-calibration silently cut the run short. It now samples on controller reports, like every other measurement path.
- The protocol credit in `js/ds5.js` named the wrong licence for dualshock-tools, which is MIT.

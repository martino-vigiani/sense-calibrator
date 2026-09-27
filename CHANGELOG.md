# Changelog

Notable changes to Sense Calibrator. Dates are ISO 8601.

## Unreleased — telemetry v2

Needs the telemetry service with `POST /api/calib/v2/events` deployed first; until then the new events get a 404 and are dropped, and nothing else changes.

- **Sharing now covers whether calibrations get saved and how noisy resting sticks are.** If you choose to share, the page sends small typed events to a new, versioned endpoint: each Quick, Guided and Range calibration (type, outcome, before → after offsets, pass results, duration), each Write to memory attempt (result class and memory status), how each unsaved calibration ended (saved, disconnected or page closed, with the reason Write was locked and how often the dialog was opened or cancelled), and at most 8 per visit 30-second summaries of how much the sticks jitter while nobody touches them. Never a serial number, device ID, typed text or exact time; a random code links the events of one visit and is discarded with the page. Complete Quick results still go to the old endpoint too, unchanged.
- **The notice asks again, once.** People who had already answered it see it one more time, headed "What's shared has changed", because the new events are data they did not agree to. Until they answer, nothing from the visit is sent, the old Quick result included; **Don't share** stops all sharing. People who had chosen not to share are not asked again.
- The share checkboxes and their tooltips describe the new scope.

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

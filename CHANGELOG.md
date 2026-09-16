# Changelog

Notable changes to Sense Calibrator. Dates are ISO 8601.

## Unreleased — 2026-09-16

### Public scope

- The public site is focused on DualSense drift testing and calibration again. Sensitivity Finder and Gameplay Lab are available only through local preview mode while they are still being developed.
- Search metadata, structured data, the main page and the sitemap now describe the stable public workflow consistently.
- The social preview now uses the same stick drift and calibration message as the page.

### Data quality

- Network telemetry now sends only complete Quick calibration records that match the strict server contract. Richer events stay in local browser history until a versioned server contract exists.
- Failed requests are no longer reported as successful uploads. Incomplete or unverified results stay local instead of becoming misleading data.
- Contract tests cover accepted uploads, rejected events and network failures.

### Repository

- The README now explains setup, use, limits, privacy, contribution and licensing in direct language.
- Contributor guidance, structured issue forms, a pull request template and an automated test workflow were added.

### Calibration

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

### Privacy

- **Nothing is uploaded before the first-launch notice has been seen.** The notice was a toast that scrolled away while uploads had already started. It is now a banner that must be answered: keeping sharing on sends what was recorded in the meantime, turning it off discards it. Sharing remains on by default.
- The notice is not shown where the tool cannot run, since no controller means no data to disclose.

### Fixed

- The residual-offset verification sampled on a page timer, which browsers throttle in background tabs: switching away mid-calibration silently cut the run short. It now samples on controller reports, like every other measurement path.
- The protocol credit in `js/ds5.js` named the wrong licence for dualshock-tools, which is MIT.

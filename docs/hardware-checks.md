# Hardware checks still open

Everything in the automated gates is **model-verified** (a simulated DualSense)
or a replay of real telemetry. None of it replaces a run on a physical
controller. These checks are done by hand, over USB, on a spare standard
DualSense (`054C:0CE6`). The copy on the page already treats each open check as
unknown.

## Preconditions (before the Quick algorithm ships)

| Check | Question | What depends on it |
|---|---|---|
| H0 | After `calibBegin` (`[1,1,1]`), do input reports show raw values or the old calibration? | Whether WS1's in-session reference (4 LSB) is enough. The simulator cannot represent it. |
| H0-b | **1.24 start, two passes.** Start with one stick one step off (1.24%). Record the pass-1 and pass-2 results over at least 10 runs. | In the model, pass 2 after a 1.24 first pass recovers less often with the in-session reference filter (see `ops/sim/README.md`). If it also happens on hardware, the filter is re-capturing the same 1-LSB error. |
| H1 | Raw NVS status word after a flash | The final set of statuses that count as "saved" |
| H3 | NVS-unlocked behaviour, if reproducible | Only a future auto-lock |
| H10 | Does a power-off without Write revert the calibration? | The "turn it off to discard it" copy (shown only with memory `locked`) |
| H11 | Does a USB unplug without power-off keep the calibration? | The unplug copy, the range write lock across a replug |
| H12 | Does Range move the center? | Routing pinned sticks to Range, and the Range intro warning |

## Manual checklist (after the preconditions)

- H1 end to end, with the result shown in the panel.
- H2: starts below 1.2 send no command; a start at 1.24 does calibrate.
- H4: a rim hold and a moving hold during pass 2 pause the pass with no sampling; the result is never "success" at 15% or more. The movement meter shows "Stick held: let go" during the hold.
- H5: unplug mid-pass, then replug: nothing reaches the new session. After an unplug in pass 2, the "never written to memory" notice appears and a reload shows the "may still be active" banner.
- H6: exactly one flash.
- H7: the wizard takes no sample while a thumb is on the stick.
- H8: Range with no motion never enables Done; "Finish anyway" disables Write; the intro sends nothing until Start, and Cancel/Esc close it.
- H9: the precision test scores Center 100 on a perfect stick.
- H13: a timeout injected with the DevTools HID throttle poisons the device and shows "The controller stopped responding… may or may not have been applied", with Write disabled.
- H14: if an HID error other than a timeout can be induced inside an open center session (Quick or Guided), the page asks for a power cycle and refuses Quick, Guided, Range and Write until the controller is reconnected; after the power cycle, a new session starts cleanly without committing the partial one.

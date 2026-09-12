# SEO and GitHub growth

Updated: 2026-09-12
Site: https://martino-vigiani.github.io/sense-calibrator/
Repository: https://github.com/martino-vigiani/sense-calibrator

## Goal

Make Sense Calibrator useful and trustworthy enough to earn hundreds of GitHub stars over time.

Keep one clear workflow:

1. Measure the controller.
2. Separate a stable offset from mechanical wear.
3. Calibrate only what software can correct.
4. Repeat the same test.
5. Tune sensitivity.
6. Test movement and aim together.

Keep the scope to the standard DualSense instead of becoming a generic controller tester.

## Starting point

These numbers were captured on 2026-09-12. GitHub Traffic covers the previous 14 days. Stars and forks are lifetime totals.

| Signal | Value |
|---|---:|
| Stars | 4 |
| Forks | 1 |
| Repository views | 372, including 214 unique |
| Clones | 10, including 10 unique |
| Google referrer | 246, including 151 unique |
| Hosted site referrer | 32, including 17 unique |
| Bing referrer | 19, including 15 unique |
| ChatGPT referrer | 19, including 5 unique |

A clone does not prove that the tool worked. A visitor to star rate would also be invalid here because the traffic window and lifetime star total cover different periods.

The homepage is indexed. Search Console appears to be connected through two verification files, but ownership and current performance data still need to be checked in Search Console.

## Search queries to watch

| Query group | What the visitor wants |
|---|---|
| `ps5 stick drift test`, `dualsense drift test online` | Check whether a stick moves at rest |
| `dualsense calibration online`, `ps5 controller calibration browser` | Recalibrate a standard DualSense |
| `can calibration fix dualsense drift`, `calibration vs repair` | Decide between calibration and repair |
| `controller sensitivity finder`, `fps controller sensitivity test` | Find a starting sensitivity |
| `controller polling rate test`, `controller latency test` | Check controller timing |
| `sense calibrator` | Return to the product |

Use “USB report timing” and “browser frame pacing” for Gameplay lab. It does not measure complete input latency.

Wait to target replacement stick or Hall effect queries until that hardware has been tested.

## Repository settings

Description:

> Test and recalibrate a standard PS5 DualSense in the browser, then tune controller sensitivity. WebHID, USB, no install.

Topics:

`dualsense`, `ps5`, `stick-drift`, `controller-calibration`, `controller-testing`, `gamepad`, `webhid`, `javascript`, `fps`

Remove `claude` and `fable-5`. Keep the current homepage URL and Issues enabled.

The project MIT license belongs in `LICENSE`. The original dualshock-tools license belongs in `THIRD_PARTY_NOTICES.md`.

## Publish checklist

1. Test the complete flow with a real DualSense.
2. Publish the site, README, metadata, FAQ and social image together.
3. Set `paper/assets/social-card.png` as the GitHub social preview.
4. Update the repository description and topics.
5. Confirm that GitHub detects the MIT license.
6. Confirm the Search Console property.
7. Submit `https://martino-vigiani.github.io/sense-calibrator/sitemap.xml`.
8. Inspect the homepage in Search Console and request indexing once.

## Search Console

1. Open Google Search Console.
2. Select `https://martino-vigiani.github.io/sense-calibrator/`.
3. Confirm that ownership is active.
4. Submit `https://martino-vigiani.github.io/sense-calibrator/sitemap.xml`.
5. Inspect the canonical homepage after deployment.
6. Request indexing once.
7. Open Performance and compare the last 28 days with the previous period.
8. Export queries, pages, devices and countries.
9. Keep raw exports outside the public repository.

The repository already contains two HTML verification files. Identify the active token before removing or adding one.

## What to record

During launch week, record GitHub numbers every day. After that, update them once a week.

| Week ending | GSC clicks | Impressions | CTR | Repo visitors | Stars gained | Unique clones | Completed before and after tests | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| | | | | | | | | |

Use Search Console for impressions, clicks, queries, pages, devices and countries. Use GitHub Traffic for repository visitors, referrers and clones. Use GitHub API snapshots for stars and forks.

Use the existing product events for completed drift tests and calibrations. People can opt out, so those numbers are a selected sample.

## How to read the numbers

- Impressions rise but CTR does not: improve the title and description.
- Clicks rise but controller connections do not: clarify browser, controller and USB cable requirements.
- Drift tests rise but before and after tests do not: inspect calibration confidence and safety friction.
- Site referrals rise but stars do not: improve the README, release quality and proof.
- Traffic rises without reports, stars or returning searches: count it as reach, not validation.

## How to grow it

Start with one real before and after case. Show the board revision, firmware, method, measurements and one limitation. Never include the controller serial number or another stable identifier.

Then:

1. Publish one short before and after video.
2. Publish one technical post explaining the protocol and safety limits.
3. Ask a small number of controller repair or WebHID creators to test it.
4. Share it in relevant repair communities after reading their rules.
5. Submit to Show HN when the public tool is working and you can answer questions.
6. Add structured GitHub issue templates for controller results and bugs.
7. Publish a tagged release with known limits.

Ask people to test the same workflow and report measurements, not to vote.

The strongest long term feature is a result card that users can save and share. It should stay local by default, exclude serial numbers and link back to the tool and repository.

## Competitors

| Project | What to learn |
|---|---|
| [dualshock-tools](https://dualshock-tools.github.io/) | Broad support and strong community trust. It had 737 stars and 257 forks on 2026-09-12. Keep the warning that calibration cannot repair wear. |
| [ControllerTesting.com](https://controllertesting.com/test/controller/ps-calibration) | Many dedicated tools and pages. Stay narrower and clearer. |
| [GPadTester](https://gpadtester.com/calibration) | Strong repair content. Publish replacement hardware instructions only after testing it. |
| [DualSense Studio](https://dualsense.studio/) | Good playground and presets. Keep hardware calibration and repeatable comparison as the difference. |

## Privacy

Use Search Console, GitHub Traffic, GitHub API snapshots and voluntary GitHub issues before adding another tracker.

Any future product event must avoid serial numbers, device identifiers, full referrers, query strings and fingerprints. It needs a short retention period, a public payload description and a new consent review before implementation.

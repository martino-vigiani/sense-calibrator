# Private telemetry quality report

This directory contains an offline report for the append-only calibration
telemetry collected on the VPS. It does not add an HTTP route and it never
rewrites the source JSONL.

## What the report means

Report version 2 (`schema: sense-calibrator.telemetry-quality.v2`,
`reportVersion: 2`). Each session is reduced to the worst resting offset across
the two sticks:

```text
beforeWorst = max(before.off[0], before.off[1])
afterWorst  = max(after.off[0], after.off[1])
```

Offsets live on the 8-bit lattice described in `js/calib/lattice.js`: one step
is 0.784% per axis, the best possible reading is 0.555% (both axes on byte
127/128), and one axis a single step off reads 1.240%. The report takes its
thresholds from that module, so the page, the stop rule and the report cannot
disagree.

The defaults are explicit in the JSON output and can be overridden by CLI
flags or environment variables:

- public result, the v1 KPI and unchanged: `afterWorst < 1.2%` (both axes at
  the floor);
- within one step, a second metric and not a new KPI: `afterWorst <= 1.25%`;
- improved/worsened: change greater than `0.6` percentage points. The first
  lattice step (0.555 → 1.24) is 0.685, so the old `0.8` counted the most
  common one-step fix, and the most common one-step regression, as unchanged.
  No real change falls between 0.3 and 0.6;
- worse than start: `afterWorst - beforeWorst > 0.8`, the Quick policy's
  regression margin, used by the rollback triggers;
- runaway: `beforeWorst < 15%` and `afterWorst >= 15%`;
- suspicious high deflection: either worst value is at least `15%`;
- rates and the plausible mean/median are shown only for a cohort of at least
  5 sessions; counts are always shown.

Exclusions, each counted in `input`:

- `excludedFirmware`: `fw` in the list, default `1234` (a synthetic test record
  with off-lattice values);
- `excludedBeforeCutoff`: `receivedAt` before `--since`;
- `excludedBeforeGuard`: `receivedAt` before the preflight guard release
  (commit `7c25998`, default `2026-09-16T17:17:00Z`). Data before it is mostly
  developer testing.

With the defaults the population is the plan's canonical post-guard cohort
(PG). Inside it the report computes:

| Block | Meaning |
|---|---|
| `publicThreshold`, `withinOneStep`, `outcomes`, `safety` | the whole population |
| `cohorts.plausible.metrics` | both worst values under 15% (PGP) |
| `cohorts.matched.metrics` | matched monitoring cohort (MC): `beforeWorst > 1.25`, with standard errors for the rollback triggers |
| `cohorts.deduplicated` | first session of each repeat cluster: same board+fw, next start (`t`, else `receivedAt`) within 15 minutes of the previous `receivedAt` |
| `breakdowns.board`, `.firmware`, `.buildYear`, `.boardDeduplicated` | the same metrics per group |
| `lattice` | how many before/after values decode to one axis, two axes, either (ambiguous radius) or no lattice point, and the largest decode error |

Other cohorts come from the flags: `--exclude-before none` gives every session
except `fw 1234` (ALL, and its plausible subset); add `--exclude-firmware none`
for the raw file.

The suspicious label is a conservative data-quality heuristic. It does not
prove that somebody touched a stick. Unknown board strings are grouped as
`other_or_unknown`, and so are firmware versions outside `--known-firmware`, so
an arbitrary submitted value cannot appear in the report. Firmware is shown as
a hex label (`0x110002a`) only for that allowlist. Client timestamps and
individual measurements are never emitted; the lattice block holds counts only.

The v1 payload carries no firmware build date, so `breakdowns.buildYear` is
`unknown` unless a `fw:year` map is supplied with `--build-years` (for example
from the build date the page reads locally from a controller).

## Run locally

Print deterministic machine-readable JSON to stdout:

```sh
node ops/calib-telemetry/quality-report-cli.mjs \
  --input data/telemetry/sessions.jsonl
```

By default the report describes the PG cohort. For every session except the synthetic record
(the ALL cohort) disable the guard exclusion:

```sh
node ops/calib-telemetry/quality-report-cli.mjs \
  --input data/telemetry/sessions.jsonl \
  --exclude-before none
```

Apply an inclusive ingestion cutoff and print a one-line human summary:

```sh
node ops/calib-telemetry/quality-report-cli.mjs \
  --input data/telemetry/sessions.jsonl \
  --since 2026-09-16T00:00:00Z \
  --summary
```

Persisting with `--output` writes a mode-`0600` temporary file in the target
directory, flushes it, and renames it over the previous report. A failed write
or rename leaves the previous report intact and removes the temporary file.
The command refuses to use the input path as the output path.

## Typed v2 events report

`events-report-cli.mjs` reads the separate `events-v2.jsonl` file and writes
aggregates for saving, resting noise, and signed axis residuals:

```sh
node ops/calib-telemetry/events-report-cli.mjs \
  --input data/telemetry/events-v2.jsonl
```

`residualAxes.final.byBoard` counts the observed `afterAxes` values from Quick
and Guided events for each of `lx`, `ly`, `rx`, and `ry`. Distribution entries
are exact signed **half-LSB units**: `-1` means half a byte step below center,
`2` means one byte step above center. Zero and both signs remain separate.
`events` includes all Quick and Guided events in the board group;
`withMeasurement` counts those with at least one final axis value. Each axis's
`n` is its own measured denominator. Groups below `--minimum-cohort` show
their event and measurement counts without distributions.

`residualAxes.quickPassRepeats` compares **adjacent verified** Quick passes.
An axis is eligible only when both values are measured and nonzero; a repeat
means the same axis has the exact same signed value on both passes. Its
`byAxis` rates use `bothNonzeroPairs` as denominator. The `runs` rate counts
Quick runs with at least one such repeat among runs with at least one eligible
pair; `adjacentPairs` counts pass pairs, so a longer Quick run can contribute
more than once. A null or unverified pass breaks adjacency. The report also
groups these counts by board. Repeated zeros do not count as residuals, and
equal radial percentages with different axes or signs do not count as repeats.

Historical v2 Quick and Guided records that lack **all** the new axis fields
are filled with null measurements inside this report, then checked against the
strict current schema. `input.legacyAxes` counts those accepted records;
partial or malformed new records remain invalid. The current v1
`sessions.jsonl` has no axis values and cannot supply these distributions or
repeat rates.

## VPS deployment

The report is deployed privately, outside every nginx document root:

```text
/home/martino/sense-calibrator-ops/quality-report.mjs
/home/martino/sense-calibrator-ops/quality-report-cli.mjs
/home/martino/sense-calibrator-ops/lattice.mjs
/var/lib/calib-telemetry/sessions.jsonl
/var/lib/calib-telemetry/private/quality-latest.json
/var/lib/calib-telemetry/private/quality-history.log
```

Version 2 imports the lattice table. In the repository it loads
`js/calib/lattice.js`; on the VPS there is no `js/` tree, so copy
`js/calib/lattice.js` next to the two scripts as `lattice.mjs` (the `.mjs`
extension makes Node load it as an ES module without a `package.json`).
Without it the report exits with `lattice not found`. The v2 defaults also exclude sessions received
before the guard release, so the daily figures describe the PG cohort; pass
`--exclude-before none` to keep the old v1 population.

The scripts deliberately live outside `/home/martino/calib-telemetry/` because
the collector deploy replaces that directory with `rsync --delete`.

The VPS currently uses PM2 for the long-running `calib-telemetry` collector and
the `martino` user crontab for short periodic jobs. This report is a finite batch
job, so the existing user-cron convention is the smaller operational surface;
it does not need a second PM2 process or a public endpoint.

The active daily entry runs at 04:10 UTC:

```cron
10 4 * * * umask 077 && /usr/bin/node /home/martino/sense-calibrator-ops/quality-report-cli.mjs --input /var/lib/calib-telemetry/sessions.jsonl --output /var/lib/calib-telemetry/private/quality-latest.json --since 2026-09-16T11:20:32Z --summary >> /var/lib/calib-telemetry/private/quality-history.log 2>&1
```

The first report was generated and checked on 2026-09-16. Both report files
use mode `0600`; the source JSONL remained byte-for-byte unchanged. The
collector stays under PM2 and was not restarted or modified for this job.

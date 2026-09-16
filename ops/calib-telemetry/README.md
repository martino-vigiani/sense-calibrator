# Private telemetry quality report

This directory contains an offline report for the append-only calibration
telemetry collected on the VPS. It does not add an HTTP route and it never
rewrites the source JSONL.

## What the report means

Each session is reduced to the worst resting offset across the two sticks:

```text
beforeWorst = max(before.off[0], before.off[1])
afterWorst  = max(after.off[0], after.off[1])
```

The defaults are explicit in the JSON output and can be overridden by CLI
flags or environment variables:

- public result: `afterWorst < 1.2%` (strict, matching the product verdict);
- improved/worsened: change greater than `0.8` percentage points;
- suspicious high deflection: either worst value is at least `15%`;
- plausible mean/median: shown only for a cohort of at least 5 sessions.

The suspicious label is a conservative data-quality heuristic. It does not
prove that somebody touched a stick. Unknown board strings are grouped as
`other_or_unknown`, so an arbitrary submitted string cannot appear in the
report. Firmware, client timestamps and individual measurements are never
emitted.

## Run locally

Print deterministic machine-readable JSON to stdout:

```sh
node ops/calib-telemetry/quality-report-cli.mjs \
  --input data/telemetry/sessions.jsonl
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

## VPS deployment

The report is deployed privately, outside every nginx document root:

```text
/home/martino/sense-calibrator-ops/quality-report.mjs
/home/martino/sense-calibrator-ops/quality-report-cli.mjs
/var/lib/calib-telemetry/sessions.jsonl
/var/lib/calib-telemetry/private/quality-latest.json
/var/lib/calib-telemetry/private/quality-history.log
```

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

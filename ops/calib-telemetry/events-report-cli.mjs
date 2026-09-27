#!/usr/bin/env node
// Report degli eventi v2, da riga di comando. Locale: legge la copia scaricata
// con scripts/pull-telemetry.sh (data/telemetry/events-v2.jsonl, gitignored).
import process from 'node:process';
import { assertDistinctInputOutput, writeReportAtomic } from './quality-report.mjs';
import { DEFAULT_EVENTS_CONFIG, createEventsReportFromFile, formatEventsSummary } from './events-report.mjs';

const DEFAULT_INPUT = 'data/telemetry/events-v2.jsonl';

function usage() {
  return `Usage: node ops/calib-telemetry/events-report-cli.mjs [options]

Aggregate report of the v2 telemetry events: save rate by calibration outcome
and resting stick noise distributions. The input JSONL is never changed.

Options:
  --input PATH            events JSONL (default: ${DEFAULT_INPUT})
  --output PATH           atomically write the JSON report (mode 0600) instead of printing it
  --since YYYY-MM-DD      only events received on or after this day
  --minimum-cohort COUNT  smallest group that gets a rate or a distribution (default: ${DEFAULT_EVENTS_CONFIG.minimumCohortSize})
  --summary               print a one-line summary
  --help                  show this help
`;
}

export function parseArgs(argv) {
  const options = { inputPath: DEFAULT_INPUT };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === '--input') options.inputPath = value();
    else if (flag === '--output') options.outputPath = value();
    else if (flag === '--since') {
      options.since = value();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(options.since)) throw new Error('--since must be YYYY-MM-DD');
    } else if (flag === '--minimum-cohort') {
      options.minimumCohortSize = Number(value());
      if (!Number.isInteger(options.minimumCohortSize) || options.minimumCohortSize < 1) throw new Error('--minimum-cohort must be a positive integer');
    } else if (flag === '--summary') options.summary = true;
    else if (flag === '--help') options.help = true;
    else throw new Error(`Unknown option ${flag}`);
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  const { summary, help, outputPath, ...options } = parseArgs(argv);
  if (help) { process.stdout.write(usage()); return; }
  if (outputPath) await assertDistinctInputOutput(options.inputPath, outputPath);
  const report = await createEventsReportFromFile(options);
  if (outputPath) await writeReportAtomic(outputPath, report);
  if (summary) process.stdout.write(`${formatEventsSummary(report)}\n`);
  else if (!outputPath) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch(error => {
    process.stderr.write(`events-report: ${error.message}\n`);
    process.exitCode = 1;
  });
}

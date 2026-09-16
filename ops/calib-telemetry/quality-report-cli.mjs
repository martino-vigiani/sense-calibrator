#!/usr/bin/env node

import process from 'node:process';

import {
  DEFAULT_REPORT_CONFIG,
  createQualityReportFromFile,
  formatQualitySummary,
} from './quality-report.mjs';

const DEFAULT_INPUT = '/var/lib/calib-telemetry/sessions.jsonl';

function usage() {
  return `Usage: node quality-report-cli.mjs [options]

Build a private aggregate report from append-only calibration telemetry.
The input JSONL is never changed. No HTTP endpoint is created.

Options:
  --input PATH                 JSONL input (default: ${DEFAULT_INPUT})
  --output PATH                Atomically persist JSON instead of printing it
  --since RFC3339              Include receivedAt >= this cutoff
  --public-threshold PCT       Success threshold (strictly below; default: ${DEFAULT_REPORT_CONFIG.publicThresholdPct})
  --high-deflection PCT        Suspicious cohort threshold (default: ${DEFAULT_REPORT_CONFIG.highDeflectionPct})
  --change-epsilon PCT         Minimum outcome change (default: ${DEFAULT_REPORT_CONFIG.changeEpsilonPct})
  --minimum-cohort COUNT       Minimum plausible cohort for mean/median (default: ${DEFAULT_REPORT_CONFIG.minimumCohortSize})
  --known-boards CSV           Board labels safe to expose; all others are grouped
  --summary                    Print a concise aggregate summary
  --help                       Show this help

Environment equivalents:
  CALIB_REPORT_INPUT, CALIB_REPORT_OUTPUT, CALIB_REPORT_SINCE,
  CALIB_REPORT_PUBLIC_THRESHOLD_PCT, CALIB_REPORT_HIGH_DEFLECTION_PCT,
  CALIB_REPORT_CHANGE_EPSILON_PCT, CALIB_REPORT_MINIMUM_COHORT_SIZE,
  CALIB_REPORT_KNOWN_BOARDS
`;
}

function readValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function numeric(value, name) {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`${name} must be a number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
  return number;
}

function integer(value, name) {
  const number = numeric(value, name);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`);
  return number;
}

function csv(value, name) {
  if (value === undefined) return undefined;
  const values = value.split(',').map(item => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return values;
}

export function parseCliArgs(argv, env = process.env) {
  const parsed = {
    inputPath: env.CALIB_REPORT_INPUT || DEFAULT_INPUT,
    outputPath: env.CALIB_REPORT_OUTPUT || undefined,
    sinceInclusive: env.CALIB_REPORT_SINCE || undefined,
    publicThresholdPct: numeric(
      env.CALIB_REPORT_PUBLIC_THRESHOLD_PCT,
      'CALIB_REPORT_PUBLIC_THRESHOLD_PCT',
    ),
    highDeflectionPct: numeric(
      env.CALIB_REPORT_HIGH_DEFLECTION_PCT,
      'CALIB_REPORT_HIGH_DEFLECTION_PCT',
    ),
    changeEpsilonPct: numeric(
      env.CALIB_REPORT_CHANGE_EPSILON_PCT,
      'CALIB_REPORT_CHANGE_EPSILON_PCT',
    ),
    minimumCohortSize: integer(
      env.CALIB_REPORT_MINIMUM_COHORT_SIZE,
      'CALIB_REPORT_MINIMUM_COHORT_SIZE',
    ),
    knownBoards: csv(env.CALIB_REPORT_KNOWN_BOARDS, 'CALIB_REPORT_KNOWN_BOARDS'),
    summary: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--input':
        parsed.inputPath = readValue(argv, index, flag);
        index += 1;
        break;
      case '--output':
        parsed.outputPath = readValue(argv, index, flag);
        index += 1;
        break;
      case '--since':
        parsed.sinceInclusive = readValue(argv, index, flag);
        index += 1;
        break;
      case '--public-threshold':
        parsed.publicThresholdPct = numeric(readValue(argv, index, flag), flag);
        index += 1;
        break;
      case '--high-deflection':
        parsed.highDeflectionPct = numeric(readValue(argv, index, flag), flag);
        index += 1;
        break;
      case '--change-epsilon':
        parsed.changeEpsilonPct = numeric(readValue(argv, index, flag), flag);
        index += 1;
        break;
      case '--minimum-cohort':
        parsed.minimumCohortSize = integer(readValue(argv, index, flag), flag);
        index += 1;
        break;
      case '--known-boards':
        parsed.knownBoards = csv(readValue(argv, index, flag), flag);
        index += 1;
        break;
      case '--summary':
        parsed.summary = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return parsed;
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseCliArgs(argv, env);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const report = await createQualityReportFromFile(options);
  if (options.summary) {
    process.stdout.write(`${formatQualitySummary(report)}\n`);
  } else if (options.outputPath === undefined) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch(error => {
    process.stderr.write(`quality-report: ${error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// Il cron carica un'intera release e verifica il report prima della rinomina.
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseCliArgs } from './quality-report-cli.mjs';
import { assertDistinctInputOutput, buildQualityReport, formatQualitySummary, writeReportAtomic } from './quality-report.mjs';
import { checkQualityReport } from './quality-report-check.mjs';

export async function runVerifiedReport(argv = process.argv.slice(2), { emit = true } = {}) {
  // Nessuna variabile CALIB_REPORT_* cambia silenziosamente i default del cron.
  const options = parseCliArgs(argv, {});
  if (!options.outputPath || options.help) throw new Error('verified runner requires --output');
  await assertDistinctInputOutput(options.inputPath, options.outputPath);
  const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
  const input = await readFile(options.inputPath, 'utf8');
  const report = buildQualityReport(input, options);
  const verified = checkQualityReport(report, input, {
    since: manifest.since, definitions: manifest.definitions, exclusions: manifest.exclusions,
  });
  await writeReportAtomic(options.outputPath, report);
  const saved = JSON.parse(await readFile(options.outputPath, 'utf8'));
  checkQualityReport(saved, input, { since: manifest.since, definitions: manifest.definitions, exclusions: manifest.exclusions });
  const summary = `[schema=${verified.schema}; reportVersion=${verified.reportVersion}; release=${manifest.release}; inputSha256=${verified.inputSha256}] ${formatQualitySummary(saved)}`;
  if (emit && options.summary) process.stdout.write(`${summary}\n`);
  return { ...verified, summary };
}

// Node risolve normalmente i symlink; il controllo vale anche con argv symlink.
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  runVerifiedReport().catch(error => {
    process.stderr.write(`quality-report-runner: ${error.message}\n`);
    process.exitCode = 1;
  });
}

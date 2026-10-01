// Controlli operativi: lo schema del report non è il contratto degli eventi v2.
import { createHash } from 'node:crypto';

export const QUALITY_REPORT_SCHEMA = 'sense-calibrator.telemetry-quality.v2';
export const QUALITY_REPORT_VERSION = 2;

export function checkQualityReport(report, input, { since, definitions, exclusions } = {}) {
  const fail = message => { throw new Error(`quality report verification: ${message}`); };
  if (report?.schema !== QUALITY_REPORT_SCHEMA || report.reportVersion !== QUALITY_REPORT_VERSION) {
    fail(`expected ${QUALITY_REPORT_SCHEMA}, reportVersion ${QUALITY_REPORT_VERSION}`);
  }
  const text = String(input);
  const rows = text.split('\n').filter(line => line.trim()).length;
  if (report.input?.bytes !== Buffer.byteLength(text) || report.input.nonEmptyLines !== rows) {
    fail('input bytes/rows do not match the snapshot');
  }
  if (report.input.unterminatedFinalLine !== (text.length > 0 && !text.endsWith('\n'))) {
    fail('input final-line state does not match the snapshot');
  }
  for (const field of ['malformedJsonLines', 'invalidRecordLines', 'excludedBeforeCutoff', 'excludedFirmware', 'excludedBeforeGuard']) {
    if (!Number.isSafeInteger(report.input[field]) || report.input[field] < 0) fail(`invalid input.${field}`);
  }
  const { total, validMeasurements, invalidMeasurements } = report.sessions ?? {};
  if (![total, validMeasurements, invalidMeasurements].every(n => Number.isSafeInteger(n) && n >= 0)
      || validMeasurements + invalidMeasurements !== total) fail('session counts do not reconcile');
  const excluded = ['malformedJsonLines', 'invalidRecordLines', 'excludedBeforeCutoff', 'excludedFirmware', 'excludedBeforeGuard']
    .reduce((sum, field) => sum + report.input[field], 0);
  if (total + excluded !== rows) fail('input counts do not reconcile');
  if (report.outcomes?.denominator !== validMeasurements
      || report.outcomes.improved + report.outcomes.worsened + report.outcomes.unchanged !== validMeasurements
      || report.publicThreshold?.denominator !== validMeasurements
      || report.withinOneStep?.denominator !== validMeasurements) fail('metric denominators do not reconcile');
  if (since !== undefined && report.window?.sinceInclusive !== new Date(since).toISOString()) fail('ingestion cutoff differs');
  for (const [field, expected] of Object.entries(definitions ?? {})) {
    if (JSON.stringify(report.definitions?.[field]) !== JSON.stringify(expected)) fail(`definition ${field} differs`);
  }
  if (exclusions !== undefined && JSON.stringify(report.exclusions) !== JSON.stringify(exclusions)) fail('exclusions differ');
  return {
    schema: report.schema, reportVersion: report.reportVersion,
    inputSha256: createHash('sha256').update(text).digest('hex'),
    inputBytes: report.input.bytes, inputRows: rows,
    sessions: total, validMeasurements,
  };
}

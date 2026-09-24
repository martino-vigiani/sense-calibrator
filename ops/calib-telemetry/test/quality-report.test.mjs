import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';

import {
  DEFAULT_REPORT_CONFIG,
  buildQualityReport,
  createQualityReportFromFile,
  formatQualitySummary,
} from '../quality-report.mjs';
import { parseCliArgs } from '../quality-report-cli.mjs';
import { CENTERED_MAX, GUIDED_ONLY_MIN, WITHIN_ONE_STEP_MAX } from '../../../js/calib/lattice.js';
import { QUICK_DEFAULTS } from '../../../js/calib/quick.js';

const FIXED_NOW = '2026-09-16T18:00:00.000Z';

function slot(off, noise = [0.2, 0.3]) {
  return { off, noise };
}

function record({
  receivedAt = '2026-09-18T12:00:00.000Z',
  board = 'BDM-030',
  before = [4, 2],
  after = [1, 0.5],
  ...extra
} = {}) {
  return {
    receivedAt,
    board,
    before: slot(before),
    after: slot(after),
    ...extra,
  };
}

function jsonl(rows, trailingNewline = true) {
  const body = rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n');
  return trailingNewline ? `${body}\n` : body;
}

function reportFor(rows, options = {}) {
  return buildQualityReport(jsonl(rows), {
    clock: () => FIXED_NOW,
    ...options,
  });
}

async function tempDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'calib-quality-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('cutoff is inclusive and board/null counts use privacy-safe buckets', () => {
  const cutoff = '2026-09-18T12:00:00.000Z';
  const report = reportFor([
    record({ receivedAt: '2026-09-18T11:59:59.999Z', board: 'BDM-020' }),
    record({ receivedAt: cutoff, board: 'BDM-030' }),
    record({ receivedAt: '2026-09-18T12:00:00.001Z', board: null }),
  ], { sinceInclusive: cutoff });

  assert.equal(report.sessions.total, 2);
  assert.equal(report.input.excludedBeforeCutoff, 1);
  assert.deepEqual(report.boards.sessions, {
    'BDM-030': 1,
    other_or_unknown: 1,
  });
  assert.equal(report.window.sinceInclusive, cutoff);
});

test('outcomes use the worst stick and exact +/- epsilon remains unchanged', () => {
  const report = reportFor([
    record({ before: [1, 5], after: [4.19, 1] }), // improvement 0.81
    record({ before: [1, 5], after: [4.2, 1] }),  // improvement 0.8
    record({ before: [1, 5], after: [5.8, 1] }),  // worsening 0.8
    record({ before: [1, 5], after: [5.81, 1] }), // worsening 0.81
  ], { changeEpsilonPct: 0.8, highDeflectionPct: 100 });

  assert.deepEqual(report.outcomes, {
    denominator: 4,
    improved: 1,
    worsened: 1,
    unchanged: 2,
  });
});

test('public success is strict: exactly 1.2 percent does not pass', () => {
  const report = reportFor([
    record({ after: [1.19, 0.4] }),
    record({ after: [1.2, 0.4] }),
  ]);

  assert.deepEqual(report.publicThreshold, {
    denominator: 2,
    passingAfter: 1,
    failingAfter: 1,
    passingRate: 0.5,
  });
});

test('plausible cohort reports correct odd and even medians and means', () => {
  const odd = reportFor([
    record({ before: [1, 0], after: [2, 0] }),
    record({ before: [3, 0], after: [4, 0] }),
    record({ before: [5, 0], after: [6, 0] }),
  ], { minimumCohortSize: 1, highDeflectionPct: 100 });
  assert.deepEqual(odd.cohorts.plausible.statistics, {
    worstOffsetPct: {
      before: { mean: 3, median: 3 },
      after: { mean: 4, median: 4 },
    },
  });

  const even = reportFor([
    record({ before: [9, 0], after: [8, 0] }),
    record({ before: [1, 0], after: [2, 0] }),
    record({ before: [5, 0], after: [6, 0] }),
    record({ before: [3, 0], after: [4, 0] }),
  ], { minimumCohortSize: 1, highDeflectionPct: 100 });
  assert.deepEqual(even.cohorts.plausible.statistics, {
    worstOffsetPct: {
      before: { mean: 4.5, median: 4 },
      after: { mean: 5, median: 5 },
    },
  });
});

test('empty input returns zero counts and null rates/statistics without NaN', () => {
  const report = buildQualityReport('', { clock: () => FIXED_NOW });

  assert.equal(report.sessions.total, 0);
  assert.equal(report.sessions.validMeasurements, 0);
  assert.equal(report.publicThreshold.passingRate, null);
  assert.equal(report.cohorts.suspiciousHighDeflection.rate, null);
  assert.equal(report.cohorts.plausible.statistics, null);
  assert.doesNotMatch(JSON.stringify(report), /NaN|Infinity/);
});

test('mixed JSONL preserves valid rows and counts malformed, truncated and invalid measurements', () => {
  const content = jsonl([
    record(),
    '{"broken":',
    JSON.stringify(record({ before: [1e400, 0] })),
    '42',
    '{"receivedAt":',
  ], false);
  const report = buildQualityReport(content, { clock: () => FIXED_NOW });

  assert.equal(report.input.nonEmptyLines, 5);
  assert.equal(report.input.malformedJsonLines, 2);
  assert.equal(report.input.invalidRecordLines, 1);
  assert.equal(report.input.unterminatedFinalLine, true);
  assert.equal(report.sessions.total, 2);
  assert.equal(report.sessions.validMeasurements, 1);
  assert.equal(report.sessions.invalidMeasurements, 1);
  assert.equal(report.outcomes.denominator, 1);
});

test('report contains no individual identifiers, raw timestamps, tuples or suspicious details', () => {
  const rows = [
    record({
      receivedAt: '2031-02-03T04:05:06.789Z',
      board: 'SERIAL-SENTINEL',
      before: [77.777, 0.123],
      after: [66.666, 0.456],
      sid: 'SID-SENTINEL',
      serial: 'SERIAL-SENTINEL',
      ip: 'IP-SENTINEL',
      t: '2099-01-02T03:04:05.678Z',
    }),
    ...[1, 2, 3, 4, 5].map(value => record({
      receivedAt: `2026-09-18T12:00:0${value}.000Z`,
      before: [value, 0],
      after: [value / 2, 0],
    })),
  ];
  const report = reportFor(rows);
  const rendered = JSON.stringify(report);

  for (const sentinel of [
    'SID-SENTINEL',
    'SERIAL-SENTINEL',
    'IP-SENTINEL',
    '2031-02-03T04:05:06.789Z',
    '2099-01-02T03:04:05.678Z',
    '77.777',
    '66.666',
  ]) {
    assert.equal(rendered.includes(sentinel), false, sentinel);
  }
  assert.equal(report.boards.sessions.other_or_unknown, 1);
  assert.deepEqual(report.cohorts.suspiciousHighDeflection, {
    denominator: 6,
    sessions: 1,
    rate: 0.166667,
  });
  assert.equal(Object.hasOwn(report.cohorts.suspiciousHighDeflection, 'records'), false);
  assert.equal(Object.hasOwn(report.cohorts.suspiciousHighDeflection, 'lines'), false);
});

test('plausible statistics stay suppressed below the explicit minimum cohort', () => {
  const report = reportFor([
    record({ before: [1, 0], after: [0.5, 0] }),
    record({ before: [2, 0], after: [1, 0] }),
    record({ before: [3, 0], after: [1.5, 0] }),
    record({ before: [4, 0], after: [2, 0] }),
  ], { minimumCohortSize: 5 });

  assert.equal(report.cohorts.plausible.sessions, 4);
  assert.equal(report.cohorts.plausible.statisticsSuppressed, true);
  assert.equal(report.cohorts.plausible.statistics, null);
});

test('atomic success preserves input and installs a complete mode-0600 report', async t => {
  const directory = await tempDirectory(t);
  const inputPath = path.join(directory, 'sessions.jsonl');
  const outputPath = path.join(directory, 'private', 'quality-latest.json');
  const source = jsonl([record()]);
  await writeFile(inputPath, source, 'utf8');

  const report = await createQualityReportFromFile({
    inputPath,
    outputPath,
    clock: () => FIXED_NOW,
  });

  assert.equal(await readFile(inputPath, 'utf8'), source);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), report);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(path.dirname(outputPath))).filter(name => name.endsWith('.tmp')),
    [],
  );
});

test('input path cannot be used directly or through a hard link as output', async t => {
  const directory = await tempDirectory(t);
  const inputPath = path.join(directory, 'sessions.jsonl');
  const linkedPath = path.join(directory, 'same-data.jsonl');
  const source = jsonl([record()]);
  await writeFile(inputPath, source, 'utf8');
  await link(inputPath, linkedPath);

  await assert.rejects(
    createQualityReportFromFile({ inputPath, outputPath: inputPath, clock: () => FIXED_NOW }),
    /must not be the inputPath/,
  );
  await assert.rejects(
    createQualityReportFromFile({ inputPath, outputPath: linkedPath, clock: () => FIXED_NOW }),
    /must not resolve to the input file/,
  );
  assert.equal(await readFile(inputPath, 'utf8'), source);
});

test('invalid cutoff fails before any output write', async t => {
  const directory = await tempDirectory(t);
  const inputPath = path.join(directory, 'sessions.jsonl');
  const outputPath = path.join(directory, 'quality.json');
  await writeFile(inputPath, jsonl([record()]), 'utf8');
  await writeFile(outputPath, 'old-report\n', 'utf8');

  await assert.rejects(
    createQualityReportFromFile({
      inputPath,
      outputPath,
      sinceInclusive: 'not-a-cutoff',
      clock: () => FIXED_NOW,
    }),
    /sinceInclusive/,
  );
  assert.equal(await readFile(outputPath, 'utf8'), 'old-report\n');
});

test('rename failure preserves old output and removes the temporary file', async t => {
  const directory = await tempDirectory(t);
  const inputPath = path.join(directory, 'sessions.jsonl');
  const outputPath = path.join(directory, 'quality.json');
  await writeFile(inputPath, jsonl([record()]), 'utf8');
  await writeFile(outputPath, 'old-report\n', 'utf8');

  await assert.rejects(
    createQualityReportFromFile({
      inputPath,
      outputPath,
      clock: () => FIXED_NOW,
      fileOps: {
        rename: async () => {
          const error = new Error('injected rename failure');
          error.code = 'EIO';
          throw error;
        },
      },
    }),
    /injected rename failure/,
  );
  assert.equal(await readFile(outputPath, 'utf8'), 'old-report\n');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('write failure preserves old output and removes a partial temporary file', async t => {
  const directory = await tempDirectory(t);
  const inputPath = path.join(directory, 'sessions.jsonl');
  const outputPath = path.join(directory, 'quality.json');
  await writeFile(inputPath, jsonl([record()]), 'utf8');
  await writeFile(outputPath, 'old-report\n', 'utf8');

  await assert.rejects(
    createQualityReportFromFile({
      inputPath,
      outputPath,
      clock: () => FIXED_NOW,
      fileOps: {
        writeFile: async (targetPath) => {
          await writeFile(targetPath, 'partial', 'utf8');
          throw new Error('injected write failure');
        },
      },
    }),
    /injected write failure/,
  );
  assert.equal(await readFile(outputPath, 'utf8'), 'old-report\n');
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('fixed clock produces deterministic JSON with stable board order', () => {
  const content = jsonl([
    record({ board: null }),
    record({ board: 'BDM-040' }),
    record({ board: 'BDM-020' }),
  ]);
  const first = buildQualityReport(content, { clock: () => FIXED_NOW });
  const second = buildQualityReport(content, { clock: () => FIXED_NOW });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first.boards.sessions), [
    'BDM-020',
    'BDM-040',
    'other_or_unknown',
  ]);
  assert.equal(first.generatedAt, FIXED_NOW);
  assert.match(formatQualitySummary(first), /^2026-09-16T18:00:00.000Z; 3 sessioni;/);
});

// ---- Report v2 -------------------------------------------------------------

// Valori reali del reticolo (vedi js/calib/lattice.js).
const FLOOR = 0.555;
const STEP1 = 1.24;
const STEP11 = 1.664;

test('v2 thresholds come from the lattice module and the Quick policy', () => {
  assert.equal(DEFAULT_REPORT_CONFIG.publicThresholdPct, CENTERED_MAX);
  assert.equal(DEFAULT_REPORT_CONFIG.withinOneStepPct, WITHIN_ONE_STEP_MAX);
  assert.equal(DEFAULT_REPORT_CONFIG.highDeflectionPct, GUIDED_ONLY_MIN);
  assert.equal(DEFAULT_REPORT_CONFIG.worseThanStartEpsPct, QUICK_DEFAULTS.regressionEps);
  assert.equal(DEFAULT_REPORT_CONFIG.changeEpsilonPct, 0.6);

  const report = reportFor([record()]);
  assert.equal(report.schema, 'sense-calibrator.telemetry-quality.v2');
  assert.equal(report.reportVersion, 2);
  assert.equal(report.definitions.changeEpsilonPct, 0.6);
  assert.equal(report.definitions.withinOneStepPct, 1.25);
  assert.equal(report.definitions.latticeFloorPct, 0.554594);
});

test('the v1 KPI keeps its rule while within-one-step is a separate metric', () => {
  const report = reportFor([
    record({ before: [4, 2], after: [FLOOR, FLOOR] }),
    record({ before: [4, 2], after: [STEP1, FLOOR] }),
    record({ before: [4, 2], after: [STEP11, FLOOR] }),
    record({ before: [4, 2], after: [1.2, FLOOR] }),
  ]);
  assert.deepEqual(report.publicThreshold, { denominator: 4, passingAfter: 1, failingAfter: 3, passingRate: 0.25 });
  assert.deepEqual(report.withinOneStep, { denominator: 4, withinAfter: 3, withinOneStepRate: 0.75 });
});

test('epsilon 0.6 counts the first lattice step as a change; 0.8 hid it', () => {
  const rows = [
    record({ before: [STEP1, FLOOR], after: [FLOOR, FLOOR] }),
    record({ before: [FLOOR, FLOOR], after: [STEP1, FLOOR] }),
    record({ before: [STEP1, FLOOR], after: [STEP1, FLOOR] }),
  ];
  const v2 = reportFor(rows);
  assert.deepEqual(v2.outcomes, { denominator: 3, improved: 1, worsened: 1, unchanged: 1 });
  const legacy = reportFor(rows, { changeEpsilonPct: 0.8 });
  assert.deepEqual(legacy.outcomes, { denominator: 3, improved: 0, worsened: 0, unchanged: 3 });
});

test('default exclusions drop fw 1234 and pre-guard sessions, and count each once', () => {
  const rows = [
    record({ fw: 1234, receivedAt: '2026-07-03T16:50:22.721Z' }),
    record({ fw: 17825834, receivedAt: '2026-09-16T17:16:59.999Z' }),
    record({ fw: 17825834, receivedAt: '2026-09-16T17:17:00.000Z' }),
    record({ fw: 17825834 }),
  ];
  const report = reportFor(rows);
  assert.equal(report.sessions.total, 2);
  assert.equal(report.input.excludedFirmware, 1, 'firmware wins over the time window');
  assert.equal(report.input.excludedBeforeGuard, 1);
  assert.deepEqual(report.exclusions, { firmware: [1234], receivedBefore: '2026-09-16T17:17:00.000Z' });

  const none = reportFor(rows, { excludeFirmware: null, excludeReceivedBefore: null });
  assert.equal(none.sessions.total, 4);
  assert.deepEqual(none.exclusions, { firmware: [], receivedBefore: null });
  assert.equal(none.input.excludedFirmware, 0);
  assert.equal(none.input.excludedBeforeGuard, 0);

  const since = reportFor(rows, { sinceInclusive: '2026-09-18T00:00:00Z' });
  assert.equal(since.input.excludedBeforeCutoff, 2);
  assert.equal(since.input.excludedBeforeGuard, 0, 'the --since window is applied first');
});

test('the plausible cohort carries its own KPI, within-one-step and outcomes', () => {
  const report = reportFor([
    record({ before: [4, 2], after: [FLOOR, FLOOR] }),
    record({ before: [4, 2], after: [STEP1, FLOOR] }),
    record({ before: [4, 2], after: [30, FLOOR] }),
  ], { minimumCohortSize: 1 });
  const m = report.cohorts.plausible.metrics;
  assert.equal(m.sessions, 2);
  assert.equal(m.passingAfter, 1);
  assert.equal(m.withinOneStep, 2);
  assert.equal(m.improved, 2);
  assert.equal(m.runaways, 0);
  assert.equal(report.safety.runaways, 1);
});

test('matched cohort: starts beyond one step, with worse-than-start at 0.8 and runaways', () => {
  const report = reportFor([
    record({ before: [FLOOR, FLOOR], after: [STEP1, FLOOR] }),   // già centrato: fuori
    record({ before: [STEP1, FLOOR], after: [FLOOR, FLOOR] }),   // 1 passo: fuori
    record({ before: [STEP11, FLOOR], after: [FLOOR, FLOOR] }),  // dentro, passa
    record({ before: [2, FLOOR], after: [3.551, FLOOR] }),       // dentro, peggiore di 1.55
    record({ before: [8.245, 2], after: [40.394, 2] }),          // dentro, runaway
    record({ before: [2, FLOOR], after: [2.287, FLOOR] }),       // dentro, +0.29: non peggiore
  ], { minimumCohortSize: 1 });
  const m = report.cohorts.matched.metrics;
  assert.equal(m.sessions, 4);
  assert.equal(m.passingAfter, 1);
  assert.equal(m.passingRate, 0.25);
  assert.equal(m.worseThanStart, 2);
  assert.equal(m.worseThanStartRate, 0.5);
  assert.equal(m.runaways, 1);
  assert.equal(m.passingRateStandardError, Number(Math.sqrt(0.25 * 0.75 / 4).toFixed(6)));
  // Da 0.555 a 1.24 sono +0.685: un passo, sotto il margine di peggioramento.
  assert.equal(report.safety.worseThanStart, 2);
});

test('de-duplication keeps the first session of each board+fw repeat cluster', () => {
  const at = minutes => new Date(Date.parse('2026-09-18T12:00:00.000Z') + minutes * 60_000).toISOString();
  const report = reportFor([
    // Cluster A: tre sessioni ravvicinate sullo stesso board+fw.
    record({ board: 'BDM-020', fw: 17825834, t: at(0), receivedAt: at(0.2), after: [STEP1, FLOOR] }),
    record({ board: 'BDM-020', fw: 17825834, t: at(10), receivedAt: at(10.2), after: [FLOOR, FLOOR] }),
    record({ board: 'BDM-020', fw: 17825834, t: at(24), receivedAt: at(24.2), after: [FLOOR, FLOOR] }),
    // Oltre 15 minuti dalla ricezione precedente: nuovo cluster.
    record({ board: 'BDM-020', fw: 17825834, t: at(40), receivedAt: at(40.2), after: [FLOOR, FLOOR] }),
    // Stesso istante, board diversa: cluster separato.
    record({ board: 'BDM-030', fw: 17825834, t: at(1), receivedAt: at(1.2), after: [FLOOR, FLOOR] }),
    // Senza `t` valido si usa receivedAt.
    record({ board: 'BDM-030', fw: 17825834, t: 'garbage', receivedAt: at(5), after: [STEP1, FLOOR] }),
  ], { minimumCohortSize: 1 });
  const d = report.cohorts.deduplicated;
  assert.equal(d.clusters, 3);
  assert.equal(d.repeatSessions, 3);
  assert.equal(d.metrics.sessions, 3);
  assert.equal(d.metrics.passingAfter, 2, 'the first of cluster A ended at one step');
  assert.deepEqual(Object.keys(report.breakdowns.boardDeduplicated), ['BDM-020', 'BDM-030']);
  assert.equal(report.breakdowns.boardDeduplicated['BDM-020'].sessions, 2);
});

test('breakdowns by board, firmware and build year stay privacy-safe and suppress small rates', () => {
  const report = reportFor([
    ...Array.from({ length: 5 }, () => record({ fw: 17825834, board: 'BDM-030' })),
    record({ fw: 17760256, board: 'BDM-020' }),
    record({ fw: 99999999, board: 'SERIAL-SENTINEL' }),
  ], { firmwareBuildYears: { 17825834: 2024 } });
  const fw = report.breakdowns.firmware;
  assert.deepEqual(Object.keys(fw), ['0x10f0000', '0x110002a', 'other_or_unknown']);
  assert.equal(fw['0x110002a'].sessions, 5);
  assert.equal(fw['0x110002a'].ratesSuppressed, false);
  assert.equal(fw['0x110002a'].passingRate, 1);
  assert.equal(fw['0x10f0000'].ratesSuppressed, true);
  assert.equal(fw['0x10f0000'].passingRate, null);
  assert.equal(fw['0x10f0000'].passingAfter, 1, 'counts stay visible');
  assert.deepEqual(Object.keys(report.breakdowns.buildYear), ['2024', 'unknown']);
  assert.equal(report.breakdowns.buildYear['2024'].sessions, 5);
  assert.deepEqual(Object.keys(report.breakdowns.board), ['BDM-020', 'BDM-030', 'other_or_unknown']);
  const rendered = JSON.stringify(report);
  for (const sentinel of ['SERIAL-SENTINEL', '99999999', '5f5e0ff']) assert.equal(rendered.includes(sentinel), false, sentinel);
});

test('lattice shapes are aggregate counts and never echo individual values', () => {
  const report = reportFor([
    record({ before: [2.773, 1.664], after: [FLOOR, STEP1] }),
    record({ before: [2.1, 0.4], after: [FLOOR, FLOOR] }),
  ]);
  assert.deepEqual(report.lattice.before, { singleAxis: 0, twoAxis: 1, ambiguous: 1, offLattice: 2 });
  assert.deepEqual(report.lattice.after, { singleAxis: 4, twoAxis: 0, ambiguous: 0, offLattice: 0 });
  assert.ok(report.lattice.maxDecodeErrorPct <= 0.0005);
  assert.equal(JSON.stringify(report.lattice).includes('2.773'), false);
});

test('the summary line adds within-one-step, the matched cohort and runaways', () => {
  const summary = formatQualitySummary(reportFor([record({ before: [4, 2], after: [STEP1, FLOOR] })]));
  assert.match(summary, /0 sotto 1\.2%; 1 entro 1 passo \(<=1\.25%\); MC 1 sessioni, tasso n\/d; 0 runaway;/);
});

test('CLI flags and environment configure exclusions, thresholds and build years', () => {
  const parsed = parseCliArgs([
    '--exclude-firmware', 'none',
    '--exclude-before', 'none',
    '--within-one-step', '1.3',
    '--worse-than-start', '0.6',
    '--dedup-gap', '30',
    '--known-firmware', '1,2',
    '--build-years', '17825834:2023,17760256:2022',
  ], {});
  assert.equal(parsed.excludeFirmware, null);
  assert.equal(parsed.excludeReceivedBefore, null);
  assert.equal(parsed.withinOneStepPct, 1.3);
  assert.equal(parsed.worseThanStartEpsPct, 0.6);
  assert.equal(parsed.dedupGapMinutes, 30);
  assert.deepEqual(parsed.knownFirmware, [1, 2]);
  assert.deepEqual(parsed.firmwareBuildYears, { 17825834: 2023, 17760256: 2022 });

  const fromEnv = parseCliArgs([], { CALIB_REPORT_EXCLUDE_FIRMWARE: '1234,42', CALIB_REPORT_EXCLUDE_BEFORE: '2026-09-17T00:00:00Z' });
  assert.deepEqual(fromEnv.excludeFirmware, [1234, 42]);
  assert.equal(fromEnv.excludeReceivedBefore, '2026-09-17T00:00:00Z');
  const defaults = parseCliArgs([], {});
  assert.equal(defaults.excludeFirmware, undefined, 'undefined falls back to the library defaults');
  assert.throws(() => parseCliArgs(['--build-years', '17825834-2023'], {}), /fw:year/);
  assert.throws(() => parseCliArgs(['--exclude-firmware', 'abc'], {}), /integers/);
});

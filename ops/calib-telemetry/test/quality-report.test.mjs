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
  buildQualityReport,
  createQualityReportFromFile,
  formatQualitySummary,
} from '../quality-report.mjs';

const FIXED_NOW = '2026-09-16T18:00:00.000Z';

function slot(off, noise = [0.2, 0.3]) {
  return { off, noise };
}

function record({
  receivedAt = '2026-09-16T12:00:00.000Z',
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
  const cutoff = '2026-09-16T12:00:00.000Z';
  const report = reportFor([
    record({ receivedAt: '2026-09-16T11:59:59.999Z', board: 'BDM-020' }),
    record({ receivedAt: cutoff, board: 'BDM-030' }),
    record({ receivedAt: '2026-09-16T12:00:00.001Z', board: null }),
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
      receivedAt: `2026-09-16T12:00:0${value}.000Z`,
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

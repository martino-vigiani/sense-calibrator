import path from 'node:path';
import * as fsPromises from 'node:fs/promises';

export const DEFAULT_REPORT_CONFIG = Object.freeze({
  publicThresholdPct: 1.2,
  highDeflectionPct: 15,
  changeEpsilonPct: 0.8,
  minimumCohortSize: 5,
  knownBoards: Object.freeze([
    'BDM-010',
    'BDM-020',
    'BDM-030',
    'BDM-040',
    'BDM-050',
  ]),
});

const OTHER_BOARD = 'other_or_unknown';
const REPORT_SCHEMA = 'sense-calibrator.telemetry-quality.v1';
const MAX_MEASUREMENT_PCT = 200;

const defaultFileOps = Object.freeze({
  mkdir: fsPromises.mkdir,
  open: fsPromises.open,
  readFile: fsPromises.readFile,
  realpath: fsPromises.realpath,
  rename: fsPromises.rename,
  stat: fsPromises.stat,
  unlink: fsPromises.unlink,
  writeFile: fsPromises.writeFile,
});

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeFinite(value, name) {
  if (!finiteNumber(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be an integer >= 1`);
  }
  return value;
}

function normalizeInstant(value, name) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new TypeError(`${name} must be an RFC 3339 timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be an RFC 3339 timestamp`);
  return new Date(milliseconds).toISOString();
}

function normalizeClock(clock) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('clock must return a valid date');
  return date.toISOString();
}

function normalizeKnownBoards(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('knownBoards must be a non-empty array');
  }
  const boards = value.map(board => {
    if (typeof board !== 'string' || board.length === 0 || board.length > 20) {
      throw new TypeError('knownBoards entries must be strings between 1 and 20 characters');
    }
    return board;
  });
  if (new Set(boards).size !== boards.length) {
    throw new TypeError('knownBoards must not contain duplicates');
  }
  return [...boards].sort((left, right) => left.localeCompare(right, 'en'));
}

export function normalizeReportOptions(options = {}) {
  const config = {
    publicThresholdPct: nonNegativeFinite(
      options.publicThresholdPct ?? DEFAULT_REPORT_CONFIG.publicThresholdPct,
      'publicThresholdPct',
    ),
    highDeflectionPct: nonNegativeFinite(
      options.highDeflectionPct ?? DEFAULT_REPORT_CONFIG.highDeflectionPct,
      'highDeflectionPct',
    ),
    changeEpsilonPct: nonNegativeFinite(
      options.changeEpsilonPct ?? DEFAULT_REPORT_CONFIG.changeEpsilonPct,
      'changeEpsilonPct',
    ),
    minimumCohortSize: positiveInteger(
      options.minimumCohortSize ?? DEFAULT_REPORT_CONFIG.minimumCohortSize,
      'minimumCohortSize',
    ),
    knownBoards: normalizeKnownBoards(options.knownBoards ?? DEFAULT_REPORT_CONFIG.knownBoards),
    sinceInclusive: normalizeInstant(options.sinceInclusive, 'sinceInclusive'),
    generatedAt: normalizeClock(options.clock ?? (() => new Date())),
  };

  return Object.freeze(config);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function measurementPair(value) {
  return Array.isArray(value)
    && value.length === 2
    && value.every(item => finiteNumber(item) && item >= 0 && item <= MAX_MEASUREMENT_PCT);
}

function calibrationSlot(value) {
  return isPlainObject(value)
    && measurementPair(value.off)
    && measurementPair(value.noise);
}

function validBoard(value) {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.length <= 20);
}

function parsedReceivedAt(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function normalizedBoard(value, knownBoards) {
  return typeof value === 'string' && knownBoards.has(value) ? value : OTHER_BOARD;
}

function rounded(value) {
  if (!finiteNumber(value)) return null;
  return Number(value.toFixed(6));
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : rounded(numerator / denominator);
}

function mean(values) {
  if (values.length === 0) return null;
  return rounded(values.reduce((total, value) => total + value, 0) / values.length);
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return rounded(ordered[midpoint]);
  return rounded((ordered[midpoint - 1] + ordered[midpoint]) / 2);
}

function summaryStats(values) {
  return {
    mean: mean(values),
    median: median(values),
  };
}

function emptyCounters() {
  return {
    blankLines: 0,
    malformedJsonLines: 0,
    invalidRecordLines: 0,
    invalidTimestampLines: 0,
    nonEmptyLines: 0,
    parsedObjectLines: 0,
    excludedBeforeCutoff: 0,
  };
}

function parseJsonLines(jsonl, config) {
  const counters = emptyCounters();
  const records = [];
  const text = String(jsonl);
  const unterminatedFinalLine = text.length > 0 && !text.endsWith('\n');
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) {
      const syntheticTrailingLine = line.length === 0
        && index === lines.length - 1
        && text.endsWith('\n');
      if (!syntheticTrailingLine && text.length > 0) counters.blankLines += 1;
      continue;
    }
    counters.nonEmptyLines += 1;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      counters.malformedJsonLines += 1;
      continue;
    }

    if (!isPlainObject(record) || !validBoard(record.board)) {
      counters.invalidRecordLines += 1;
      continue;
    }
    counters.parsedObjectLines += 1;

    const receivedAt = parsedReceivedAt(record.receivedAt);
    if (receivedAt === null) {
      counters.invalidTimestampLines += 1;
      counters.invalidRecordLines += 1;
      continue;
    }
    if (config.sinceInclusive !== null && receivedAt < Date.parse(config.sinceInclusive)) {
      counters.excludedBeforeCutoff += 1;
      continue;
    }

    records.push(record);
  }

  return { counters, records, unterminatedFinalLine };
}

function classifyChange(beforeWorst, afterWorst, epsilon) {
  const improvement = beforeWorst - afterWorst;
  if (improvement > epsilon) return 'improved';
  if (improvement < -epsilon) return 'worsened';
  return 'unchanged';
}

function sortedBoardCounts(counts) {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')),
  );
}

export function buildQualityReport(jsonl, options = {}) {
  const config = normalizeReportOptions(options);
  const knownBoards = new Set(config.knownBoards);
  const { counters, records, unterminatedFinalLine } = parseJsonLines(jsonl, config);
  const boardCounts = new Map();
  const outcomes = { improved: 0, worsened: 0, unchanged: 0 };
  const plausibleBefore = [];
  const plausibleAfter = [];

  let validMeasurements = 0;
  let invalidMeasurements = 0;
  let passingAfter = 0;
  let suspiciousSessions = 0;

  for (const record of records) {
    const board = normalizedBoard(record.board, knownBoards);
    boardCounts.set(board, (boardCounts.get(board) ?? 0) + 1);

    if (!calibrationSlot(record.before) || !calibrationSlot(record.after)) {
      invalidMeasurements += 1;
      continue;
    }

    validMeasurements += 1;
    const beforeWorst = Math.max(...record.before.off);
    const afterWorst = Math.max(...record.after.off);
    outcomes[classifyChange(beforeWorst, afterWorst, config.changeEpsilonPct)] += 1;
    if (afterWorst < config.publicThresholdPct) passingAfter += 1;

    const suspicious = Math.max(beforeWorst, afterWorst) >= config.highDeflectionPct;
    if (suspicious) {
      suspiciousSessions += 1;
    } else {
      plausibleBefore.push(beforeWorst);
      plausibleAfter.push(afterWorst);
    }
  }

  const plausibleSessions = plausibleBefore.length;
  const revealPlausibleStats = plausibleSessions >= config.minimumCohortSize;
  const plausibleStatistics = revealPlausibleStats
    ? {
        worstOffsetPct: {
          before: summaryStats(plausibleBefore),
          after: summaryStats(plausibleAfter),
        },
      }
    : null;

  return {
    schema: REPORT_SCHEMA,
    generatedAt: config.generatedAt,
    window: {
      timestampField: 'receivedAt',
      sinceInclusive: config.sinceInclusive,
    },
    definitions: {
      sessionOffset: 'maximum of left/right off values',
      changeEpsilonPct: config.changeEpsilonPct,
      improvedRule: 'beforeWorst - afterWorst > changeEpsilonPct',
      worsenedRule: 'afterWorst - beforeWorst > changeEpsilonPct',
      publicThresholdPct: config.publicThresholdPct,
      publicThresholdRule: 'afterWorst < publicThresholdPct',
      highDeflectionPct: config.highDeflectionPct,
      highDeflectionRule: 'max(beforeWorst, afterWorst) >= highDeflectionPct',
      minimumCohortSize: config.minimumCohortSize,
    },
    input: {
      bytes: Buffer.byteLength(String(jsonl), 'utf8'),
      ...counters,
      unterminatedFinalLine,
    },
    sessions: {
      total: records.length,
      validMeasurements,
      invalidMeasurements,
    },
    boards: {
      denominator: records.length,
      sessions: sortedBoardCounts(boardCounts),
    },
    outcomes: {
      denominator: validMeasurements,
      ...outcomes,
    },
    publicThreshold: {
      denominator: validMeasurements,
      passingAfter,
      failingAfter: validMeasurements - passingAfter,
      passingRate: rate(passingAfter, validMeasurements),
    },
    cohorts: {
      suspiciousHighDeflection: {
        denominator: validMeasurements,
        sessions: suspiciousSessions,
        rate: rate(suspiciousSessions, validMeasurements),
      },
      plausible: {
        denominator: validMeasurements,
        sessions: plausibleSessions,
        rate: rate(plausibleSessions, validMeasurements),
        statisticsSuppressed: !revealPlausibleStats,
        statistics: plausibleStatistics,
      },
    },
  };
}

function withDefaultFileOps(overrides = {}) {
  return { ...defaultFileOps, ...overrides };
}

async function existingIdentity(targetPath, fileOps) {
  try {
    const [realPath, stat] = await Promise.all([
      fileOps.realpath(targetPath),
      fileOps.stat(targetPath),
    ]);
    return { realPath, device: stat.dev, inode: stat.ino };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function assertDistinctInputOutput(inputPath, outputPath, options = {}) {
  const fileOps = withDefaultFileOps(options.fileOps);
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  if (resolvedInput === resolvedOutput) {
    throw new Error('outputPath must not be the inputPath');
  }

  const [inputIdentity, outputIdentity] = await Promise.all([
    existingIdentity(resolvedInput, fileOps),
    existingIdentity(resolvedOutput, fileOps),
  ]);
  if (inputIdentity && outputIdentity
      && (inputIdentity.realPath === outputIdentity.realPath
        || (inputIdentity.device === outputIdentity.device && inputIdentity.inode === outputIdentity.inode))) {
    throw new Error('outputPath must not resolve to the input file');
  }
}

function tempPathFor(outputPath) {
  const directory = path.dirname(outputPath);
  const basename = path.basename(outputPath);
  return path.join(
    directory,
    `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

async function syncFile(targetPath, fileOps) {
  const handle = await fileOps.open(targetPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory, fileOps) {
  let handle;
  try {
    handle = await fileOps.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeReportAtomic(outputPath, report, options = {}) {
  const fileOps = withDefaultFileOps(options.fileOps);
  const resolvedOutput = path.resolve(outputPath);
  const directory = path.dirname(resolvedOutput);
  const tempPath = tempPathFor(resolvedOutput);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;

  await fileOps.mkdir(directory, { recursive: true, mode: 0o750 });
  try {
    await fileOps.writeFile(tempPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await syncFile(tempPath, fileOps);
    await fileOps.rename(tempPath, resolvedOutput);
    await syncDirectory(directory, fileOps);
  } catch (error) {
    try {
      await fileOps.unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.cleanupError = cleanupError;
    }
    throw error;
  }
}

export async function createQualityReportFromFile(options) {
  if (!options || typeof options.inputPath !== 'string' || options.inputPath.length === 0) {
    throw new TypeError('inputPath is required');
  }

  // Validate every cutoff/threshold before any output-side mutation.
  const normalized = normalizeReportOptions(options);
  const fileOps = withDefaultFileOps(options.fileOps);
  if (options.outputPath !== undefined) {
    if (typeof options.outputPath !== 'string' || options.outputPath.length === 0) {
      throw new TypeError('outputPath must be a non-empty string');
    }
    await assertDistinctInputOutput(options.inputPath, options.outputPath, { fileOps });
  }

  const jsonl = await fileOps.readFile(options.inputPath, 'utf8');
  const report = buildQualityReport(jsonl, {
    ...normalized,
    clock: () => normalized.generatedAt,
  });

  if (options.outputPath !== undefined) {
    await writeReportAtomic(options.outputPath, report, { fileOps });
  }
  return report;
}

export function formatQualitySummary(report) {
  const stats = report.cohorts.plausible.statistics?.worstOffsetPct;
  const statsText = stats
    ? `mediana plausibile ${stats.before.median}% -> ${stats.after.median}%`
    : `statistiche plausibili nascoste (<${report.definitions.minimumCohortSize})`;
  return [
    report.generatedAt,
    `${report.sessions.total} sessioni`,
    `${report.sessions.validMeasurements} misurabili`,
    `${report.cohorts.suspiciousHighDeflection.sessions} sospette (>=${report.definitions.highDeflectionPct}%)`,
    `esiti ${report.outcomes.improved}/${report.outcomes.worsened}/${report.outcomes.unchanged} migliorate/peggiorate/invariate`,
    `${report.publicThreshold.passingAfter} sotto ${report.definitions.publicThresholdPct}%`,
    statsText,
  ].join('; ');
}

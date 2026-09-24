import path from 'node:path';
import * as fsPromises from 'node:fs/promises';

// Il reticolo e le soglie vengono da js/calib/lattice.js, la stessa tabella
// che usa la pagina: il report non ha una sua copia dei numeri. Nel repo si
// carica da js/calib/; sul VPS va copiato accanto a questo file come
// lattice.mjs (vedi README), perché lì non esiste l'albero js/ e, senza un
// package.json "type": "module", un .js verrebbe letto come CommonJS dalle
// versioni di Node senza rilevamento automatico della sintassi.
async function loadLattice() {
  const candidates = ['../../js/calib/lattice.js', './lattice.mjs', './lattice.js'];
  for (const specifier of candidates) {
    try {
      return await import(new URL(specifier, import.meta.url));
    } catch (error) {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('lattice not found: copy js/calib/lattice.js next to quality-report.mjs as lattice.mjs');
}

const lattice = await loadLattice();

export const DEFAULT_REPORT_CONFIG = Object.freeze({
  // KPI v1, invariato: afterWorst < 1.2, cioè entrambi gli assi al pavimento.
  publicThresholdPct: lattice.CENTERED_MAX,
  // Seconda metrica, non un nuovo KPI: afterWorst ≤ 1.25, al massimo un passo.
  withinOneStepPct: lattice.WITHIN_ONE_STEP_MAX,
  highDeflectionPct: lattice.GUIDED_ONLY_MIN,
  // 0.6 invece di 0.8: il primo gradino del reticolo (0.555 → 1.24) vale
  // 0.685, e con 0.8 quel miglioramento, il più comune, contava "invariato".
  // Nessuna differenza reale cade tra 0.3 e 0.6, quindi il valore è stabile.
  changeEpsilonPct: 0.6,
  // Peggioramento come lo intende la rapida (QUICK_DEFAULTS.regressionEps) e
  // come sono scritte le soglie di rollback del piano (§4.5).
  worseThanStartEpsPct: 0.8,
  minimumCohortSize: 5,
  // Sessioni ripetute: stesso board+fw con meno di 15 minuti tra la ricezione
  // di una e l'inizio della successiva. È un'euristica, riportata a parte.
  dedupGapMinutes: 15,
  // Esclusioni note. fw 1234 è un record sintetico di prova (valori fuori
  // reticolo); prima del commit 7c25998 (guard di preflight) i dati sono
  // soprattutto test dello sviluppatore. Entrambe configurabili, e contate.
  excludeFirmware: Object.freeze([1234]),
  excludeReceivedBefore: '2026-09-16T17:17:00.000Z',
  knownBoards: Object.freeze([
    'BDM-010',
    'BDM-020',
    'BDM-030',
    'BDM-040',
    'BDM-050',
  ]),
  // Firmware abbastanza diffusi da poter essere nominati; gli altri finiscono
  // in other_or_unknown, come le board: un valore arbitrario inviato da un
  // client non deve comparire nel report.
  knownFirmware: Object.freeze([17629194, 17760256, 17825834]),
  // La v1 non trasmette la data di build del firmware: l'anno si ricava solo
  // da una mappa fw → anno fornita a mano. Vuota, tutto è 'unknown'.
  firmwareBuildYears: Object.freeze({}),
});

const OTHER_BOARD = 'other_or_unknown';
const OTHER_FIRMWARE = 'other_or_unknown';
const UNKNOWN_YEAR = 'unknown';
const REPORT_SCHEMA = 'sense-calibrator.telemetry-quality.v2';
const REPORT_VERSION = 2;
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

function normalizeFirmwareList(value, name) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array of integers`);
  const list = value.map(item => {
    if (!Number.isInteger(item) || item < 0) throw new TypeError(`${name} entries must be integers >= 0`);
    return item;
  });
  return [...new Set(list)].sort((left, right) => left - right);
}

function normalizeBuildYears(value) {
  if (!isPlainObject(value)) throw new TypeError('firmwareBuildYears must be an object');
  const entries = Object.entries(value).map(([fw, year]) => {
    if (!/^\d+$/.test(fw)) throw new TypeError('firmwareBuildYears keys must be firmware integers');
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new TypeError('firmwareBuildYears values must be years');
    }
    return [fw, year];
  });
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => Number(left) - Number(right))));
}

export function normalizeReportOptions(options = {}) {
  const config = {
    publicThresholdPct: nonNegativeFinite(
      options.publicThresholdPct ?? DEFAULT_REPORT_CONFIG.publicThresholdPct,
      'publicThresholdPct',
    ),
    withinOneStepPct: nonNegativeFinite(
      options.withinOneStepPct ?? DEFAULT_REPORT_CONFIG.withinOneStepPct,
      'withinOneStepPct',
    ),
    worseThanStartEpsPct: nonNegativeFinite(
      options.worseThanStartEpsPct ?? DEFAULT_REPORT_CONFIG.worseThanStartEpsPct,
      'worseThanStartEpsPct',
    ),
    dedupGapMinutes: nonNegativeFinite(
      options.dedupGapMinutes ?? DEFAULT_REPORT_CONFIG.dedupGapMinutes,
      'dedupGapMinutes',
    ),
    excludeFirmware: normalizeFirmwareList(
      options.excludeFirmware === undefined ? DEFAULT_REPORT_CONFIG.excludeFirmware : options.excludeFirmware,
      'excludeFirmware',
    ),
    // null disattiva l'esclusione; undefined prende il default.
    excludeReceivedBefore: normalizeInstant(
      options.excludeReceivedBefore === undefined
        ? DEFAULT_REPORT_CONFIG.excludeReceivedBefore
        : options.excludeReceivedBefore,
      'excludeReceivedBefore',
    ),
    knownFirmware: normalizeFirmwareList(
      options.knownFirmware ?? DEFAULT_REPORT_CONFIG.knownFirmware,
      'knownFirmware',
    ),
    firmwareBuildYears: normalizeBuildYears(
      options.firmwareBuildYears ?? DEFAULT_REPORT_CONFIG.firmwareBuildYears,
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
    excludedFirmware: 0,
    excludedBeforeGuard: 0,
  };
}

function parseJsonLines(jsonl, config) {
  const counters = emptyCounters();
  const records = [];
  const text = String(jsonl);
  const unterminatedFinalLine = text.length > 0 && !text.endsWith('\n');
  const lines = text.split('\n');
  const excludedFirmware = new Set(config.excludeFirmware);

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
    // Ordine delle esclusioni: prima l'identità del dato (firmware sintetico),
    // poi le finestre temporali. Ogni riga è contata in una sola esclusione.
    if (Number.isInteger(record.fw) && excludedFirmware.has(record.fw)) {
      counters.excludedFirmware += 1;
      continue;
    }
    if (config.sinceInclusive !== null && receivedAt < Date.parse(config.sinceInclusive)) {
      counters.excludedBeforeCutoff += 1;
      continue;
    }
    if (config.excludeReceivedBefore !== null && receivedAt < Date.parse(config.excludeReceivedBefore)) {
      counters.excludedBeforeGuard += 1;
      continue;
    }

    records.push({ record, receivedAt });
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

// Errore standard binomiale: le soglie di rollback (§4.5) sono scritte in SE.
function standardError(numerator, denominator) {
  if (denominator === 0) return null;
  const p = numerator / denominator;
  return rounded(Math.sqrt((p * (1 - p)) / denominator));
}

function firmwareLabel(fw, knownFirmware) {
  if (!Number.isInteger(fw) || !knownFirmware.has(fw)) return OTHER_FIRMWARE;
  return `0x${fw.toString(16)}`;
}

function buildYearLabel(fw, buildYears) {
  if (!Number.isInteger(fw)) return UNKNOWN_YEAR;
  const year = buildYears[String(fw)];
  return year === undefined ? UNKNOWN_YEAR : String(year);
}

// Metriche di una coorte di sessioni misurabili. I tassi restano nulli sotto
// la coorte minima: con 2 sessioni una percentuale dice più sul singolo
// controller che sul prodotto.
function cohortMetrics(sessions, config) {
  const n = sessions.length;
  const count = predicate => sessions.filter(predicate).length;
  const passingAfter = count(s => s.afterWorst < config.publicThresholdPct);
  const withinOneStep = count(s => s.afterWorst <= config.withinOneStepPct);
  const outcomes = { improved: 0, worsened: 0, unchanged: 0 };
  for (const s of sessions) outcomes[classifyChange(s.beforeWorst, s.afterWorst, config.changeEpsilonPct)] += 1;
  const worseThanStart = count(s => s.afterWorst - s.beforeWorst > config.worseThanStartEpsPct);
  // Runaway: partita sotto il tetto, finita sopra. È il trigger immediato.
  const runaways = count(s => s.beforeWorst < config.highDeflectionPct && s.afterWorst >= config.highDeflectionPct);
  const suppressed = n < config.minimumCohortSize;
  const shown = (numerator) => (suppressed ? null : rate(numerator, n));
  return {
    sessions: n,
    ratesSuppressed: suppressed,
    passingAfter,
    passingRate: shown(passingAfter),
    passingRateStandardError: suppressed ? null : standardError(passingAfter, n),
    withinOneStep,
    withinOneStepRate: shown(withinOneStep),
    ...outcomes,
    worseThanStart,
    worseThanStartRate: shown(worseThanStart),
    worseThanStartStandardError: suppressed ? null : standardError(worseThanStart, n),
    runaways,
  };
}

function breakdown(sessions, keyOf, config) {
  const groups = new Map();
  for (const s of sessions) {
    const key = keyOf(s);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([key, group]) => [key, cohortMetrics(group, config)]),
  );
}

// Vista de-duplicata: la prima sessione di ogni gruppo di ripetizioni sullo
// stesso board+fw. Il tempo di inizio è `t` del client, se valido, altrimenti
// receivedAt; l'intervallo si misura dalla ricezione della sessione
// precedente, perché i clock dei client sono sfasati fino a qualche minuto.
function firstOfEachCluster(sessions, gapMinutes) {
  const ordered = [...sessions].sort((left, right) => left.start - right.start || left.receivedAt - right.receivedAt);
  const lastReceived = new Map();
  const firsts = [];
  let clusters = 0;
  for (const s of ordered) {
    const key = `${s.board}|${s.fw}`;
    const previous = lastReceived.get(key);
    if (previous === undefined || s.start - previous > gapMinutes * 60_000) {
      firsts.push(s);
      clusters += 1;
    }
    lastReceived.set(key, Math.max(previous ?? -Infinity, s.receivedAt));
  }
  return { firsts, clusters };
}

function emptyShapes() {
  return { singleAxis: 0, twoAxis: 0, ambiguous: 0, offLattice: 0 };
}

const SHAPE_KEYS = Object.freeze({
  'single-axis': 'singleAxis',
  'two-axis': 'twoAxis',
  ambiguous: 'ambiguous',
  'off-lattice': 'offLattice',
});

export function buildQualityReport(jsonl, options = {}) {
  const config = normalizeReportOptions(options);
  const knownBoards = new Set(config.knownBoards);
  const knownFirmware = new Set(config.knownFirmware);
  const { counters, records, unterminatedFinalLine } = parseJsonLines(jsonl, config);
  const boardCounts = new Map();
  const plausibleBefore = [];
  const plausibleAfter = [];
  const measured = [];
  const shapes = { before: emptyShapes(), after: emptyShapes() };
  let maxDecodeErrorPct = 0;

  let invalidMeasurements = 0;

  for (const { record, receivedAt } of records) {
    const board = normalizedBoard(record.board, knownBoards);
    boardCounts.set(board, (boardCounts.get(board) ?? 0) + 1);

    if (!calibrationSlot(record.before) || !calibrationSlot(record.after)) {
      invalidMeasurements += 1;
      continue;
    }

    const beforeWorst = Math.max(...record.before.off);
    const afterWorst = Math.max(...record.after.off);
    const clientStart = typeof record.t === 'string' ? Date.parse(record.t) : NaN;
    const session = {
      board,
      rawBoard: typeof record.board === 'string' ? record.board : null,
      fw: Number.isInteger(record.fw) ? record.fw : null,
      beforeWorst,
      afterWorst,
      receivedAt,
      start: Number.isFinite(clientStart) ? clientStart : receivedAt,
      suspicious: Math.max(beforeWorst, afterWorst) >= config.highDeflectionPct,
    };
    measured.push(session);

    // Forma sul reticolo di ogni offset: solo conteggi aggregati, mai i valori.
    for (const [slot, values] of [['before', record.before.off], ['after', record.after.off]]) {
      for (const value of values) {
        shapes[slot][SHAPE_KEYS[lattice.axisShape(value)]] += 1;
        const decoded = lattice.decodeOff(value);
        if (decoded) maxDecodeErrorPct = Math.max(maxDecodeErrorPct, decoded.error);
      }
    }

    if (!session.suspicious) {
      plausibleBefore.push(beforeWorst);
      plausibleAfter.push(afterWorst);
    }
  }

  const validMeasurements = measured.length;
  const all = cohortMetrics(measured, config);
  const plausibleSessions = measured.filter(s => !s.suspicious);
  const suspiciousSessions = validMeasurements - plausibleSessions.length;
  const revealPlausibleStats = plausibleSessions.length >= config.minimumCohortSize;
  const plausibleStatistics = revealPlausibleStats
    ? {
        worstOffsetPct: {
          before: summaryStats(plausibleBefore),
          after: summaryStats(plausibleAfter),
        },
      }
    : null;
  // Coorte di monitoraggio (MC): chi parte oltre un passo. Le partenze già
  // centrate o a un passo cambiano con le regole della rapida (skip), quindi
  // confrontare il tasso grezzo prima/dopo un rilascio sarebbe confuso.
  const matched = measured.filter(s => s.beforeWorst > config.withinOneStepPct);
  const { firsts, clusters } = firstOfEachCluster(
    measured.map(s => ({ ...s, board: s.rawBoard })),
    config.dedupGapMinutes,
  );

  return {
    schema: REPORT_SCHEMA,
    reportVersion: REPORT_VERSION,
    generatedAt: config.generatedAt,
    window: {
      timestampField: 'receivedAt',
      sinceInclusive: config.sinceInclusive,
    },
    exclusions: {
      firmware: config.excludeFirmware,
      receivedBefore: config.excludeReceivedBefore,
    },
    definitions: {
      sessionOffset: 'maximum of left/right off values',
      changeEpsilonPct: config.changeEpsilonPct,
      improvedRule: 'beforeWorst - afterWorst > changeEpsilonPct',
      worsenedRule: 'afterWorst - beforeWorst > changeEpsilonPct',
      publicThresholdPct: config.publicThresholdPct,
      publicThresholdRule: 'afterWorst < publicThresholdPct',
      withinOneStepPct: config.withinOneStepPct,
      withinOneStepRule: 'afterWorst <= withinOneStepPct',
      worseThanStartEpsPct: config.worseThanStartEpsPct,
      worseThanStartRule: 'afterWorst - beforeWorst > worseThanStartEpsPct',
      runawayRule: 'beforeWorst < highDeflectionPct and afterWorst >= highDeflectionPct',
      highDeflectionPct: config.highDeflectionPct,
      highDeflectionRule: 'max(beforeWorst, afterWorst) >= highDeflectionPct',
      matchedCohortRule: 'beforeWorst > withinOneStepPct',
      dedupRule: 'first session per board+fw; a new cluster starts when t - previous receivedAt > dedupGapMinutes',
      dedupGapMinutes: config.dedupGapMinutes,
      latticeStepPct: rounded(lattice.LSB_PCT),
      latticeFloorPct: rounded(lattice.FLOOR_PCT),
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
      improved: all.improved,
      worsened: all.worsened,
      unchanged: all.unchanged,
    },
    // KPI v1: stessa regola e stessa forma della v1.
    publicThreshold: {
      denominator: validMeasurements,
      passingAfter: all.passingAfter,
      failingAfter: validMeasurements - all.passingAfter,
      passingRate: rate(all.passingAfter, validMeasurements),
    },
    withinOneStep: {
      denominator: validMeasurements,
      withinAfter: all.withinOneStep,
      withinOneStepRate: rate(all.withinOneStep, validMeasurements),
    },
    safety: {
      denominator: validMeasurements,
      worseThanStart: all.worseThanStart,
      worseThanStartRate: rate(all.worseThanStart, validMeasurements),
      runaways: all.runaways,
    },
    cohorts: {
      suspiciousHighDeflection: {
        denominator: validMeasurements,
        sessions: suspiciousSessions,
        rate: rate(suspiciousSessions, validMeasurements),
      },
      plausible: {
        denominator: validMeasurements,
        sessions: plausibleSessions.length,
        rate: rate(plausibleSessions.length, validMeasurements),
        statisticsSuppressed: !revealPlausibleStats,
        statistics: plausibleStatistics,
        metrics: cohortMetrics(plausibleSessions, config),
      },
      matched: {
        denominator: validMeasurements,
        metrics: cohortMetrics(matched, config),
      },
      deduplicated: {
        denominator: validMeasurements,
        clusters,
        repeatSessions: validMeasurements - firsts.length,
        metrics: cohortMetrics(firsts, config),
      },
    },
    breakdowns: {
      board: breakdown(measured, s => s.board, config),
      firmware: breakdown(measured, s => firmwareLabel(s.fw, knownFirmware), config),
      buildYear: breakdown(measured, s => buildYearLabel(s.fw, config.firmwareBuildYears), config),
      boardDeduplicated: breakdown(
        firsts.map(s => ({ ...s, board: normalizedBoard(s.board, knownBoards) })),
        s => s.board,
        config,
      ),
    },
    lattice: {
      maxDecodeErrorPct: rounded(maxDecodeErrorPct),
      before: shapes.before,
      after: shapes.after,
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
    `${report.withinOneStep.withinAfter} entro 1 passo (<=${report.definitions.withinOneStepPct}%)`,
    `MC ${report.cohorts.matched.metrics.sessions} sessioni, tasso ${report.cohorts.matched.metrics.passingRate ?? 'n/d'}`,
    `${report.safety.runaways} runaway`,
    statsText,
  ].join('; ');
}

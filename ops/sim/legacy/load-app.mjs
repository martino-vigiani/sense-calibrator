// Harness PRE-REFACTOR: carica il `quickCalibrate` di un app.js monolitico
// (quello precedente all'estrazione in js/calib/), estraendo a runtime le
// dichiarazioni top-level e valutandole in un contesto vm con orologio virtuale
// e stub DOM. È il prototipo di analisi, portato qui con un solo scopo:
// dimostrare che il refactor non cambia il comportamento (ops/sim/equivalence.mjs
// e il golden sintetico di test/sim-equivalence.test.js).
//
// Il sorgente si legge da git (`PRE_REFACTOR_REV`), non dal file corrente: dopo
// il refactor app.js non contiene più l'algoritmo.
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { DS5 } from '../../../js/ds5.js';
import * as guard from '../../../js/quick-center-guard.js';
import { REPO_ROOT } from '../population.mjs';

// Merge di WS-H su improve/v2: l'ultimo app.js con l'algoritmo inline.
export const PRE_REFACTOR_REV = '40a08ed';

export function loadLegacySource({ rev = PRE_REFACTOR_REV, file = process.env.SENSE_LEGACY_APP } = {}) {
  if (file) return fs.readFileSync(file, 'utf8');
  return execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:js/app.js`], { encoding: 'utf8', maxBuffer: 1 << 24 });
}

export function extractDecl(src, name) {
  const lines = src.split('\n');
  const re = new RegExp(`^(async function ${name}\\(|function ${name}\\(|const ${name} =|let ${name} =)`);
  const i = lines.findIndex(l => re.test(l));
  if (i < 0) throw new Error(`declaration not found: ${name}`);
  if (/^(const|let) /.test(lines[i]) && !lines[i].includes('{')) return { text: lines[i], line: i + 1 };
  let depth = 0;
  const out = [];
  for (let j = i; j < lines.length; j++) {
    out.push(lines[j]);
    for (const c of lines[j].replace(/\/\/.*$/, '')) { if (c === '{') depth++; else if (c === '}') depth--; }
    if (depth === 0 && /[};]\s*$/.test(lines[j].replace(/\/\/.*$/, ''))) return { text: out.join('\n'), line: i + 1 };
  }
  throw new Error(`unbalanced: ${name}`);
}
const CONSTS = ['DRIFT_OK_MAX', 'DRIFT_MOVE_SPREAD', 'DRIFT_WINDOW', 'QUICK_MAX_PASSES', 'QUICK_SAMPLES_PER_PASS',
  'QUICK_STABLE_SPREAD', 'QUICK_STABLE_SPREAD_MAX', 'QUICK_STABLE_MS', 'QUICK_STABLE_TIMEOUT', 'QUICK_CONVERGE_EPS',
  'QUICK_REGRESSION_EPS', 'QUICK_NOISE_WORN', 'stickListeners'];
const FUNCS = ['median', 'analyzeDrift', 'extractStableSamples', 'notifyStickSample', 'onInputReport',
  'waitForStable', 'measureOffset', 'summarizeResult', 'quickCalibrate'];

export function buildSource(app, patches = []) {
  let body = [...CONSTS, ...FUNCS].map(n => extractDecl(app, n).text).join('\n\n');
  for (const [from, to] of patches) {
    if (!body.includes(from)) throw new Error(`patch anchor not found: ${from.slice(0, 60)}`);
    body = body.replace(from, to);
  }
  return `
let ds5 = null, sticks = { lx: 0, ly: 0, rx: 0, ry: 0 }, busy = false, deviceInfo = null;
let quickPreflightBlocked = false, driftTest = null, rangeSession = null, playtest = null, lastBattery = 0, battery = null;
${body}
globalThis.__api = { quickCalibrate, onInputReport, setDs5: d => { ds5 = d; }, setInfo: i => { deviceInfo = i; } };`;
}

function elementStub() {
  return { style: {}, dataset: {}, disabled: false, innerHTML: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => elementStub() };
}

let cachedScript = null;
function compiled(app) {
  if (!cachedScript || cachedScript.app !== app) {
    cachedScript = { app, script: new vm.Script(buildSource(app), { filename: 'app.js(legacy, extracted)' }) };
  }
  return cachedScript.script;
}

export function makeLegacyInstance(clock, app) {
  const events = { logs: [], toasts: [], sessions: [], unsaved: false };
  const ctx = vm.createContext({
    console, Math, JSON, Promise, Set, Map, Array, Number, String, Infinity, Error, Object,
    performance: { now: clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    sleep: ms => new Promise(r => clock.setTimeout(r, ms)),
    $: () => elementStub(),
    log: m => events.logs.push([clock.now(), m]),
    toast: m => events.toasts.push(m),
    closeModal() {}, setBatteryChip() {}, startDriftTest() {}, cancelDriftTest() {},
    setUnsaved: v => { events.unsaved = v; },
    recordSessionOnce: s => { events.sessions.push(structuredClone(s)); },
    createQuickCenterHold: guard.createQuickCenterHold, sticksWithinQuickCenter: guard.sticksWithinQuickCenter,
  });
  compiled(app).runInContext(ctx);
  return { api: ctx.__api, events, DS5 };
}

// Esito "di oggi" ricavato dal testo del toast, per confrontarlo con l'enum
// restituito da runQuick. L'ordine segue la precedenza dei toast in app.js.
export function outcomeFromToast(toast, session) {
  if (!toast) return session?.aborted === 'preflight' ? 'preflight' : null;
  if (toast.startsWith('Calibration failed:')) return 'error';
  if (toast.startsWith('Calibration applied, but the result could not be verified')) return 'unverified';
  if (toast === 'Quick calibration complete.') return 'centered';
  if (toast.includes('(worn sensor)')) return 'worn';
  if (toast.includes('ended worse than the starting point')) return 'worse-than-start';
  if (toast.includes('an earlier pass had reached')) return 'lost-ground';
  if (toast.includes('Movement was detected during sampling')) return 'unstable';
  if (toast.includes('If it persists, try the guided one')) return 'residual';
  return `unknown:${toast.slice(0, 40)}`;
}

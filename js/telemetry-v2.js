'use strict';

// Telemetria v2: eventi tipizzati per POST /api/calib/v2/events.
//
// Il contratto è uno solo: ops/calib-telemetry/contract/events-v2.schema.json,
// copiato nel servizio (subralabs-v2/code/calib-telemetry/contract/). Qui ne
// arriva la copia JS generata (telemetry-v2-schema.js, test/telemetry-v2.test.js
// la confronta col JSON), e ogni evento passa dallo stesso validatore che usa il
// server PRIMA di lasciare il browser: un bug nei builder produce un evento
// scartato in locale, mai un campo in più in rete.
//
// Il payload v1 (js/telemetry.js) resta com'è, per le pagine già in cache e per
// il confronto dei KPI: le sessioni Quick complete partono su v1 E su v2.
//
// Privacy per costruzione: nessun seriale, chiave del controller, testo libero
// o orario del client. `sid` è casuale per caricamento di pagina e distinto
// dal SESSION_ID degli eventi locali; `seq` ordina gli eventi della visita, `app`
// è la data della release. Il giorno di ricezione lo aggiunge il server.

import { EVENTS_V2_SCHEMA } from './telemetry-v2-schema.js';

export const EVENTS_V2_ENDPOINT = 'https://subralabs.com/api/calib/v2/events';
// Data della release che produce gli eventi (YYYYMMDD). Va aggiornata a ogni
// rilascio che cambia cosa si misura, così il report separa le versioni.
export const TELEMETRY_APP_BUILD = 20260928;
// Versione della descrizione a cui acconsente chi sceglie "Keep sharing".
// Salvata in localStorage (`sense-telemetry-scope`): se la pagina ne mostra una
// più nuova, l'avviso ricompare prima che partano le categorie nuove.
export const TELEMETRY_SCOPE = 3;

/* ------------------------------ validatore ------------------------------ */

// Sottoinsieme di JSON Schema 2020-12 usato dal contratto. Una parola chiave
// non gestita fa lanciare invece di passare in silenzio: se lo schema cresce,
// il validatore deve crescere con lui (stessa regola nel server).
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'discriminator', '$defs']);
const KEYWORDS = new Set(['$ref', 'type', 'const', 'enum', 'minimum', 'maximum', 'pattern', 'minItems', 'maxItems',
  'items', 'uniqueItems', 'required', 'properties', 'additionalProperties', 'oneOf']);

const typeOf = value => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? (Number.isInteger(value) ? 'integer' : 'number') : 'nonfinite';
  return typeof value;
};
const typeMatches = (value, type) => {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
};

function resolveRef(root, ref) {
  const match = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(ref);
  const target = match && root.$defs?.[match[1]];
  if (!target) throw new Error(`Unsupported $ref ${ref}`);
  return target;
}

function check(root, schema, value, path, errors) {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`Unsupported schema keyword ${key} at ${path}`);
  }
  const fail = message => { errors.push(`${path}: ${message}`); return false; };
  if (schema.$ref && !check(root, resolveRef(root, schema.$ref), value, path, errors)) return false;
  if (schema.oneOf) {
    // Il discriminante sceglie il ramo: messaggi d'errore utili, e con `type`
    // costante in ogni ramo "esattamente uno" equivale a "quello indicato".
    const prop = schema.discriminator?.propertyName;
    if (prop) {
      const target = typeOf(value) === 'object' ? schema.discriminator.mapping?.[value[prop]] : undefined;
      if (typeof target !== 'string' || !Object.prototype.hasOwnProperty.call(schema.discriminator.mapping, value[prop])) {
        return fail(`unknown ${prop}`);
      }
      if (!check(root, { $ref: target }, value, path, errors)) return false;
    } else {
      const matches = schema.oneOf.filter(branch => check(root, branch, value, path, [])).length;
      if (matches !== 1) return fail(`must match exactly one schema (matched ${matches})`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) return fail(`must be ${types.join(' or ')}`);
  }
  if ('const' in schema && value !== schema.const) return fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(option => option === value)) return fail('is not an allowed value');
  const kind = typeOf(value);
  if (kind === 'integer' || kind === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return fail(`must be ≥ ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) return fail(`must be ≤ ${schema.maximum}`);
  }
  if (kind === 'string' && schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
    return fail('does not match the pattern');
  }
  if (kind === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) return fail(`needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return fail(`allows at most ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return fail('has duplicate items');
    if (schema.items) {
      for (let i = 0; i < value.length; i++) if (!check(root, schema.items, value[i], `${path}[${i}]`, errors)) return false;
    }
  }
  if (kind === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return fail(`missing field ${key}`);
    }
    const props = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        if (!check(root, props[key], value[key], `${path}.${key}`, errors)) return false;
      } else if (schema.additionalProperties === false) {
        return fail(`unknown field ${key}`);
      }
    }
  }
  return true;
}

// Ritorna null se l'evento rispetta il contratto, altrimenti il primo errore.
export function validateEventV2(event, schema = EVENTS_V2_SCHEMA) {
  const errors = [];
  if (!check(schema, schema, event, '$', errors)) return errors[0] ?? '$: invalid';
  if (event.type === 'quick') {
    // Il sottoinsieme JSON Schema condiviso non confronta lunghezze tra campi:
    // questa verifica evita di attribuire un asse alla passata sbagliata.
    if (event.passAxes.length !== event.passes.length) return '$.passAxes: must match passes length';
    if (event.passes.some((value, i) => value === null && event.passAxes[i] !== null)) {
      return '$.passAxes: unverified pass must be null';
    }
  }
  return null;
}

/* ------------------------------ builders ------------------------------ */

const BOARDS = new Set(['BDM-010', 'BDM-020', 'BDM-030', 'BDM-040', 'BDM-050', 'BDM-060R', 'BDM-060M', 'BDM-060X']);
const round = (value, digits) => {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isNum = value => typeof value === 'number' && Number.isFinite(value);
const pct = value => (isNum(value) ? round(clamp(value, 0, 200), 2) : null);
const pair = result => {
  const off = result?.off;
  if (!Array.isArray(off) || off.length !== 2 || !off.every(isNum)) return null;
  return [pct(off[0]), pct(off[1])];
};
// La mediana di un numero pari di report può cadere tra due byte: l'intero
// in mezzi LSB conserva quel valore e il segno. `xy` è già misurato in % da
// summarizeResult; 2.55 converte 1% in 2.55 mezzi LSB, senza altri report HID.
const axesFromXY = xy => {
  if (!Array.isArray(xy) || xy.length !== 2 || !xy.every(stick => Array.isArray(stick) && stick.length === 2 && stick.every(isNum))) return null;
  return xy.map(stick => stick.map(value => clamp(Math.round(value * 2.55), -128, 128)));
};
const axes = result => axesFromXY(result?.xy);
const seconds = ms => (isNum(ms) ? clamp(Math.round(ms / 1000), 0, 3600) : 0);
const count = (value, max = 50) => (Number.isInteger(value) ? clamp(value, 0, max) : 0);
const board = value => (BOARDS.has(value) ? value : null);
const firmware = value => (Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null);

function envelope(type, ctx) {
  return { v: 2, type, sid: ctx.sid, seq: ctx.seq, app: TELEMETRY_APP_BUILD };
}
function device(ctx) {
  return { board: board(ctx.board), fw: firmware(ctx.fw) };
}

const QUICK_OUTCOMES = new Set(['centered', 'within-1-step', 'residual', 'residual-deterministic', 'unstable', 'worn',
  'lost-ground', 'worse-than-start', 'catastrophic', 'unverified', 'already-centered', 'preflight', 'moved', 'stalled',
  'disconnected', 'error']);

// Una corsa Quick (sessione locale di runQuick + il suo esito). `outcome` è
// quello di runQuick, o dell'aborto locale se la corsa è finita in un errore
// della pagina.
export function buildQuickEvent(ctx, { session, outcome, start = 'normal', committed = false, needsPowerCycle = false, durMs }) {
  const passes = Array.isArray(session?.passes) ? session.passes.slice(0, 8).map(pct) : [];
  return {
    ...envelope('quick', ctx),
    ...device(ctx),
    outcome: QUICK_OUTCOMES.has(outcome) ? outcome : 'error',
    start,
    committed: committed === true,
    needsPowerCycle: needsPowerCycle === true,
    truncated: session?.truncated != null,
    before: pair(session?.before),
    beforeAxes: axes(session?.before),
    after: pair(session?.after),
    afterAxes: axes(session?.after),
    passes,
    passAxes: passes.map((value, i) => value === null ? null : axesFromXY(session?.passXY?.[i])),
    durS: seconds(durMs),
  };
}

export function buildGuidedEvent(ctx, { outcome, committed, needsPowerCycle, step, before, after, timeouts, escaped, durMs }) {
  return {
    ...envelope('guided', ctx),
    ...device(ctx),
    outcome,
    committed: committed === true,
    needsPowerCycle: needsPowerCycle === true,
    step: Number.isInteger(step) ? clamp(step, 0, 5) : 0,
    before: pair(before),
    beforeAxes: axes(before),
    after: pair(after),
    afterAxes: axes(after),
    timeouts: count(timeouts),
    escaped: escaped === true,
    durS: seconds(durMs),
  };
}

export function buildRangeEvent(ctx, { outcome, committed, coverage, turns, allEdges, durMs }) {
  const unit = value => (isNum(value) ? round(clamp(value, 0, 1), 2) : 0);
  const turn = value => (isNum(value) ? round(clamp(value, 0, 100), 1) : 0);
  return {
    ...envelope('range', ctx),
    ...device(ctx),
    outcome,
    committed: committed === true,
    coverage: [unit(coverage?.[0]), unit(coverage?.[1])],
    turns: [turn(turns?.[0]), turn(turns?.[1])],
    allEdges: allEdges === true,
    durS: seconds(durMs),
  };
}

const NV_STATUSES = new Set(['locked', 'unlocked', 'pending_reboot', 'unknown', 'error']);
export const nvStatusFor = nv => (NV_STATUSES.has(nv?.status) ? nv.status : null);

// Classe dell'esito di un flash, dall'errore di DS5.flash() (flashStage) e
// dallo stato NVS riletto. Mai il messaggio dell'errore: è testo libero.
export function flashResultFor(error, nv) {
  if (!error) return nv?.status === 'locked' || nv?.status === 'pending_reboot' ? 'ok' : 'not-confirmed';
  if (error.nvUnknown) return 'nv-unknown';
  if (error.flashStage === 'unlock') return 'unlock-failed';
  if (error.flashStage === 'lock') return 'lock-failed';
  return 'error';
}

export function buildFlashEvent(ctx, { result, nv, attempt, lock }) {
  return {
    ...envelope('flash', ctx),
    ...device(ctx),
    result,
    nv: nvStatusFor(nv),
    attempt: clamp(Number.isInteger(attempt) ? attempt : 1, 1, 50),
    lock: lock === 'guarded' ? 'guarded' : 'allowed',
  };
}

const LOCK_REASONS = ['poisoned', 'needs-power-cycle', 'catastrophic', 'pinned', 'worse-than-start', 'lost-ground',
  'unverified', 'range-incomplete', 'range-already-closed'];

// Fine di un periodo "non salvato" (vedi createSaveTracker in app.js).
export function buildSaveEvent(ctx, { result, ref, sessions, lock, opens, reminderOpens, cancels, attempts, lastFlash, seen, waitMs }) {
  const codes = new Set((lock?.reasons ?? []).map(r => r.code));
  return {
    ...envelope('save', ctx),
    result,
    ref: Number.isInteger(ref) && ref >= 0 && ref <= 255 ? ref : null,
    sessions: count(sessions),
    lock: ['allowed', 'guarded', 'disabled'].includes(lock?.mode) ? lock.mode : 'allowed',
    reasons: LOCK_REASONS.filter(code => codes.has(code)),
    opens: count(opens),
    reminderOpens: count(reminderOpens),
    cancels: count(cancels),
    attempts: count(attempts),
    lastFlash: lastFlash ?? null,
    seen: seen === true,
    waitS: seconds(waitMs),
  };
}

// Riassunto di una finestra a riposo (js/calib/rest-noise.js).
export function buildRestEvent(ctx, { summary, drift, state, discarded }) {
  return {
    ...envelope('rest', ctx),
    board: board(ctx.board),
    ctx: drift ? 'drift' : 'idle',
    state,
    durS: clamp(Math.round(summary.durMs / 1000), 10, 120),
    reports: summary.reports,
    intervalMs: summary.intervalMs,
    gaps: summary.gaps,
    discarded: count(discarded, 1000),
    sticks: summary.sticks,
  };
}

/* ------------------------------ invio ------------------------------ */

// Un evento che non rispetta il contratto non parte: ritorna false senza
// chiamare fetch. Un 4xx/5xx lancia, come v1.
export async function uploadEventV2(event, options = {}) {
  if (validateEventV2(event) !== null) return false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoint = options.endpoint ?? EVENTS_V2_ENDPOINT;
  const signal = options.signal
    ?? (globalThis.AbortSignal?.timeout ? AbortSignal.timeout(options.timeoutMs ?? 4000) : undefined);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    keepalive: true,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`Telemetry v2 rejected with HTTP ${response.status}`);
  return true;
}

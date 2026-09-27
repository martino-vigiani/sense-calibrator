'use strict';

// Contratto v2 degli eventi di Sense-Calibrator (POST /api/calib/v2/events).
//
// Lo schema è contract/events-v2.schema.json, copia identica byte per byte di
// quello del sito (Sense-Calibrator/ops/calib-telemetry/contract/): i due test
// ne fissano la stessa impronta SHA-256 e girano le stesse fixture, ognuno col
// proprio validatore. Questo è il porting CommonJS di quello della pagina
// (js/telemetry-v2.js): stesso sottoinsieme di JSON Schema 2020-12, e una
// parola chiave non gestita fa lanciare, così uno schema che cresce non passa
// mai in silenzio con controlli mancanti.

const SCHEMA = require('./contract/events-v2.schema.json');

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'discriminator', '$defs']);
const KEYWORDS = new Set(['$ref', 'type', 'const', 'enum', 'minimum', 'maximum', 'pattern', 'minItems', 'maxItems',
  'items', 'uniqueItems', 'required', 'properties', 'additionalProperties', 'oneOf']);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isFinite(value) ? (Number.isInteger(value) ? 'integer' : 'number') : 'nonfinite';
  return typeof value;
}
function typeMatches(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

function resolveRef(root, ref) {
  const match = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(ref);
  const target = match && root.$defs && hasOwn(root.$defs, match[1]) ? root.$defs[match[1]] : null;
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
    const prop = schema.discriminator && schema.discriminator.propertyName;
    if (prop) {
      const mapping = schema.discriminator.mapping || {};
      const tag = typeOf(value) === 'object' ? value[prop] : undefined;
      if (typeof tag !== 'string' || !hasOwn(mapping, tag)) return fail(`unknown ${prop}`);
      if (!check(root, { $ref: mapping[tag] }, value, path, errors)) return false;
    } else {
      const matches = schema.oneOf.filter(branch => check(root, branch, value, path, [])).length;
      if (matches !== 1) return fail(`must match exactly one schema (matched ${matches})`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) return fail(`must be ${types.join(' or ')}`);
  }
  if (hasOwn(schema, 'const') && value !== schema.const) return fail(`must be ${JSON.stringify(schema.const)}`);
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
    for (const key of schema.required || []) {
      if (!hasOwn(value, key)) return fail(`missing field ${key}`);
    }
    const props = schema.properties || {};
    for (const key of Object.keys(value)) {
      if (hasOwn(props, key)) {
        if (!check(root, props[key], value[key], `${path}.${key}`, errors)) return false;
      } else if (schema.additionalProperties === false) {
        return fail(`unknown field ${key}`);
      }
    }
  }
  return true;
}

// null se l'evento rispetta il contratto, altrimenti il primo errore (percorso
// e regola, mai il valore ricevuto).
function validateEventV2(event, schema = SCHEMA) {
  const errors = [];
  if (!check(schema, schema, event, '$', errors)) return errors[0] || '$: invalid';
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

module.exports = { SCHEMA, validateEventV2 };

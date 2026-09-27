'use strict';

// Le componenti OpenAPI del contratto v2, derivate dallo schema JSON: la radice
// diventa CalibrationEventV2, ogni $defs/X diventa EventV2X, e i $ref seguono.
// calib-telemetry-v2.test.js confronta il risultato con
// code/subralabs.com/openapi.json: se lo schema cambia, le componenti pubblicate
// vanno rigenerate da qui (stampale con `node contract/openapi-components.js`).

const ROOT_NAME = 'CalibrationEventV2';
const defName = name => `EventV2${name}`;

function rewriteRefs(node) {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (!node || typeof node !== 'object') {
    if (typeof node === 'string' && node.startsWith('#/$defs/')) return `#/components/schemas/${defName(node.slice(8))}`;
    return node;
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = rewriteRefs(value);
  return out;
}

function openapiComponentsFromSchema(schema) {
  const { $schema, $id, $defs, ...root } = schema;
  const components = { [ROOT_NAME]: rewriteRefs(root) };
  for (const [name, def] of Object.entries($defs)) components[defName(name)] = rewriteRefs(def);
  return components;
}

module.exports = { ROOT_NAME, openapiComponentsFromSchema };

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(openapiComponentsFromSchema(require('./events-v2.schema.json')), null, 2)}\n`);
}

'use strict';

// Le componenti OpenAPI dei contratti v2, derivate dagli schemi JSON: la radice
// diventa CalibrationEventV2 (DiagnosticsReportV1), ogni $defs/X diventa
// EventV2X (DiagV1X), e i $ref seguono. calib-telemetry-v2.test.js confronta il
// risultato con code/subralabs.com/openapi.json: se uno schema cambia, le
// componenti pubblicate vanno rigenerate da qui (stampale con
// `node contract/openapi-components.js`).

const ROOT_NAME = 'CalibrationEventV2';
const DIAGNOSTICS_ROOT_NAME = 'DiagnosticsReportV1';
const NAMING = {
  events: { rootName: ROOT_NAME, prefix: 'EventV2' },
  diagnostics: { rootName: DIAGNOSTICS_ROOT_NAME, prefix: 'DiagV1' },
};

function rewriteRefs(node, prefix) {
  if (Array.isArray(node)) return node.map(item => rewriteRefs(item, prefix));
  if (!node || typeof node !== 'object') {
    if (typeof node === 'string' && node.startsWith('#/$defs/')) return `#/components/schemas/${prefix}${node.slice(8)}`;
    return node;
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) out[key] = rewriteRefs(value, prefix);
  return out;
}

function openapiComponentsFromSchema(schema, { rootName = ROOT_NAME, prefix = 'EventV2' } = {}) {
  const { $schema, $id, $defs, ...root } = schema;
  const components = { [rootName]: rewriteRefs(root, prefix) };
  for (const [name, def] of Object.entries($defs)) components[`${prefix}${name}`] = rewriteRefs(def, prefix);
  return components;
}

module.exports = { ROOT_NAME, DIAGNOSTICS_ROOT_NAME, NAMING, openapiComponentsFromSchema };

if (require.main === module) {
  process.stdout.write(`${JSON.stringify({
    ...openapiComponentsFromSchema(require('./events-v2.schema.json'), NAMING.events),
    ...openapiComponentsFromSchema(require('./diagnostics-v1.schema.json'), NAMING.diagnostics),
  }, null, 2)}\n`);
}

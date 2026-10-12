// Rigenera le copie JS dei contratti JSON (unica fonte):
//   node ops/calib-telemetry/contract/sync-schema.mjs
// La pagina non ha build step e un `import ... with { type: 'json' }` romperebbe
// il modulo sui Chrome più vecchi, quindi il browser carica queste copie JS:
// js/telemetry-v2-schema.js (eventi v2) e js/diag/diagnostics-schema.js (report
// diagnostico v1). test/telemetry-v2.test.js e test/diag-contract.test.js
// falliscono se divergono.
import fs from 'node:fs';

const source = new URL('./events-v2.schema.json', import.meta.url);
const target = new URL('../../../js/telemetry-v2-schema.js', import.meta.url);
export const renderSchemaModule = (json, { name = 'EVENTS_V2_SCHEMA', from = 'events-v2.schema.json' } = {}) => `'use strict';

// GENERATO da ops/calib-telemetry/contract/${from} con
// ops/calib-telemetry/contract/sync-schema.mjs. Non modificarlo a mano.
export const ${name} = Object.freeze(${JSON.stringify(JSON.parse(json), null, 2)});
`;

export const DIAGNOSTICS_MODULE = { name: 'DIAGNOSTICS_V1_SCHEMA', from: 'diagnostics-v1.schema.json' };
const diagSource = new URL('./diagnostics-v1.schema.json', import.meta.url);
const diagTarget = new URL('../../../js/diag/diagnostics-schema.js', import.meta.url);

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  fs.writeFileSync(target, renderSchemaModule(fs.readFileSync(source, 'utf8')));
  console.log(`wrote ${target.pathname}`);
  fs.writeFileSync(diagTarget, renderSchemaModule(fs.readFileSync(diagSource, 'utf8'), DIAGNOSTICS_MODULE));
  console.log(`wrote ${diagTarget.pathname}`);
}

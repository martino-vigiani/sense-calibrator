// Rigenera js/telemetry-v2-schema.js dal contratto JSON (unica fonte):
//   node ops/calib-telemetry/contract/sync-schema.mjs
// La pagina non ha build step e un `import ... with { type: 'json' }` romperebbe
// il modulo sui Chrome più vecchi, quindi il browser carica questa copia JS.
// test/telemetry-v2.test.js fallisce se le due divergono.
import fs from 'node:fs';

const source = new URL('./events-v2.schema.json', import.meta.url);
const target = new URL('../../../js/telemetry-v2-schema.js', import.meta.url);
export const renderSchemaModule = json => `'use strict';

// GENERATO da ops/calib-telemetry/contract/events-v2.schema.json con
// ops/calib-telemetry/contract/sync-schema.mjs. Non modificarlo a mano.
export const EVENTS_V2_SCHEMA = Object.freeze(${JSON.stringify(JSON.parse(json), null, 2)});
`;

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  fs.writeFileSync(target, renderSchemaModule(fs.readFileSync(source, 'utf8')));
  console.log(`wrote ${target.pathname}`);
}

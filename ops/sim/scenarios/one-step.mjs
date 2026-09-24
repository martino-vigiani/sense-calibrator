// Partenze reali a un passo (worst 1.24, 30 sessioni PG), ripetute. Devono
// calibrare come prima: gate WS1 = pass rate entro 2 pp dalla baseline.
import { pgTemplates } from './_hooks.mjs';

export default { templates: () => pgTemplates(worst => Math.abs(worst - 1.24) < 0.01) };

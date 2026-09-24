// Partenze reali già centrate: le sessioni PG con worst iniziale < 1.2 (29),
// ripetute. Gate WS1: 0 comandi.
import { pgTemplates } from './_hooks.mjs';

export default { templates: () => pgTemplates(worst => worst < 1.2) };

// Utilità condivise dagli scenari WS1 (quick-safety). Solo simulatore.
import { gauss } from '../fake-dualsense.mjs';
import { cohort, loadSessions, templates, worstOf } from '../population.mjs';

export const LSB_PER_PCT = 127.5 / 100;

// Chiama fn(nth) quando il device riceve l'n-esimo comando `op` (begin,
// sample, end). Gli scenari "durante la passata k" si agganciano al k-esimo
// calibBegin invece che a un tempo fisso: la passata 2 non inizia sempre allo
// stesso istante, e non c'è in tutte le sessioni.
export function onCommand(dev, op, nth, fn) {
  const send = dev.sendFeatureReport.bind(dev);
  let seen = 0;
  dev.sendFeatureReport = (id, buf) => {
    const promise = send(id, buf);
    const isOp = id === 0x82 && buf[2] === 1 && ({ 1: 'begin', 2: 'end', 3: 'sample' })[buf[0]] === op;
    if (isOp && ++seen === nth) fn(nth);
    return promise;
  };
}

// Direzione uniforme, ampiezza in LSB.
export function polar(r2, magLsb) {
  const ang = r2() * 2 * Math.PI;
  return [magLsb * Math.cos(ang), magLsb * Math.sin(ang)];
}

// Template reali della coorte PG filtrati sul worst di partenza. Richiede la
// telemetria (gitignored): questi scenari girano solo in locale.
export function pgTemplates(filter) {
  const rows = cohort(loadSessions(), 'PG').filter(r => filter(worstOf(r.before)));
  return templates(rows);
}

export { gauss };

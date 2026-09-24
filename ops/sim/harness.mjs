// Collega il codice reale di js/calib a un DualSense virtuale: gli input report
// del fake passano da parseSticks alla sorgente degli stick, i comandi da DS5
// (js/ds5.js, invariato) al modello firmware. Nessuna estrazione di testo,
// nessuna patch: le varianti sono `params`.
import { DS5 } from '../../js/ds5.js';
import { parseSticks } from '../../js/calib/measure.js';
import { createStickSource } from '../../js/calib/sampling.js';
import { runQuick } from '../../js/calib/quick.js';

export function simClock(clock) {
  return {
    sleep: ms => new Promise(r => clock.setTimeout(r, ms)),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
}

// dev: FakeDualSense; meta: { board, fw }; params: override di QUICK_DEFAULTS.
export function makeSimInstance(clock, dev, meta, params = {}, { isCurrent, onProgress, log } = {}) {
  const source = createStickSource(clock.now);
  dev.oninputreport = event => {
    const sticks = parseSticks(event.reportId, event.data);
    if (sticks) source.push(sticks);
  };
  const controller = new DS5(dev, null);
  const logs = [];
  return {
    source,
    controller,
    logs,
    run: () => runQuick({
      controller,
      source,
      clock: simClock(clock),
      isCurrent,
      onProgress,
      log: log ?? (m => logs.push([clock.now(), m])),
      params,
      meta,
    }),
  };
}

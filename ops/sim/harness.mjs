// Collega il codice reale di js/calib a un DualSense virtuale: gli input report
// del fake passano da parseSticks alla sorgente degli stick, i comandi da DS5
// (js/ds5.js, invariato) al modello firmware. Nessuna estrazione di testo,
// nessuna patch: le varianti sono `params`.
import { DS5 } from '../../js/ds5.js';
import { parseSticks } from '../../js/calib/measure.js';
import { createStickSource, measureOffset, waitForStable } from '../../js/calib/sampling.js';
import { runQuick } from '../../js/calib/quick.js';

export function simClock(clock) {
  return {
    sleep: ms => new Promise(r => clock.setTimeout(r, ms)),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
}

// Strumentazione di sicurezza, identica nel comportamento: `sampler` avvolge le
// funzioni reali di sampling.js legate alla stessa sorgente e allo stesso
// orologio, e il controller conta i calibSample inviati quando l'ultima attesa
// di stabilità era scaduta (un campione "cieco"). Serve al gate WS1 "0
// calibSample dopo un timeout", sia sul codice nuovo sia sulla baseline.
function instrument(source, clock, controller) {
  const probe = { lastWait: null, samplesAfterTimeout: 0, waits: 0, timeouts: 0 };
  const sampler = {
    waitForStable: async opts => {
      const ok = await waitForStable(source, clock, opts);
      probe.lastWait = !!ok;
      probe.waits += 1;
      if (!ok) probe.timeouts += 1;
      return ok;
    },
    measureOffset: (ms, opts) => measureOffset(source, clock, ms, opts),
  };
  const wrapped = {
    calibBegin: () => controller.calibBegin(),
    calibSample: () => {
      if (probe.lastWait === false) probe.samplesAfterTimeout += 1;
      return controller.calibSample();
    },
    calibEnd: () => controller.calibEnd(),
  };
  return { probe, sampler, controller: wrapped };
}

// dev: FakeDualSense; meta: { board, fw }; params: override di QUICK_DEFAULTS.
// `source` opzionale: gli scenari di replug instradano sulla stessa sorgente i
// report di un secondo controller, come fa la pagina con il `sticks` globale.
export function makeSimInstance(clock, dev, meta, params = {}, { isCurrent, onProgress, log, source: given, runOpts = {} } = {}) {
  const source = given ?? createStickSource(clock.now);
  dev.oninputreport = event => {
    const sticks = parseSticks(event.reportId, event.data);
    if (sticks) source.push(sticks);
  };
  // Timeout delle risposte HID sull'orologio virtuale: con i timer reali un
  // run lento potrebbe scadere in tempo reale e avvelenare il controller.
  const controller = new DS5(dev, null, { timers: clock });
  const sclock = simClock(clock);
  const probe = instrument(source, sclock, controller);
  const logs = [];
  return {
    source,
    controller,
    logs,
    probe: probe.probe,
    run: () => runQuick({
      controller: probe.controller,
      source,
      clock: sclock,
      isCurrent,
      onProgress,
      log: log ?? (m => logs.push([clock.now(), m])),
      params,
      meta,
      sampler: probe.sampler,
      ...runOpts,
    }),
  };
}

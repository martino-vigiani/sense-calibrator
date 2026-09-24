// Controller A scollegato a metà passata (0.2–4 s dopo il primo calibBegin) e
// controller B collegato subito dopo, con i report di B instradati sulla stessa
// sorgente degli stick: è ciò che fa la pagina, dove `sticks` è globale.
// `isCurrent()` diventa falso come `ds5 === controller` in app.js.
// Gate WS1: 0 comandi a B; `committed` (→ unsaved) vero se e solo se A ha
// applicato almeno un calibEnd.
import { FakeDualSense } from '../fake-dualsense.mjs';
import { parseSticks } from '../../../js/calib/measure.js';
import { createStickSource } from '../../../js/calib/sampling.js';
import { onCommand } from './_hooks.mjs';

export default {
  setup({ clock, dev, spec, r2, pop, seed, i }) {
    const source = createStickSource(clock.now);
    let current = true;
    let B = null;
    const delay = 200 + r2() * 3800;
    onCommand(dev, 'begin', 1, () => {
      clock.setTimeout(() => {
        dev.unplug();
        current = false;
        B = new FakeDualSense({ clock, seed: seed * 104729 + i + 3, sticks: spec.sticks, fw: pop.fw, timing: pop.timing, name: 'Virtual DualSense B' });
        B.oninputreport = event => {
          const sticks = parseSticks(event.reportId, event.data);
          if (sticks) source.push(sticks);
        };
      }, delay);
    });
    return {
      source,
      isCurrent: () => current,
      report: () => {
        B?.close();
        return { replugged: B !== null, commandsB: B ? B.counts.begin + B.counts.sample + B.counts.end + B.counts.range + B.counts.other + B.counts.nvs : 0, calibEndsA: dev.calibEnds };
      },
    };
  },
};

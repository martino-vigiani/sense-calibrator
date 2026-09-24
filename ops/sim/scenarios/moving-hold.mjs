// Mano che si muove sullo stick durante la passata 1: offset 5–25 LSB più
// un'oscillazione di ampiezza σ 5–25 LSB e periodo 0.5–3 s, da 0–4 s dopo il
// primo calibBegin, per 2–10 s. Gate WS1: sessioni ≥15% ≤ baseline e 0
// calibSample dopo un timeout (strumentato in ops/sim/harness.mjs).
import { onCommand, polar } from './_hooks.mjs';

export default {
  setup({ clock, dev, r2 }) {
    const stick = r2() < 0.5 ? 0 : 1;
    const offset = polar(r2, 5 + r2() * 20);
    const sigma = 5 + r2() * 20;
    const period = 500 + r2() * 2500;
    const phase = [r2() * 2 * Math.PI, r2() * 2 * Math.PI];
    const delay = r2() * 4000;
    const dur = 2000 + r2() * 8000;
    let t0 = null;
    onCommand(dev, 'begin', 1, () => {
      t0 = clock.now() + delay;
      dev.touches.push({
        stick, t0, dur, tail: 150, amp: offset,
        at: (t, ax) => offset[ax] + sigma * Math.sin(2 * Math.PI * (t - t0) / period + phase[ax]),
      });
    });
    return { report: () => ({ holdAt: t0 }) };
  },
};

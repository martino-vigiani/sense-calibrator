// Mano tremante sullo stick durante la passata 1: offset 0–10 LSB più rumore
// gaussiano per report σ 5–25 LSB, da 0–4 s dopo il primo calibBegin, per
// 2–10 s. Il rumore usa un generatore proprio (non quello del modello).
import { gauss, onCommand, polar } from './_hooks.mjs';
import { rng } from '../fake-dualsense.mjs';

export default {
  setup({ clock, dev, r2 }) {
    const stick = r2() < 0.5 ? 0 : 1;
    const offset = polar(r2, r2() * 10);
    const sigma = 5 + r2() * 20;
    const delay = r2() * 4000;
    const dur = 2000 + r2() * 8000;
    const noise = rng(Math.floor(r2() * 2 ** 31));
    let t0 = null;
    onCommand(dev, 'begin', 1, () => {
      t0 = clock.now() + delay;
      dev.touches.push({ stick, t0, dur, tail: 150, amp: offset, at: (t, ax) => offset[ax] + sigma * gauss(noise) });
    });
    return { report: () => ({ holdAt: t0 }) };
  },
};

// Pollice premuto sul bordo durante la passata 2: spostamento costante (spread
// ~0, solo il rumore del sensore) al 60–100% in direzione casuale, a partire da
// 0–4 s dopo il secondo calibBegin, per 2–8 s. Le sessioni che si fermano alla
// passata 1 non lo vedono. Gate WS1: 0 sessioni ≥15%.
import { LSB_PER_PCT, onCommand, polar } from './_hooks.mjs';

export default {
  setup({ clock, dev, r2 }) {
    const stick = r2() < 0.5 ? 0 : 1;
    const amp = polar(r2, (60 + r2() * 40) * LSB_PER_PCT);
    const delay = r2() * 4000;
    const dur = 2000 + r2() * 6000;
    let t0 = null;
    onCommand(dev, 'begin', 2, () => {
      t0 = clock.now() + delay;
      dev.touches.push({ stick, t0, dur, tail: 150, amp });
    });
    return { report: () => ({ holdAt: t0 }) };
  },
};

// Sweep della copertura del range (WS7), model-verified: rotazioni sintetiche
// quantizzate a 8 bit come gli input report, con range memorizzato troppo
// stretto o troppo largo (`scale`), a varie frequenze di campionamento. Mette
// a confronto la regola di prima (settori da rAF, soglia sul massimo non
// limitato) con js/calib/range-coverage.js. Nessun dato reale, nessun HID.
//
//   node ops/sim/range-sweep.mjs
import { createStickRange, pushStick, stickCoverage } from '../../js/calib/range-coverage.js';

const q = v => (Math.max(0, Math.min(255, Math.round(v * 127.5 + 127.5))) - 127.5) / 127.5;
function* rotation({ rate, secPerTurn, scale }) {
  const n = Math.round(rate * secPerTurn);
  for (let k = 0; k <= n; k++) {
    const a = 2 * Math.PI * k / n;
    yield [q(scale * Math.cos(a)), q(scale * Math.sin(a))];
  }
}
function oldCoverage(points) {
  const bins = new Array(36).fill(0);
  for (const [x, y] of points) {
    const r = Math.hypot(x, y);
    const i = Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * 36) % 36;
    if (r > bins[i]) bins[i] = r;
  }
  const g = Math.max(...bins);
  return g < 0.5 ? 0 : bins.filter(v => v >= Math.max(0.6, g * 0.88)).length / 36;
}
function newCoverage(points) {
  const s = createStickRange();
  for (const [x, y] of points) pushStick(s, x, y);
  return stickCoverage(s);
}

console.log('Range coverage, one turn (model-verified; old = rAF-fed bins, unbounded max)');
console.log('scale  s/turn  rate   old   new');
for (const scale of [0.8, 1, 1.2, 1.3, 1.4]) {
  for (const secPerTurn of [0.3, 2]) {
    for (const rate of [60, 250]) {
      const pts = [...rotation({ rate, secPerTurn, scale })];
      console.log(`${scale.toFixed(1).padStart(5)}  ${secPerTurn.toFixed(1).padStart(6)}  ${String(rate).padStart(4)}  ${oldCoverage(pts).toFixed(2)}  ${newCoverage(pts).toFixed(2)}`);
    }
  }
}

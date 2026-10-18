// Errore di cattura persistente sulla X dello stick SINISTRO (BDM-040, ipotesi
// X1 di docs/hw-probe-bdm040.md; telemetria v2 del 18 ott 2026, solo aggregati).
// Il firmware scrive un centro spostato di B LSB verso +X rispetto a dove lo
// stick riposava durante i campioni: l'uscita dopo ogni passata legge circa −B,
// la Y esce esatta. Lo stick destro resta il modello normale.
//
// Cosa viene dagli aggregati (56 passate verificate in 10 visite colpite, valori
// di X dopo la passata in mezzi LSB): 7 entro ±1, il grosso tra −11 e −39
// (mediana ~−21 = 10.5 LSB), coda −47 e −75, un +128 (clamp, non modellato).
// Salti tra passate consecutive (mezzi LSB): 0 ×11, 2 ×8, 4 ×3, 6 ×4, 8, 10 e un
// 139. Prime passate ≥15%: 4/27 sessioni; passate successive: 1/29.
//
// Parametri (tarati sugli aggregati, nessun dato grezzo qui dentro):
//   sessione   B ~ 25% uniforme in ±ZERO_LSB, altrimenti lognormale con mediana
//              MEDIAN_LSB e sigma SIGMA, troncata a MAX_LSB (positivo = centro
//              catturato verso +X, uscita −B). Il 25% di sessioni a B≈0 dà il
//              ~11% di passate entro ±1 mezzo LSB (osservato 7/56): le sessioni
//              a B≈0 si fermano dopo 1–2 passate, quelle con errore ne fanno 3–4
//   passate    a ogni calibBegin successivo al primo B += salto: 0 con p 0.60,
//              piccolo ±0.5–3.5 LSB con p 0.37, grande con p 0.03 (±20–60 LSB,
//              il 139 mezzi-LSB osservato). Il centro del fake è media + B +
//              sf·gauss e la quantizzazione a 8 bit aggiunge scarto da sé: le
//              probabilità "none" e l'ampiezza sono quelle che riproducono lo
//              istogramma osservato dei salti (0 ≈ 35%, 1–2 mezzi LSB ≈ 36%,
//              3–6 ≈ 24%), non le probabilità nominali del modello senza rumore
// Misurato sul modello con questi parametri (714 sessioni BDM-040, seed 1,
// model-verified): mediana del grosso −21 mezzi LSB, coda ≤−47 il 3%, sessioni
// ≥15% ~17% (osservato 18.5%), con maxPasses 1 ~9% (modello di prova: 7%).
// La riga con i numeri completi sta in ops/sim/README.md.
//
// Usa solo r2, sempre nello stesso ordine e sempre tutti i numeri (anche quelli
// delle passate che non ci saranno): le sessioni restano appaiate con `normal`.
// Con la popolazione reale restano solo i template BDM-040; con quella
// sintetica tutti (CI non ha la telemetria).
import { gauss, onCommand } from './_hooks.mjs';

export const LEFT_X = {
  zeroP: 0.25,
  zeroLsb: 0.7,
  medianLsb: 10.5,
  sigma: 0.55,
  maxLsb: 40,
  jumpP: { none: 0.6, small: 0.37 }, // il resto è il salto grande (0.03)
  smallLsb: [0.5, 3.5],
  bigLsb: [20, 60],
  maxBegins: 10, // calibBegin per cui si pre-estraggono i salti (4 passate + recuperi)
};

// Estrae B iniziale e i salti dei calibBegin 2..maxBegins. Pura: testabile.
export function drawCapture(r2, p = LEFT_X) {
  const sign = () => (r2() < 0.5 ? -1 : 1);
  // sempre gli stessi tre numeri, qualunque ramo si prenda
  const u = r2(), a = r2(), g = gauss(r2);
  const b0 = u < p.zeroP ? (a * 2 - 1) * p.zeroLsb : Math.min(p.maxLsb, Math.exp(Math.log(p.medianLsb) + p.sigma * g));
  const jumps = [0];
  for (let n = 2; n <= p.maxBegins; n++) {
    const kind = r2(), mag = r2(), sg = sign();
    if (kind < p.jumpP.none) jumps.push(0);
    else if (kind < p.jumpP.none + p.jumpP.small) jumps.push(sg * (p.smallLsb[0] + mag * (p.smallLsb[1] - p.smallLsb[0])));
    else jumps.push(sg * (p.bigLsb[0] + mag * (p.bigLsb[1] - p.bigLsb[0])));
  }
  return { b0, jumps };
}

export default {
  templates: (tpls, { population } = {}) => (population === 'synthetic' ? tpls : tpls.filter(t => t.board === 'BDM-040')),
  // Nessun bias casuale sullo stick sinistro: lo porta solo lo scenario.
  apply(spec) { spec.sticks[0].bias = { axis: 0, B: 0 }; },
  setup({ dev, r2 }) {
    const { b0, jumps } = drawCapture(r2);
    let B = b0;
    dev.sticks[0].bias = { axis: 0, B };
    for (let n = 2; n <= LEFT_X.maxBegins; n++) {
      onCommand(dev, 'begin', n, () => { B += jumps[n - 1]; dev.sticks[0].bias = { axis: 0, B }; });
    }
    return {
      // residuo vero continuo (LSB, riposo − centro) dopo l'ultima calibEnd
      report: () => ({ b0, bFinal: B, left: dev.sticks[0].rest.map((v, a) => v - dev.sticks[0].center[a]) }),
    };
  },
};

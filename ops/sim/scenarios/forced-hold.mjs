// Mano ferma sullo stick durante la passata 1 (15–60 LSB, cioè 12–47%, da 2 a
// 6 s dall'inizio, per 1–6 s). È lo scenario 'hold' incorporato in run.mjs, con
// lo stesso uso del generatore: resta appaiato con le uscite baseline 'hold'
// (1.7% di sessioni finite ≥15% prima di WS1, model-verified).
export default { base: 'hold' };

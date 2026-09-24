// Orologio virtuale a eventi discreti: setTimeout/performance.now finti.
// Tra un evento e l'altro si svuota la coda microtask reale (setImmediate),
// così gli `await` del codice reale avanzano come nel browser.
export class VClock {
  constructor() { this.t = 0; this.heap = []; this.seq = 0; this.ids = new Map(); }
  now = () => this.t;
  setTimeout = (fn, ms = 0, ...args) => {
    const id = ++this.seq;
    const ev = { at: this.t + Math.max(0, ms), id, fn: () => fn(...args), live: true };
    this.ids.set(id, ev); this.push(ev); return id;
  };
  clearTimeout = id => { const ev = this.ids.get(id); if (ev) { ev.live = false; this.ids.delete(id); } };
  push(ev) { const h = this.heap; h.push(ev); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.lt(h[p], h[i])) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } }
  lt(a, b) { return a.at < b.at || (a.at === b.at && a.id < b.id); }
  pop() { const h = this.heap; if (!h.length) return null; const top = h[0]; const last = h.pop(); if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && this.lt(h[l], h[m])) m = l; if (r < h.length && this.lt(h[r], h[m])) m = r; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } } return top; }
  async run(promise, maxMs = 600000) {
    let done = false, val, err;
    promise.then(v => { done = true; val = v; }, e => { done = true; err = e; });
    const drain = () => new Promise(r => setImmediate(r));
    await drain();
    while (!done) {
      const ev = this.pop();
      if (!ev) throw new Error('deadlock: no timers and promise pending');
      if (!ev.live) continue;
      this.ids.delete(ev.id);
      this.t = ev.at;
      if (this.t > maxMs) throw new Error('virtual timeout');
      ev.fn();
      await drain();
    }
    if (err) throw err;
    return val;
  }
}

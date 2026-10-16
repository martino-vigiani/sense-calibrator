// Soglia prudenziale per avviare Quick, non una diagnosi di drift o di tocco.
// Policy iniziale: 15% radiale per stick, da validare su hardware. Non è una
// soglia ricavata dalle misure raccolte. Lascia margine al drift reale
// (soglie pubbliche 1.2% / 3.5%) ma esclude gli offset osservati 40–100%.
// Con (byte - 127.5) / 127.5, 1 LSB vale ~0.784%.
// Uno stick che riposa davvero oltre questa soglia richiede il percorso guidato.
export const QUICK_CENTER_RADIUS = 0.15;
export const QUICK_CENTER_HOLD_MS = 300;
export const QUICK_CENTER_MAX_GAP_MS = 100;

export function sticksWithinQuickCenter(sticks) {
  return ['lx', 'ly', 'rx', 'ry'].every(axis => Number.isFinite(sticks?.[axis]))
    && Math.hypot(sticks.lx, sticks.ly) <= QUICK_CENTER_RADIUS
    && Math.hypot(sticks.rx, sticks.ry) <= QUICK_CENTER_RADIUS;
}

// Solo report nuovi contano: una pausa HID non dimostra che lo stick sia
// rimasto centrato. Il chiamante gestisce timeout e rimozione del listener.
//
// Due report con lo STESSO tempo (event.timeStamp arrotondato: raffiche reali)
// non sono un salto all'indietro: prima `now <= previous` azzerava la tenuta,
// e con un doppio ogni ≤250 ms Quick non partiva mai (model-verified). Un
// duplicato ora non azzera e non conta: servono comunque ≥10 report a tempi
// distinti, e non allunga la durata. Fuori raggio azzera sempre, duplicato o
// no; il tempo che torna indietro o un buco oltre 100 ms azzerano ancora.
export function createQuickCenterHold() {
  let since = null;
  let previous = null;
  let count = 0;
  return (sticks, now) => {
    if (!Number.isFinite(now) || !sticksWithinQuickCenter(sticks)) {
      since = previous = null;
      count = 0;
      return false;
    }
    if (previous !== null && now === previous) return count >= 10 && now - since >= QUICK_CENTER_HOLD_MS;
    if (previous === null || now < previous || now - previous > QUICK_CENTER_MAX_GAP_MS) {
      since = now;
      count = 0;
    }
    previous = now;
    count += 1;
    return count >= 10 && now - since >= QUICK_CENTER_HOLD_MS;
  };
}

// Oltre questo silenzio dall'ultimo report il controller è considerato muto.
const PROBE_SILENT_MS = 250;

// Diagnosi di una preflight Quick fallita: PERCHÉ la tenuta non passa.
// Solo osservativa: non decide e non allarga nulla, la decisione resta a
// createQuickCenterHold e al gate di stabilità di waitForStable. Serve a dire
// all'utente la causa e a instradarlo (telemetria v2, 27/9–12/10: 241 preflight
// su 250 scadono sulla prima attesa; circa metà su stick che nella stessa
// visita riposano oltre il 15%, gli altri su stick che riposano centrati).
//
//   'no-input'   meno di 10 report o nessun report fresco: cavo, tab, controller muto
//   'off-center' gli stick sono fermi (spread ≤ `spread` per `holdMs` di report
//                continui) ma uno legge oltre il raggio: o riposa lì o un pollice
//                lo tiene fermo; i due casi sono indistinguibili da qui
//   'settled'    fermi e centrati: la tenuta è passata, l'arresto viene da
//                altro (buco nei report durante la baseline, scollegamento)
//   'gaps'       i report arrivano, ma un buco oltre `maxGapMs` ha azzerato la
//                finestra, non ci sono ancora `holdMs` continui da giudicare e
//                l'ultima finestra giudicata (se c'è) era ferma e centrata:
//                nulla indica una mano, quindi non la si nomina
//   'moving'     tutto il resto: il segnale non resta fermo per `holdMs`
//
// `push` va chiamato su ogni input report HID (mai su un timer) con il tempo
// del report. `stillOffMs(now)` dice da quanto dura, senza interruzioni, lo
// stato 'off-center'.
export function createQuickPreflightProbe({ spread, holdMs = QUICK_CENTER_HOLD_MS, maxGapMs = QUICK_CENTER_MAX_GAP_MS } = {}) {
  const win = [];
  let reports = 0;
  let last = null;
  let continuousStart = null;
  let offSince = null;
  let offWindow = null;
  let settled = false;
  // `evaluated`: l'ultimo report aveva `holdMs` continui da giudicare;
  // `gapped`: almeno un buco ha azzerato la finestra; `lastJudged`: l'esito
  // dell'ultima finestra giudicata ('moving' | 'off' | 'settled' | null).
  let evaluated = false;
  let gapped = false;
  let lastJudged = null;
  const axes = ['lx', 'ly', 'rx', 'ry'];
  return {
    push(sticks, now) {
      if (!Number.isFinite(now) || !axes.every(a => Number.isFinite(sticks?.[a]))) return;
      if (last !== null && (now < last || now - last > maxGapMs)) {
        win.length = 0;
        continuousStart = null;
        offSince = null;
        settled = false;
        gapped = true;
      }
      reports += 1;
      last = now;
      if (continuousStart === null) continuousStart = now;
      win.push({ ...sticks, t: now });
      while (win.length && win[0].t < now - holdMs) win.shift();
      let off = false;
      settled = false;
      // ≥10 report a tempi distinti, come la tenuta: un duplicato (stesso
      // timeStamp) entra nella finestra ma non conta come report nuovo.
      let distinct = 0;
      for (let i = 0; i < win.length; i++) if (i === 0 || win[i].t !== win[i - 1].t) distinct += 1;
      evaluated = distinct >= 10 && now - continuousStart >= holdMs;
      if (evaluated) {
        const stats = {};
        let maxSpread = 0;
        for (const a of axes) {
          let min = Infinity, max = -Infinity, sum = 0;
          for (const s of win) {
            if (s[a] < min) min = s[a];
            if (s[a] > max) max = s[a];
            sum += s[a];
          }
          stats[a] = { mean: sum / win.length, spread: max - min };
          maxSpread = Math.max(maxSpread, max - min);
        }
        // Fuori raggio con la stessa regola per report della guardia: basta un
        // report fuori nella finestra ferma (uno stick a cavallo del 15%).
        const outsideL = win.some(s => Math.hypot(s.lx, s.ly) > QUICK_CENTER_RADIUS);
        const outsideR = win.some(s => Math.hypot(s.rx, s.ry) > QUICK_CENTER_RADIUS);
        settled = maxSpread <= spread && !outsideL && !outsideR;
        lastJudged = maxSpread > spread ? 'moving' : settled ? 'settled' : 'off';
        if (maxSpread <= spread && (outsideL || outsideR)) {
          off = true;
          const stick = (x, y) => ({
            offset: Math.hypot(stats[x].mean, stats[y].mean) * 100,
            x: stats[x].mean,
            y: stats[y].mean,
            noise: Math.max(stats[x].spread, stats[y].spread) * 100,
          });
          const left = stick('lx', 'ly');
          const right = stick('rx', 'ry');
          // Lo stick fuori raggio; se lo sono entrambi, il più lontano.
          const side = outsideL && outsideR ? (left.offset >= right.offset ? 'left' : 'right') : outsideL ? 'left' : 'right';
          offWindow = { left, right, side };
        }
      }
      if (off) offSince ??= now;
      else { offSince = null; offWindow = null; }
    },
    stillOffMs(now) {
      return offSince === null || !Number.isFinite(now) ? 0 : Math.max(0, now - offSince);
    },
    // { reason, side?, offset?, result? }: `result` ha la forma di analyzeDrift
    // ({ left, right } con offset e noise in %, x/y normalizzati) per il
    // routing della pagina. `now` serve a riconoscere un controller muto: deve
    // essere l'ora corrente (source.now()), non il tempo dell'ultimo report,
    // che resta fermo quando i report si fermano e non scade mai.
    status(now) {
      if (reports < 10 || last === null || !Number.isFinite(now) || now - last > PROBE_SILENT_MS) return { reason: 'no-input' };
      if (offSince !== null && offWindow) {
        const { left, right, side } = offWindow;
        return { reason: 'off-center', side, offset: offWindow[side].offset, result: { left, right, unstable: false } };
      }
      // Dopo un buco, finché non c'è una finestra intera, vale l'ultima
      // finestra giudicata: se si muoveva (o era ferma fuori raggio) resta
      // 'moving' come prima; 'gaps' solo se nulla ha mostrato una mano.
      if (!evaluated && gapped && (lastJudged === null || lastJudged === 'settled')) return { reason: 'gaps' };
      return { reason: settled ? 'settled' : 'moving' };
    },
  };
}

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
    if (previous === null || now <= previous || now - previous > QUICK_CENTER_MAX_GAP_MS) {
      since = now;
      count = 0;
    }
    previous = now;
    count += 1;
    return count >= 10 && now - since >= QUICK_CENTER_HOLD_MS;
  };
}

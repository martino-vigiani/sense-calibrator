'use strict';

// Testo del riquadro "contatto instabile" (#contact-fault) dai riscontri di
// js/calib/contact-fault.js. Puro: restituisce HTML con soli numeri e testi
// fissi, niente input dell'utente. Descrive la misura e cosa conviene fare;
// non è un verdetto validato su una popolazione (vedi il modulo di calcolo).

const STICK = { left: 'Left', right: 'Right' };
const AXIS = { x: 'horizontal', y: 'vertical' };

// Deadzone consigliata: la distanza massima dal centro vista durante i salti,
// arrotondata per eccesso, più un punto di margine (4,7% → 6%). Senza `maxPct`
// (riscontri vecchi) si ripiega sull'escursione.
export function deadzoneFor(pct) {
  return Math.ceil(pct) + 1;
}
const reachPct = f => (Number.isFinite(f.maxPct) ? Math.max(f.maxPct, f.spanPct) : f.spanPct);

function line(f) {
  return `<p>${STICK[f.stick]} stick, ${AXIS[f.axis]} axis: with the stick untouched, the reading jumped back and forth between two levels about ${f.jumpLsb} steps apart (${f.jumps} jumps, up to ${f.spanPct}% of travel), while the other axis stayed still.</p>`;
}

export function contactFaultView(findings) {
  if (!findings?.length) return null;
  const one = findings.length === 1;
  const title = one
    ? `${STICK[findings[0].stick]} stick: the ${AXIS[findings[0].axis]} axis jumps on its own`
    : 'Unstable stick contacts';
  const dz = deadzoneFor(Math.max(...findings.map(reachPct)));
  const where = one ? 'this stick' : 'these sticks';
  const html = `<h4 class="contact-fault-title">${title}</h4>`
    + findings.map(line).join('')
    + '<p>Drift slides gradually; this jumps. That pattern usually means a dirty or worn contact inside the stick’s potentiometer. Calibration sets the center, so it can’t stop these jumps.</p>'
    + '<ul class="contact-fault-steps">'
    + `<li>Set a deadzone of at least ${dz}% on ${where} in your games, or in Steam Input on a PC.</li>`
    + '<li>Cleaning the stick’s potentiometer with contact cleaner can help for a while.</li>'
    + '<li>The lasting fix is replacing the stick module, which is soldered to the board: a job for a repair shop.</li>'
    + '</ul>'
    + '<p class="contact-fault-note">Measured from the controller’s own readings while it was connected and untouched. The jumps come and go, so they may not show in every test.</p>';
  return { title, html, deadzone: dz };
}

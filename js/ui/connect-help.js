'use strict';

// Testo per una connessione che non va: selettore vuoto (o chiuso senza
// scegliere) e apertura fallita. Puro, senza DOM.
//
// Il selettore di Chrome mostra solo il DualSense standard (054C:0CE6): un
// cavo solo di ricarica, un DualSense Edge o un DS4 producono un selettore
// vuoto, e prima la pagina restava muta. Le cause elencate sono quelle
// plausibili, non diagnosticate: il browser non dice perché la lista è vuota.

export const CONNECT_CHECKLIST = Object.freeze([
  'Use a USB data cable. Many cables only charge and never show the controller.',
  'Only the standard PS5 DualSense works. DualSense Edge and PS4 controllers aren’t supported.',
  'Try another USB port, ideally one directly on the computer rather than a hub.',
  'Close apps that may be holding the controller, such as Steam or DS4Windows, and other tabs with this page open.',
  'On Linux, the browser needs permission to open the controller: add a udev rule for its hidraw device, then replug it.',
]);

// Errori di WebHID tradotti. `name` è quello della DOMException.
export function connectErrorCopy(error) {
  const name = error?.name ?? '';
  const raw = String(error?.message || error || '').slice(0, 160);
  if (name === 'NotAllowedError') {
    return {
      title: 'The browser wasn’t allowed to open the controller.',
      detail: 'Another app or tab may be using it, or (on Linux) your user may not have permission to open it.',
      raw,
    };
  }
  if (name === 'NetworkError' || /failed to open/i.test(raw)) {
    return {
      title: 'The controller couldn’t be opened.',
      detail: 'It may be busy in another app or tab, or the connection dropped. Unplug it, plug it back in and try again.',
      raw,
    };
  }
  if (name === 'SecurityError') {
    return {
      title: 'The browser blocked access to USB devices on this page.',
      detail: 'Open the page directly in Chrome or Edge (not inside another site or app), then try again.',
      raw,
    };
  }
  if (name === 'InvalidStateError') {
    return {
      title: 'The controller was disconnected while opening.',
      detail: 'Check the cable, plug it back in and try again.',
      raw,
    };
  }
  return { title: 'Connection failed.', detail: 'Unplug the controller, plug it back in and try again.', raw };
}

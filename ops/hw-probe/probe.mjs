'use strict';

// Collegamento DOM del probe R1. Solo UI: le regole stanno in safety.mjs, il
// protocollo in protocol.mjs.
//
// La cartella ops/ viene pubblicata da GitHub Pages insieme al sito, quindi il
// controllo dell'host è la PRIMA cosa: fuori da localhost la pagina non carica
// nemmeno il codice che parla al controller (import dinamico dopo il
// controllo) e non mostra alcun pulsante.

import { isLocalProbeHost } from './safety.mjs';

const $ = id => document.getElementById(id);

async function main() {
  if (!isLocalProbeHost(location.hostname)) {
    $('refused').textContent = 'This research page only runs on localhost. It is not part of Sense Calibrator.';
    $('refused').hidden = false;
    return;
  }
  if (!('hid' in navigator)) {
    $('refused').textContent = 'WebHID is not available: use desktop Chrome or Edge on http://localhost.';
    $('refused').hidden = false;
    return;
  }

  const [{ DS5, HID_FILTERS }, { parseSticks }, { createStickSource }, { createProbe }] = await Promise.all([
    import('../../js/ds5.js'),
    import('../../js/calib/measure.js'),
    import('../../js/calib/sampling.js'),
    import('./protocol.mjs'),
  ]);

  $('probe').hidden = false;
  const logEl = $('log');
  const log = msg => {
    logEl.textContent += `${new Date().toISOString().slice(11, 23)}  ${msg}\n`;
    logEl.scrollTop = logEl.scrollHeight;
  };
  const clock = {
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: id => clearTimeout(id),
  };
  // Conferma per passo con il dialogo nativo: una scelta esplicita a ogni
  // scrittura, non un'impostazione ricordata.
  const probe = createProbe({ hostname: location.hostname, clock, confirm: async (step, text) => window.confirm(text), log });

  let device = null;
  let ds5 = null;
  // Un'operazione alla volta: il flag si alza PRIMA di qualunque await.
  let busy = false;

  const stepButtons = [...document.querySelectorAll('[data-step]')];
  function refresh() {
    const connected = !!ds5 && device?.opened;
    $('connect').disabled = busy;
    $('arm').disabled = busy || !connected;
    for (const b of stepButtons) b.disabled = busy || !connected || (b.hasAttribute('data-write') && !probe.armed());
    $('arm-status').textContent = probe.armed()
      ? `Armed for connection ${probe.connectionId}. A reconnect disarms.`
      : 'Disarmed. Read-only steps only.';
    const ev = probe.evaluate();
    $('evaluation').textContent = JSON.stringify({ readbackRestore: ev.readbackRestore, subLsbNudge: ev.subLsbNudge, sampleCut: ev.sampleCut, verdict: ev.verdict, reasons: ev.reasons }, null, 2);
    $('record').textContent = JSON.stringify(probe.record, null, 2);
    $('download').disabled = probe.record.steps.length === 0;
  }

  function onInput(source) {
    return event => {
      const sticks = parseSticks(event.reportId, event.data);
      if (!sticks) return;
      source.push(sticks);
      const bytes = [0, 1, 2, 3].map(i => event.data.getUint8(i));
      $('sticks').textContent = `LX ${bytes[0]}  LY ${bytes[1]}  RX ${bytes[2]}  RY ${bytes[3]}`;
    };
  }

  $('connect').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    refresh();
    try {
      const [picked] = await navigator.hid.requestDevice({ filters: HID_FILTERS });
      if (!picked) return;
      if (!picked.opened) await picked.open();
      const next = new DS5(picked, log);
      if (next.isBluetooth()) {
        $('conn-status').textContent = 'Bluetooth detected: connect the controller over USB.';
        return;
      }
      const info = await next.getInfo();
      const source = createStickSource(() => performance.now());
      picked.oninputreport = onInput(source);
      device = picked;
      ds5 = next;
      // Il seriale serve solo a riconoscere lo stesso controller dopo lo
      // spegnimento (H-f): resta in memoria, non entra nel diario.
      const id = probe.attach({ ds5, source, info, identity: info.serial ?? null });
      $('conn-status').textContent = `Connection ${id}: ${info.board ?? 'unknown board'}, firmware 0x${(info.fwversion ?? 0).toString(16)}, built ${info.buildDate ?? '?'}. Run the preflight.`;
      $('spare').checked = false;
      $('phrase').value = '';
    } catch (error) {
      $('conn-status').textContent = `Connection failed: ${error.message}`;
    } finally {
      busy = false;
      refresh();
    }
  });

  $('arm').addEventListener('click', () => {
    const ok = probe.armWith({ spareChecked: $('spare').checked, phrase: $('phrase').value });
    refresh();
    // Dopo refresh, che riscrive lo stato generico.
    if (!ok) $('arm-status').textContent = 'Not armed: tick the box and type SPARE.';
  });

  for (const button of stepButtons) {
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      refresh();
      const step = button.dataset.step;
      $('step-status').textContent = `${step}: running, hands off the sticks…`;
      try {
        const opts = step === 'AB' ? { reps: Math.max(1, Math.min(10, Number($('ab-reps').value) || 5)) } : {};
        const entry = await probe.run(step, opts);
        $('step-status').textContent = entry.ok ? `${step}: done.` : `${step}: stopped. ${entry.error}`;
        if (step === 'H-f-prepare' && entry.ok)
          $('step-status').textContent += ' Now turn the controller off (hold PS for 10 s), turn it on, reconnect, run the preflight, then H-f (2).';
      } finally {
        busy = false;
        refresh();
      }
    });
  }

  $('download').addEventListener('click', () => {
    const blob = new Blob([probe.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hw-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  navigator.hid.addEventListener('disconnect', event => {
    if (event.device !== device) return;
    device = null;
    ds5 = null;
    $('conn-status').textContent = 'Disconnected. Reconnect to continue (writes need a new arming).';
    $('sticks').textContent = '–';
    refresh();
  });

  refresh();
}

main();

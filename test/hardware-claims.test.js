// H10 (una power-off senza Write riporta alla calibrazione salvata?) non è
// ancora verificato sull'hardware: nessun testo pubblicato lo presenta come un
// fatto. CHANGELOG e docs/hardware-checks.md dicono che il testo lo attenua
// ("should"); questo test tiene vera quella frase.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { POWER_OFF_ADVICE } from '../js/ui/outcome.js';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const UNHEDGED = [
  /powering the controller off first discards/i,
  /restores the previous calibration/i,
  /the temporary calibration is discarded/i,
  /that discards the temporary calibration/i,
  /It is discarded when the controller powers off/i,
  /to discard it\./i,
];

test('the power-off advice (H10, unverified) is hedged everywhere it is published', () => {
  assert.match(POWER_OFF_ADVICE, /should discard/);
  for (const file of ['index.html', 'README.md', 'guides/calibrate-dualsense-controller/index.html', 'js/app.js', 'js/ui/outcome.js']) {
    const text = read(file);
    for (const re of UNHEDGED) assert.doesNotMatch(text, re, `${file}: ${re}`);
  }
  assert.match(read('CHANGELOG.md'), /H10\) says the temporary calibration "should" be discarded/);
});

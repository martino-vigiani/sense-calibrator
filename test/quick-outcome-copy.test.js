import test from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_CATASTROPHIC_PCT, classifyOutcome } from '../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../js/calib/quick.js';
import { quickOutcomeLog, quickOutcomeToast } from '../js/calib/quick-outcome-copy.js';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

// Regola H4 / piano §4.2: con l'ultima passata a 15% o più l'esito non è mai un
// successo. Il testo è provvisorio (WS5 lo riscrive), la regola no.
const SUCCESS = /\b(complete|completed|success|successful|done|fixed)\b/i;
const OUTCOMES = ['catastrophic', 'worse-than-start', 'lost-ground', 'worn', 'unstable', 'residual-deterministic', 'within-1-step', 'residual', 'centered', 'some-future-outcome'];
const NV = ['locked', 'unlocked', 'pending_reboot', null];

test('no outcome at 15% or more renders success copy, whatever the label', () => {
  for (const outcome of OUTCOMES) {
    for (const worst of [QUICK_CATASTROPHIC_PCT, 15.4, 31, 100]) {
      for (const nvStatus of NV) {
        const [text, ms] = quickOutcomeToast({ outcome, worst, beforeWorst: 3.55, bestWorst: 3.55, nvStatus });
        assert.doesNotMatch(text, SUCCESS, `${outcome} @ ${worst}: ${text}`);
        assert.match(text, /Don’t write this calibration to memory/, `${outcome} @ ${worst}`);
        assert.ok(ms >= 10000, 'the warning stays on screen long enough to read');
        assert.doesNotMatch(text, /unplug/i, 'unplug advice waits for H11');
      }
      assert.doesNotMatch(quickOutcomeLog({ outcome, worst }), SUCCESS);
    }
  }
});

test('the real runaway [100,100] from 3.55 is classified catastrophic and never told "complete"', () => {
  const passes = [100, 100];
  const outcome = classifyOutcome({ worst: 100, beforeWorst: 3.55, bestWorst: 3.55, maxNoise: 0.1, unstableEvents: 0, passes }, QUICK_DEFAULTS);
  assert.equal(outcome, 'catastrophic');
  const [text] = quickOutcomeToast({ outcome, worst: 100, beforeWorst: 3.55, bestWorst: 3.55, nvStatus: 'locked' });
  assert.equal(text, 'The last pass ended at 100.0% (it started at 3.5%): a stick was likely held or moved. Don’t write this calibration to memory. Turn the controller off (hold PS for 10 s), then try again with both sticks released, or use guided calibration.');
});

test('power-off advice appears only when the NVS is confirmed locked (C0-11)', () => {
  for (const nvStatus of ['unlocked', 'pending_reboot', null]) {
    const [text] = quickOutcomeToast({ outcome: 'catastrophic', worst: 40, beforeWorst: null, nvStatus });
    assert.doesNotMatch(text, /turn the controller off|hold PS/i, String(nvStatus));
    assert.doesNotMatch(text, /started at/, 'no start value when it is unknown');
  }
});

test('the new sub-15% outcomes have their own text, and worse-than-start still warns', () => {
  const within = quickOutcomeToast({ outcome: 'within-1-step', worst: 1.24 })[0];
  assert.match(within, /within one calibration step/);
  const det = quickOutcomeToast({ outcome: 'residual-deterministic', worst: 2.2 })[0];
  assert.match(det, /guided calibration/);
  const worse = quickOutcomeToast({ outcome: 'worse-than-start', worst: 2, beforeWorst: 0.555 })[0];
  assert.match(worse, /worse than the starting point \(2\.0% against 0\.6%\)/);
  assert.doesNotMatch(worse, SUCCESS);
  assert.equal(quickOutcomeToast({ outcome: 'centered', worst: 0.555 })[0], 'Quick calibration complete.');
});

test('in the page, a runaway pass ends with the do-not-save warning, not "complete"', async () => {
  // Bias persistente di 40 LSB (~31%) sullo stick sinistro: la partenza è
  // centrata (preflight ok), la prima passata verificata va oltre il 15%.
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[0.2, -0.3], [-0.1, 0.4]], sf: 0 });
  dev.sticks[0].bias = { axis: 0, B: 40 };
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));

  assert.equal(dev.counts.end, 1, 'the catastrophic stop commits no further pass');
  const quick = h.sessions().filter(s => s.kind === 'quick').at(-1);
  assert.ok(quick.passes.at(-1) >= QUICK_CATASTROPHIC_PCT, `last pass ${quick.passes.at(-1)}`);
  const last = h.toasts().at(-1);
  assert.doesNotMatch(last, SUCCESS, last);
  assert.match(last, /Don’t write this calibration to memory/);
  assert.match(last, /hold PS for 10 s/, 'the virtual controller reports a locked NVS');
  assert.equal(h.peek().unsaved, true, 'the RAM changed: the unsaved state stays honest');
  assert.equal(h.peek().busy, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_TABLE, TIER_OVERRIDES, tierForOffset } from '../js/calib/lattice.js';
import { QUICK_CATASTROPHIC_PCT, classifyOutcome } from '../js/calib/quick-policy.js';
import { QUICK_DEFAULTS } from '../js/calib/quick.js';
import {
  FIX_RATE, FIX_RATE_WORDS, LOCK_REASONS, REPAIR_STEPS, UNPLUG_UNKNOWN, describeTier, driftMessage, flashSummary,
  guidedOutcomeView, outcomeHtml, outcomeLogLine, pinnedFromSummary, powerCycleReminderView, quickOutcomeView, quickPreflightRoute, rangeOutcomeView, render,
  revertAdvice, stickRows, writeLockFor,
} from '../js/ui/outcome.js';
import { replayOutcomes } from '../ops/sim/replay-telemetry.mjs';
import { loadApp, makeDevice } from './helpers/app-harness.mjs';
import { VClock } from '../ops/sim/vclock.mjs';

// Regola H4 / piano §4.2: con l'ultima passata a 15% o più l'esito non è mai un
// successo e Write è disabilitato, qualunque sia l'etichetta.
const SUCCESS = /\b(complete|completed|success|successful|done|fixed)\b/i;
const OUTCOMES = ['catastrophic', 'moved', 'worse-than-start', 'lost-ground', 'worn', 'unstable', 'residual-deterministic', 'within-1-step', 'residual', 'centered', 'unverified', 'some-future-outcome'];
const NV = ['locked', 'unlocked', 'pending_reboot', 'poisoned', null];
const textOf = view => [view.title, ...view.lines, ...view.actions.map(a => a.label)].join(' ');
// "Scollega" compare solo nella frase che dice che non è verificato (H11).
const withoutUnplugCaveat = text => text.split(UNPLUG_UNKNOWN).join('');
const summary = (off, { noise = [0.2, 0.2], xy = null } = {}) => ({
  off,
  noise,
  xy: xy ?? off.map(o => [o, 0]),
});

test('B1: a worsened stick below the starting worst is a named caution, not a worse-than-start result', () => {
  const before = summary([9.03, 0.555]);
  const after = summary([0.555, 2]);
  for (const view of [
    quickOutcomeView({ outcome: 'residual', worst: 2, beforeWorst: 9.03, bestWorst: 2,
      committed: true, session: { before, after } }),
    guidedOutcomeView({ before, after, committed: true }),
  ]) {
    assert.equal(view.outcome, 'residual');
    assert.equal(writeLockFor({ center: view.center }).mode, 'guarded');
    assert.ok(writeLockFor({ center: view.center }).reasons.some(r => r.code === 'stick-worse'));
    assert.match(textOf(view), /Per-stick change: right stick 0\.6%.* → 2\.0%/i);
    assert.doesNotMatch(textOf(view), /Worse than when you started|Don’t write this to memory/);
  }
});

test('N4: a failed Range that may be open requires a power cycle before retry', () => {
  const failed = rangeOutcomeView({ error: new Error('lost reply'), leftOpen: true });
  assert.match(textOf(failed), /turn the controller off \(hold PS for 10 s\) before trying again/i);
  assert.equal(writeLockFor({ range: failed.range }).mode, 'disabled');
});

test('N3: a reload preserves a guarded center lock as guarded', () => {
  const lock = writeLockFor({ centerReload: 'guarded' });
  assert.equal(lock.mode, 'guarded');
  assert.equal(lock.reasons[0].code, 'center-reload-guarded');
});

test('audit 11: a centered Guided result still names a worsened axis before saving', () => {
  const before = summary([1.6, 0.555], { xy: [[1.6, 0], [0.555, 0]] });
  const after = summary([1.1, 0.555], { xy: [[0, 1.1], [0.555, 0]] });
  for (const view of [
    guidedOutcomeView({ before, after }),
    quickOutcomeView({ outcome: 'centered', worst: 1.1, beforeWorst: 1.6, bestWorst: 1.1,
      committed: true, session: { before, after } }),
  ]) {
    assert.equal(view.outcome, 'centered');
    assert.equal(writeLockFor({ center: view.center }).mode, 'guarded');
    assert.match(textOf(view), /left Y axis moved further from center/i);
    assert.doesNotMatch(textOf(view), /Write it to memory to keep it/);
  }
});

test('no quick outcome at 15% or more reads as success, and Write is disabled', () => {
  for (const outcome of OUTCOMES) {
    for (const worst of [QUICK_CATASTROPHIC_PCT, 15.4, 31, 100]) {
      for (const nvStatus of NV) {
        const view = quickOutcomeView({ outcome, worst, beforeWorst: 3.55, bestWorst: 3.55, committed: true }, { nvStatus });
        const text = textOf(view);
        assert.doesNotMatch(text, SUCCESS, `${outcome} @ ${worst}: ${text}`);
        assert.equal(view.title, 'Don’t save this result', `${outcome} @ ${worst}`);
        assert.equal(view.tone, 'bad');
        assert.equal(writeLockFor({ center: view.center }).mode, 'disabled', `${outcome} @ ${worst}`);
        assert.doesNotMatch(withoutUnplugCaveat(text), /unplug/i, 'unplug advice waits for H11');
      }
      assert.doesNotMatch(outcomeLogLine({ outcome, worst }), SUCCESS);
    }
  }
});

test('the real runaway [100,100] from 3.55 is catastrophic, disables Write and offers only opt-in recovery', () => {
  const passes = [100, 100];
  const outcome = classifyOutcome({ worst: 100, beforeWorst: 3.55, bestWorst: 3.55, maxNoise: 0.1, unstableEvents: 0, passes }, QUICK_DEFAULTS);
  assert.equal(outcome, 'catastrophic');
  const view = quickOutcomeView({ outcome, worst: 100, beforeWorst: 3.55, bestWorst: 3.55, committed: true }, { nvStatus: 'locked' });
  assert.match(view.lines[0], /^The last pass ended at 100\.0% \(it started at 3\.5%\)/);
  assert.match(view.lines[1], /Turn the controller off \(hold PS for 10 s\)/);
  assert.deepEqual(view.actions.map(a => a.id), ['guided', 'recovery'], 'Guided first; recovery only if the user asks');
  const lock = writeLockFor({ center: view.center });
  assert.equal(lock.mode, 'disabled');
  assert.equal(lock.reasons[0].code, 'catastrophic');
});

test('power-off advice appears only when the NVS is confirmed locked (C0-11), never as "unplug"', () => {
  assert.match(revertAdvice('locked'), /hold PS for 10 s/);
  assert.match(revertAdvice('locked'), /haven’t confirmed whether unplugging/);
  for (const nvStatus of ['unlocked', 'pending_reboot', 'poisoned', null, undefined]) {
    assert.equal(revertAdvice(nvStatus), null);
    for (const outcome of ['catastrophic', 'worse-than-start', 'lost-ground']) {
      const view = quickOutcomeView({ outcome, worst: outcome === 'catastrophic' ? 40 : 3, beforeWorst: outcome === 'catastrophic' ? null : 1.24, bestWorst: 1.24 }, { nvStatus });
      assert.doesNotMatch(textOf(view), /turn the controller off|hold PS/i, `${outcome} / ${nvStatus}`);
      assert.doesNotMatch(textOf(view), /unplug/i);
    }
  }
  const unknownStart = quickOutcomeView({ outcome: 'catastrophic', worst: 40, beforeWorst: null }, {});
  assert.doesNotMatch(textOf(unknownStart), /started at/, 'no start value when it is unknown');
});

// Un caso per riga di GRID_TABLE (piano WS5, accettazione): livello, parole,
// esito di fine sessione, blocco di Write e messaggio del test drift.
const ROW_CASES = {
  centered: { off: 0.555, outcome: 'centered', tone: 'ok', lock: 'allowed', drift: /correctly centered/, route: null },
  'within-1-step': { off: 1.24, outcome: 'within-1-step', tone: 'ok', lock: 'allowed', drift: /Within 1 step of center/, route: null },
  mild: { off: 2.2, outcome: 'residual', tone: 'warn', lock: 'allowed', drift: /Mild drift detected\. Quick calibration usually fixes this: about 3 in 4/, route: 'quick' },
  marked: { off: 6.7, outcome: 'residual', tone: 'warn', lock: 'allowed', drift: /Marked drift detected\. Start with Quick/, route: 'quick-then-guided' },
  'guided-only': { off: 22, outcome: 'catastrophic', tone: 'bad', lock: 'disabled', drift: /Severe offset \(22\.0%\).*Use Guided calibration/, route: 'guided' },
};

test('every GRID_TABLE row maps to words, an outcome, a Write lock and a drift message', () => {
  assert.deepEqual(Object.keys(ROW_CASES).sort(), GRID_TABLE.map(r => r.id).sort(), 'one case per table row');
  for (const row of GRID_TABLE) {
    const c = ROW_CASES[row.id];
    assert.equal(tierForOffset(c.off).id, row.id, `${row.id}: sample offset lies in the row`);
    const words = describeTier(row.id);
    assert.ok(words.headline && words.advice, row.id);
    assert.equal(words.recommendation, row.recommendation, 'the recommendation key comes from the table');

    // Fine sessione: da 8% al valore della riga.
    const facts = { worst: c.off, beforeWorst: 8, bestWorst: Math.min(8, c.off), maxNoise: 0.2, unstableEvents: 0, passes: [c.off] };
    const outcome = classifyOutcome(facts, QUICK_DEFAULTS);
    assert.equal(outcome, c.outcome, row.id);
    const after = summary([c.off, 0.555]);
    const view = quickOutcomeView({ outcome, ...facts, committed: true, session: { before: summary([8, 0.555]), after } }, { nvStatus: 'locked' });
    assert.equal(view.tone, c.tone, row.id);
    assert.equal(writeLockFor({ center: view.center }).mode, c.lock, row.id);
    assert.equal(view.sticks[0].tier, row.id);
    assert.match(view.sticks[0].before, /^8\.0%/);

    // Test drift con uno stick in questa riga.
    const drift = driftMessage({
      left: { offset: c.off, noise: 0.3, x: c.off / 100, y: 0 },
      right: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 },
    });
    assert.match(drift.text, c.drift, row.id);
    assert.equal(drift.recommendation, c.route, row.id);
  }
});

test('the Moving and Pinned overrides route the user, and never show a percentage as a diagnosis', () => {
  const moving = driftMessage({
    unstable: true,
    left: { offset: 4, noise: 6, x: 0.04, y: 0 },
    right: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 },
  });
  assert.equal(moving.tier, 'moving');
  assert.match(moving.text, /kept moving/);
  assert.doesNotMatch(moving.text, /4\.0%/);
  assert.equal(describeTier('moving').recommendation, TIER_OVERRIDES.moving.recommendation);

  const pinned = driftMessage({
    left: { offset: 100.2, noise: 0.1, x: 1, y: 0.05 },
    right: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 },
  });
  assert.equal(pinned.tier, 'pinned');
  assert.equal(pinned.recommendation, 'range-then-guided');
  assert.match(pinned.text, /Range calibration first, then Guided/);
});

// Review 2: dopo una calibrazione non salvata il test drift non dice "No
// calibration needed" proprio mentre il pannello chiede di scrivere in memoria.
test('a centered retest after an unsaved calibration supports saving instead of "No calibration needed"', () => {
  const centered = {
    left: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 },
    right: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 },
  };
  const previous = {
    left: { offset: 2.3, noise: 0.3, x: 0.023, y: 0 },
    right: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 },
  };
  const after = driftMessage(centered, { previous, unsaved: true });
  assert.doesNotMatch(after.text, /No calibration needed/);
  assert.match(after.text, /^Worst stick: before 2\.3%.* → now 0\.6% · at floor\. Centered now\. This calibration is still temporary: write it to memory to keep it\.$/);
  assert.equal(after.tier, 'centered');

  const oneStep = { ...centered, left: { offset: 1.24, noise: 0.3, x: 0.0124, y: 0 } };
  const within = driftMessage(oneStep, { previous, unsaved: true });
  assert.doesNotMatch(within.text, /fine to use as it is/);
  assert.match(within.text, /Within 1 step of center now\. This calibration is still temporary: write it to memory/);

  // Non migliore di prima: niente invito a salvare, rimanda al pannello.
  const worse = driftMessage(oneStep, { previous: centered, unsaved: true });
  assert.doesNotMatch(worse.text, /No calibration needed|write it to memory to keep it/);
  assert.match(worse.text, /not better than before/);

  // Write bloccato o protetto: nessun invito a salvare.
  const locked = driftMessage(centered, { previous, unsaved: true, writeLock: 'disabled' });
  assert.doesNotMatch(locked.text, /No calibration needed|write it to memory to keep it/);
  assert.match(locked.text, /Write is off/);
  const guarded = driftMessage(centered, { previous, unsaved: true, writeLock: 'guarded' });
  assert.doesNotMatch(guarded.text, /write it to memory to keep it/);
  assert.match(guarded.text, /check the result panel/);

  // Senza calibrazione attiva il testo di sempre.
  assert.match(driftMessage(centered).text, /No calibration needed/);
  assert.match(driftMessage(centered, { previous, unsaved: false }).text, /No calibration needed/);
});

test('fix-rate copy is the WS3 report figure, in words', () => {
  assert.equal(FIX_RATE.cohort, 'PG');
  assert.ok(FIX_RATE.centered >= 0.7 && FIX_RATE.centered < 0.8, '"about 3 in 4" must match the published rate');
  assert.equal(FIX_RATE_WORDS, 'about 3 in 4');
  const noisy = driftMessage({
    left: { offset: 2.2, noise: 2.4, x: 0.022, y: 0 },
    right: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 },
  });
  assert.match(noisy.text, /calibration can re-center the stick, but the noise will stay/);
  assert.doesNotMatch(noisy.text, /should fix/);
});

test('Write lock: disabled, guarded and allowed cases', () => {
  const mode = state => writeLockFor(state).mode;
  assert.equal(mode({}), 'allowed');
  assert.equal(mode({ poisoned: true }), 'disabled');
  assert.equal(mode({ needsPowerCycle: true }), 'disabled');
  assert.equal(mode({ range: { incomplete: true } }), 'disabled');
  assert.equal(mode({ range: { alreadyClosed: true } }), 'disabled');
  assert.equal(mode({ center: { outcome: 'stalled', worst: null } }), 'disabled');
  assert.equal(mode({ center: { outcome: 'catastrophic', worst: 31 } }), 'disabled');
  assert.equal(mode({ center: { outcome: 'residual', worst: 3, pinned: true } }), 'disabled');
  assert.equal(mode({ center: { outcome: 'worse-than-start', worst: 2, beforeWorst: 0.555 } }), 'guarded');
  assert.equal(mode({ center: { outcome: 'lost-ground', worst: 3, beforeWorst: 5, bestWorst: 1.24 } }), 'guarded');
  assert.equal(mode({ center: { outcome: 'unverified', worst: null, committed: true } }), 'guarded');
  assert.equal(mode({ center: { outcome: 'centered', worst: 0.555, beforeWorst: 3 } }), 'allowed');
  // Rete di sicurezza sui numeri: un esito che non lo dice non sfugge.
  assert.equal(mode({ center: { outcome: 'moved', worst: 18, beforeWorst: 3 } }), 'disabled');
  assert.equal(mode({ center: { outcome: 'residual', worst: 2.5, beforeWorst: 1.24 } }), 'guarded');
  // Disabilitato vince su protetto; i motivi si sommano.
  const both = writeLockFor({ center: { outcome: 'worse-than-start', worst: 2, beforeWorst: 0.555 }, range: { incomplete: true } });
  assert.equal(both.mode, 'disabled');
  assert.deepEqual(both.reasons.map(r => r.code), ['worse-than-start', 'range-incomplete']);
  for (const [code, reason] of Object.entries(LOCK_REASONS)) assert.ok(reason.text.length > 20, code);
});

test('worn is never shown for a result worse than the start, and worn gets repair guidance in order', () => {
  const facts = { worst: 3.1, beforeWorst: 1.24, bestWorst: 1.24, maxNoise: 2.5, unstableEvents: 0, passes: [3.1] };
  const outcome = classifyOutcome(facts, QUICK_DEFAULTS);
  assert.equal(outcome, 'worse-than-start');
  const worse = quickOutcomeView({ outcome, ...facts });
  assert.doesNotMatch(textOf(worse), /worn/i);
  assert.equal(worse.repair, false);

  const worn = quickOutcomeView({ outcome: 'worn', worst: 2.2, beforeWorst: 6, bestWorst: 2.2 });
  assert.equal(worn.repair, true);
  assert.match(textOf(worn), /the noise will stay/);
  const html = outcomeHtml(worn);
  const order = ['warranty', 'Cleaning', 'Hall-effect or TMR', 'calibrate again'].map(word => html.indexOf(word));
  assert.ok(order.every(i => i > 0), `all repair steps present: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'warranty, cleaning, replacement, then calibrate');
  assert.equal(REPAIR_STEPS.length, 4);
});

test('outcome-specific copy: within 1 step, Try Guided, lost ground, moved and unverified', () => {
  const within = quickOutcomeView({ outcome: 'within-1-step', worst: 1.24, beforeWorst: 3 });
  assert.equal(within.title, 'Within 1 step: fine to save');
  assert.match(textOf(within), /1\.2% · 1 step/);

  const det = quickOutcomeView({ outcome: 'residual-deterministic', worst: 2.2, beforeWorst: 5 });
  assert.match(det.title, /try Guided/);
  assert.deepEqual(det.actions.map(a => a.id), ['guided', 'quick']);

  // Riprovare è incoraggiato dove il risultato non è ancora al pavimento.
  assert.match(textOf(within), /as many times as you like/);
  assert.deepEqual(within.actions.map(a => a.id), ['quick']);
  for (const outcome of ['lost-ground', 'unstable', 'not-centered']) {
    const v = quickOutcomeView({ outcome, worst: 3.1, beforeWorst: 5, bestWorst: 1.24 });
    assert.match(textOf(v), /Nothing is permanent until you write it to memory/, outcome);
  }
  assert.doesNotMatch(textOf(quickOutcomeView({ outcome: 'centered', worst: 0.555, beforeWorst: 3 })), /as many times/);

  const lost = quickOutcomeView({ outcome: 'lost-ground', worst: 3.1, beforeWorst: 5, bestWorst: 1.24 });
  assert.match(textOf(lost), /reached 1\.2% · 1 step, but the controller keeps the last pass, now at 3\.1%/);

  const moved = quickOutcomeView({ outcome: 'moved', worst: 2.4, beforeWorst: 5 });
  assert.match(moved.title, /weren’t released/);
  assert.doesNotMatch(textOf(moved), SUCCESS);
  const movedUnknown = quickOutcomeView({ outcome: 'moved', worst: null, committed: true });
  assert.equal(writeLockFor({ center: movedUnknown.center }).mode, 'guarded', 'an unverified pass is guarded');

  const centered = quickOutcomeView({ outcome: 'centered', worst: 0.555, beforeWorst: 3.2 });
  assert.equal(centered.title, 'Both sticks centered');
  assert.equal(centered.tone, 'ok');

  const already = quickOutcomeView({ outcome: 'already-centered', worst: null, beforeWorst: 0.555 });
  // Nothing was sent, but what was just measured replaces the previous center
  // result: an old catastrophic/worse-than-start verdict must not keep Write off
  // on sticks measured centered (review finding: stale Write lock).
  assert.deepEqual(already.center, {
    outcome: 'already-centered', worst: 0.555, beforeWorst: 0.555, bestWorst: 0.555, pinned: false, committed: false,
  });
  assert.equal(writeLockFor({ center: already.center }).mode, 'allowed', 'measured centered: Write allowed, never "unverified"');
  assert.match(already.title, /nothing was sent/);
});

test('a stall reports "nothing was committed" only when that is true', () => {
  const first = quickOutcomeView({ outcome: 'stalled', committed: true, needsPowerCycle: true, pass: 1, committedBefore: false });
  assert.match(textOf(first), /Nothing was committed/);
  const second = quickOutcomeView({ outcome: 'stalled', committed: true, needsPowerCycle: true, pass: 2, committedBefore: true });
  assert.doesNotMatch(textOf(second), /Nothing was committed/);
  assert.match(textOf(second), /Pass 2 was abandoned/);
  assert.match(textOf(second), /previous pass is active on the controller and hasn’t been saved/);
  const repaired = quickOutcomeView({ outcome: 'stalled', committed: true, needsPowerCycle: true, pass: 1, committedBefore: true });
  assert.doesNotMatch(textOf(repaired), /Nothing was committed/);
  assert.match(textOf(repaired), /already changed the calibration/);
  for (const v of [first, second, repaired]) {
    assert.equal(writeLockFor({ center: v.center }).mode, 'disabled');
    assert.match(textOf(v), /Turn the controller off/);
  }
});

test('the power-cycle reminder offers Restart and an explicit power-off confirmation', () => {
  const view = powerCycleReminderView();
  assert.equal(view.center, null);
  assert.deepEqual(view.actions.map(a => a.id), ['restart', 'powered-off']);
  assert.match(textOf(view), /doesn’t turn it off/);
  assert.match(textOf(powerCycleReminderView({ reload: true })), /reloaded/);
});

test('pinned after calibration disables Write and routes to Range, then Guided', () => {
  const after = summary([100.1, 0.555], { xy: [[99.6, 8], [0.39, 0.39]] });
  assert.equal(pinnedFromSummary(after), true);
  const view = quickOutcomeView({ outcome: 'residual', worst: 100.1, beforeWorst: 4, session: { before: summary([4, 0.555]), after } });
  assert.equal(writeLockFor({ center: view.center }).mode, 'disabled');
  const guided = guidedOutcomeView({ before: summary([6, 0.555]), after: summary([12, 0.555], { xy: [[99.2, 0], [0.4, 0.4]] }) });
  assert.equal(guided.outcome, 'pinned');
  assert.deepEqual(guided.actions.map(a => a.id), ['range', 'guided']);
  assert.match(textOf(guided), /haven’t confirmed yet whether Range also moves the center/);
  assert.equal(stickRows(null, summary([12, 0.555], { xy: [[99.2, 0], [0.4, 0.4]] }))[0].after, 'Pinned at the edge');
});

test('guided results use the same rules: worse than start is guarded, 15% or more is disabled', () => {
  const worse = guidedOutcomeView({ before: summary([1.24, 0.555]), after: summary([3.1, 0.555]) });
  assert.equal(worse.outcome, 'worse-than-start');
  assert.equal(writeLockFor({ center: worse.center }).mode, 'guarded');
  const runaway = guidedOutcomeView({ before: summary([6, 0.555]), after: summary([22, 0.555]) });
  assert.equal(runaway.outcome, 'catastrophic');
  assert.equal(writeLockFor({ center: runaway.center }).mode, 'disabled');
  assert.doesNotMatch(textOf(runaway), SUCCESS);
  const good = guidedOutcomeView({ before: summary([6, 0.555]), after: summary([0.555, 0.555]) });
  assert.equal(good.outcome, 'centered');
  assert.equal(writeLockFor({ center: good.center }).mode, 'allowed');
  const failed = guidedOutcomeView({ before: summary([6, 0.555]), error: new Error('boom'), committed: false });
  assert.equal(failed.center, null);
});

test('an incomplete or already-closed range disables Write; a complete one does not', () => {
  assert.equal(writeLockFor({ range: rangeOutcomeView({ incomplete: true }).range }).mode, 'disabled');
  assert.equal(writeLockFor({ range: rangeOutcomeView({ alreadyClosed: true }).range }).mode, 'disabled');
  assert.equal(writeLockFor({ range: rangeOutcomeView({}).range }).mode, 'allowed');
  assert.match(rangeOutcomeView({}).title, /not saved yet/);
  assert.match(rangeOutcomeView({ incomplete: true }).title, /Range incomplete/);
});

test('a timed-out (poisoned) controller gets its own copy: no earlier pass, no save, no Restart, no raw HID text', () => {
  const timeout = Object.assign(new Error('Controller not responding (sendFeatureReport 0x82 timed out)'), { timeout: true });
  const poisoned = Object.assign(new Error('The controller stopped responding.'), { poisoned: true });
  const views = [
    quickOutcomeView({ outcome: 'error', error: timeout, committed: true, worst: null }),
    quickOutcomeView({ outcome: 'error', error: timeout, committed: false, worst: null }),
    quickOutcomeView({ outcome: 'error', error: poisoned, committed: false, worst: null }),
    guidedOutcomeView({ before: summary([6, 0.555]), error: timeout, committed: true }),
    rangeOutcomeView({ error: timeout, committed: true }),
  ];
  for (const view of views) {
    const text = textOf(view);
    assert.equal(view.title, 'The controller stopped responding');
    assert.match(text, /may or may not have been applied/);
    assert.match(text, /hold PS for 10 s/);
    assert.doesNotMatch(text, /earlier pass|sav(e|ing)|Restart|Nothing was changed|timed out|sendFeatureReport/i);
    assert.equal(view.tone, 'bad');
  }
});

test('an error that left the session open never says nothing changed and asks for a power cycle', () => {
  const error = new Error('Sampling failed (0x83010103).');
  const quick = quickOutcomeView({ outcome: 'error', error, committed: false, needsPowerCycle: true, worst: null });
  assert.doesNotMatch(textOf(quick), /Nothing was changed/);
  assert.match(textOf(quick), /left mid-calibration/);
  assert.match(textOf(quick), /0x83010103\)\.(?!\.)/, 'one full stop after the controller message');
  assert.ok(quick.center, 'the page keeps a center state for the Write lock');
  const guided = guidedOutcomeView({ before: summary([6, 0.555]), error, committed: false, leftOpen: true });
  assert.doesNotMatch(textOf(guided), /Nothing was changed/);
  assert.match(textOf(guided), /left mid-calibration/);
  const repaired = quickOutcomeView({ outcome: 'error', error, committed: true, worst: null });
  assert.doesNotMatch(textOf(repaired), /earlier pass|Nothing was changed/);
  assert.equal(writeLockFor({ center: repaired.center }).mode, 'guarded');
});

test('the panel HTML escapes controller and browser text', () => {
  const view = quickOutcomeView({ outcome: 'error', error: new Error('<img src=x onerror=alert(1)>'), committed: false, worst: null });
  const html = outcomeHtml(view);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test('the Write modal summary shows the numbers and the warnings of a guarded result', () => {
  const view = quickOutcomeView({ outcome: 'worse-than-start', worst: 2, beforeWorst: 0.555, bestWorst: 0.555, session: { before: summary([0.555, 0.555]), after: summary([2, 0.555]) } });
  const lock = writeLockFor({ center: view.center });
  const s = flashSummary(view, lock);
  assert.equal(s.guarded, true);
  assert.deepEqual(s.numbers, ['Left: 0.6% · at floor → 2.0% · 2 steps', 'Right: 0.6% · at floor → 0.6% · at floor']);
  assert.match(s.warnings.join(' '), /worse than when you started/);
});

test('the replay renderer marks every risky outcome as disabled or guarded', () => {
  const cases = [
    ['catastrophic', { worst: 40, beforeWorst: 3, bestWorst: 3 }, 'disabled'],
    ['worse-than-start', { worst: 2, beforeWorst: 0.555, bestWorst: 0.555 }, 'guarded'],
    ['lost-ground', { worst: 3, beforeWorst: 5, bestWorst: 1.24 }, 'guarded'],
    ['centered', { worst: 0.555, beforeWorst: 3, bestWorst: 0.555 }, 'allowed'],
  ];
  for (const [outcome, facts, lock] of cases) {
    const r = render(outcome, facts);
    assert.equal(r.lock, lock, outcome);
    assert.equal(r.writeDisabled, lock === 'disabled');
    assert.equal(r.writeGuarded, lock === 'guarded');
    assert.ok(r.htmlLength > 0);
  }
});

// Le sequenze reali note (runaway, peggioramenti) in forma di sessione v1,
// sintetiche: la telemetria vera non entra nei test. Sul file reale lo stesso
// controllo è `node ops/sim/replay-telemetry.mjs --renderer js/ui/outcome.js`.
test('replayed through replay-telemetry, every worse, lost or catastrophic session has Write disabled or guarded', () => {
  const row = (before, passes, after = passes.at(-1), { noise = 0.3, unstableEvents = 0 } = {}) => ({
    t: '2026-09-20T10:00:00.000Z',
    board: 'BDM-030',
    before: { off: [before, 0.555], noise: [noise, 0.3] },
    after: { off: [after, 0.555], noise: [noise, 0.3] },
    passes,
    unstableEvents,
  });
  const rows = [
    row(3.55, [30, 47, 47, 40]), row(4.1, [36, 44]), row(5.2, [12, 30, 18]), row(14.2, [16, 16, 16, 16]), row(3.55, [100, 100]),
    row(0.555, [2.018, 2.018]), row(1.24, [3.1], 3.1, { noise: 2.5 }), row(5, [1.24, 3.1]), row(6, [0.555, 2.2, 2.2]),
    row(3.5, [0.555]), row(3.5, [1.24]), row(4.2, [2.2, 2.2]), row(4.2, [2.2], 2.2, { noise: 2 }), row(4.2, [2.9], 2.9, { unstableEvents: 2 }),
  ];
  const { summary: s } = replayOutcomes(rows, QUICK_DEFAULTS, render);
  assert.equal(s.renderErrors, 0);
  assert.ok(s.worseThanStart + s.lostGround + s.final15 >= 9, 'the risky cases are really in the set');
  assert.equal(s.riskyWithWriteUnguarded, 0);
  assert.equal(s.wornWhenWorseThanStart, 0);
  assert.equal(replayOutcomes(rows, QUICK_DEFAULTS, null).summary.riskyWithWriteUnguarded > 0, true, 'without the renderer they are unguarded');
});

/* ------------------------------ nella pagina ------------------------------ */

async function connectedApp(deviceOptions = {}, loadOptions = {}) {
  const clock = new VClock();
  const dev = makeDevice(clock, deviceOptions);
  const h = await loadApp({ clock, authorized: [dev], ...loadOptions });
  await h.advance(5000);
  return { h, dev };
}
const flashUnlocks = dev => dev.commandLog.filter(c => c.id === 0x80 && c.bytes[0] === 3 && c.bytes[1] === 2).length;

test('in the page, a runaway pass ends with the do-not-save panel and Write disabled', async () => {
  // Bias persistente di 40 LSB (~31%) sullo stick sinistro: la partenza è
  // vicina al centro (preflight ok) ma con un drift vero, perché da WS1 una
  // partenza già centrata non invia comandi; la prima passata va oltre il 15%
  // e la verifica (tenuta entro il 15% impossibile) la dichiara catastrofica.
  const clock = new VClock();
  const dev = makeDevice(clock, { drift: [[3.2, -0.3], [-0.1, 0.4]], sf: 0 });
  dev.sticks[0].bias = { axis: 0, B: 40 };
  const h = await loadApp({ clock, authorized: [dev] });
  await h.advance(5000);
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));

  assert.equal(dev.counts.end, 1, 'the catastrophic stop commits no further pass');
  const quick = h.sessions().filter(s => s.kind === 'quick').at(-1);
  assert.ok(quick.passes.at(-1) >= QUICK_CATASTROPHIC_PCT, `last pass ${quick.passes.at(-1)}`);
  const panel = h.$('calib-outcome');
  assert.equal(h.visible('calib-outcome'), true);
  assert.equal(panel.getAttribute('role'), 'status');
  assert.doesNotMatch(panel.innerHTML, SUCCESS);
  assert.match(panel.innerHTML, /Don’t save this result/);
  assert.match(panel.innerHTML, /hold PS for 10 s/, 'the virtual controller reports a locked NVS');
  assert.equal(panel.dataset.tone, 'bad');
  assert.equal(h.peek().unsaved, true, 'the RAM changed: the unsaved state stays honest');
  assert.equal(h.$('btn-flash').disabled, true, 'Write is disabled');
  assert.match(h.$('banner-lock').textContent, /^Write is off: /);
  // Anche aggirando il bottone, doFlash non scrive.
  await h.run(h.ctx.doFlash());
  assert.equal(flashUnlocks(dev), 0);
  assert.equal(h.peek().busy, false);
  // Il pannello resta dopo il nuovo test drift; lo svuota solo la prossima calibrazione.
  await h.advance(10000);
  assert.equal(h.visible('calib-outcome'), true);
});

test('a worse-than-start result: warning, Cancel focused, Write only after the second confirmation', async () => {
  const { h, dev } = await connectedApp();
  h.eval(`showOutcome(quickOutcomeView({ outcome: 'worse-than-start', worst: 2, beforeWorst: 0.555, bestWorst: 0.555, committed: true,
    session: { before: { off: [0.555, 0.555], noise: [0.2, 0.2], xy: [[0.39, 0.39], [0.39, 0.39]] }, after: { off: [2, 0.555], noise: [0.2, 0.2], xy: [[2, 0], [0.39, 0.39]] } } }, { nvStatus: 'locked' }))`);
  h.ctx.setUnsaved(true);
  assert.equal(h.$('btn-flash').disabled, false, 'guarded, not disabled');
  await h.click('btn-flash');
  assert.equal(h.visible('modal-flash'), true);
  assert.equal(h.visible('flash-warning'), true);
  assert.match(h.$('flash-warning-text').textContent, /worse than when you started/);
  assert.match(h.$('flash-numbers').innerHTML, /0\.6% · at floor → 2\.0% · 2 steps/);
  assert.equal(h.$('btn-flash-cancel').hasAttribute('data-autofocus'), true, 'Cancel is the default');
  assert.equal(h.$('btn-flash-go').disabled, true, 'Write waits for the second confirmation');
  await h.run(h.ctx.doFlash());
  assert.equal(flashUnlocks(dev), 0, 'no flash without the confirmation');
  h.$('flash-ack').checked = true;
  h.$('flash-ack').dispatch('change');
  assert.equal(h.$('btn-flash-go').disabled, false);
  await h.run(h.click('btn-flash-go'));
  assert.equal(flashUnlocks(dev), 1);
  assert.equal(h.peek().unsaved, false);
});

test('a good result opens the Write modal with the numbers and no warning', async () => {
  const { h } = await connectedApp();
  h.eval(`showOutcome(quickOutcomeView({ outcome: 'centered', worst: 0.555, beforeWorst: 3.2, bestWorst: 0.555, committed: true,
    session: { before: { off: [3.2, 0.555], noise: [0.2, 0.2], xy: [[3.2, 0], [0.39, 0.39]] }, after: { off: [0.555, 0.555], noise: [0.2, 0.2], xy: [[0.39, 0.39], [0.39, 0.39]] } } }))`);
  h.ctx.setUnsaved(true);
  await h.click('btn-flash');
  assert.equal(h.visible('flash-warning'), false);
  assert.equal(h.$('btn-flash-cancel').hasAttribute('data-autofocus'), false);
  assert.equal(h.$('btn-flash-go').disabled, false);
  assert.match(h.$('flash-numbers').innerHTML, /Left: 3\.2%.* → 0\.6% · at floor/);
});

test('an incomplete range disables Write until a complete range runs', async () => {
  const { h, dev } = await connectedApp();
  await h.run(h.click('btn-range')); await h.run(h.click('btn-range-start'));
  // Da WS7 un range a movimento zero non si chiude mai: un giro solo, in un
  // verso, basta per "Finish anyway" (manca il cambio di verso) dopo 15 s.
  const from = h.clock.now() + 10;
  for (const stick of [0, 1]) {
    dev.touches.push({
      stick, t0: from, dur: 800, tail: 1,
      at: (t, ax) => 127.5 * (ax === 0 ? Math.cos(2 * Math.PI * (t - from) / 800) : Math.sin(2 * Math.PI * (t - from) / 800)),
    });
  }
  await h.advance(16000);
  assert.equal(h.$('btn-range-done').textContent, 'Finish anyway');
  h.window.confirm = () => true;
  await h.run(h.click('btn-range-done'));
  assert.equal(h.peek().unsaved, true);
  assert.match(h.$('calib-outcome').innerHTML, /Range incomplete/);
  assert.equal(h.$('btn-flash').disabled, true);
  await h.click('btn-flash');
  assert.equal(h.visible('modal-flash'), false);
  await h.run(h.ctx.doFlash());
  assert.equal(flashUnlocks(dev), 0);
});

test('an already-centered start: Close is the primary action, Calibrate anyway the secondary one', async () => {
  const { h, dev } = await connectedApp({ drift: [[0, 0], [0, 0]] });
  await h.click('btn-quick');
  await h.run(h.click('btn-quick-go'));
  assert.equal(dev.counts.begin, 0, 'nothing sent');
  assert.equal(h.visible('modal-quick'), true, 'the prompt stays open');
  assert.equal(h.$('btn-quick-cancel').textContent, 'Close');
  assert.match(h.$('btn-quick-cancel').className, /btn-primary/);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate anyway');
  assert.match(h.$('btn-quick-go').className, /btn-secondary/);
  assert.equal(h.doc.activeElement, h.$('btn-quick-cancel'));
  assert.match(h.$('calib-outcome').innerHTML, /Already centered/);
  await h.click('btn-quick-cancel');
  await h.advance(500);
  assert.equal(h.visible('modal-quick'), false);
  assert.equal(h.$('btn-quick-go').textContent, 'Calibrate now', 'reset for the next opening');
});

test('Disconnect asks first when the calibration is unsaved, and says unplugging is unverified', async () => {
  const { h } = await connectedApp();
  h.ctx.setUnsaved(true);
  let asked = null;
  h.window.confirm = text => { asked = text; return false; };
  await h.run(h.click('btn-disconnect'));
  assert.match(asked, /hasn’t been written to memory/);
  assert.ok(h.peek().ds5, 'still connected after declining');
  h.window.confirm = () => true;
  await h.run(h.click('btn-disconnect'));
  assert.equal(h.peek().ds5, null);
  assert.ok(h.toasts().some(t => /never written to memory.*hold PS for 10 s.*haven’t confirmed whether unplugging/.test(t)));
});

test('the unsaved flag survives a reload in the same tab, with copy that ties it to no device', async () => {
  const session = new Map();
  const first = await connectedApp({}, { session });
  first.h.ctx.setUnsaved(true);
  assert.equal(session.get('sense-unsaved-in-tab'), '1');
  const second = await connectedApp({}, { session });
  assert.equal(second.h.visible('banner-session'), true);
  await second.h.click('btn-session-dismiss');
  assert.equal(second.h.visible('banner-session'), false);
  assert.equal(session.has('sense-unsaved-in-tab'), false);
  // Un salvataggio riuscito abbassa il segno.
  second.h.ctx.setUnsaved(true);
  await second.h.click('btn-flash');
  await second.h.run(second.h.click('btn-flash-go'));
  assert.equal(session.has('sense-unsaved-in-tab'), false);
});

test('an empty chooser shows the checklist; open errors are translated', async () => {
  const clock = new VClock();
  const h = await loadApp({ clock });
  await h.run(h.click('btn-connect'));
  assert.equal(h.visible('connect-help'), true);
  assert.match(h.$('connect-help-list').innerHTML, /data cable.*DualSense Edge.*another USB port.*Steam or DS4Windows.*Linux/s);
  h.hid.requestDevice = async () => { throw Object.assign(new Error('Access denied.'), { name: 'NotAllowedError' }); };
  await h.run(h.click('btn-connect'));
  assert.match(h.$('hero-error').innerHTML, /wasn’t allowed to open the controller/);
});

test('the serial is masked by default and can be shown', async () => {
  const { h } = await connectedApp();
  // Il DualSense virtuale non ha seriale: se ne dà uno all'info letta.
  const serial = 'E1A2B3C4D5F6';
  h.eval(`deviceInfo = { ...deviceInfo, serial: '${serial}' }; renderDeviceInfo(deviceInfo);`);
  assert.doesNotMatch(h.$('device-sub').textContent, new RegExp(serial));
  assert.match(h.$('device-sub').textContent, /^Serial •••• /);
  await h.click('btn-serial');
  assert.equal(h.$('device-sub').textContent, serial);
  assert.equal(h.$('btn-serial').getAttribute('aria-pressed'), 'true');
});

test('a background tab during a calibration changes the title and explains on return', async () => {
  const { h } = await connectedApp({ drift: [[6.2, 0.3], [0.2, 0.1]] });
  await h.click('btn-quick');
  const running = h.click('btn-quick-go');
  await h.advance(1500);
  assert.equal(h.peek().busy, true);
  h.setHidden(true);
  assert.equal(h.doc.title, 'Calibrating… don’t touch');
  await h.run(running);
  assert.equal(h.doc.title, 'Calibration finished · Sense Calibrator');
  h.setHidden(false);
  assert.ok(h.toasts().some(t => /finished while you were away/.test(t)));
});

test('a low battery that is not charging shows a hint in the Quick and Guided dialogs', async () => {
  const { h } = await connectedApp();
  h.eval('battery = { level: 15, charging: false }; setBatteryChip();');
  await h.click('btn-quick');
  assert.equal(h.visible('quick-battery'), true);
  assert.match(h.$('quick-battery').textContent, /Battery at 15% and not charging/);
  h.eval('battery = { level: 15, charging: true }; setBatteryChip();');
  assert.equal(h.visible('quick-battery'), false);
});

test('the drift card shows Moving instead of a percentage when the sticks never settle', async () => {
  const { h } = await connectedApp();
  h.eval(`driftTest = { samples: [], auto: false }; finishDriftTest({ unstable: true,
    left: { offset: 4, noise: 6, x: 0.04, y: 0 }, right: { offset: 0.555, noise: 0.3, x: 0.0039, y: 0.0039 } })`);
  assert.equal(h.$('verdict-l').textContent, 'Moving');
  assert.match(h.$('drift-status').textContent, /kept moving/);
});

test('quickPreflightRoute: Pinned → Range then Guided, Severe → Guided, otherwise nothing', () => {
  const stick = (offset, extra = {}) => ({ offset, x: 0, y: 0, noise: 0.3, ...extra });
  assert.equal(quickPreflightRoute(null), null);
  assert.equal(quickPreflightRoute({ left: stick(3.2), right: stick(0.555) }), null, 'Marked: a failed preflight is a hand');
  const severe = quickPreflightRoute({ left: stick(19.6, { x: 0.196 }), right: stick(0.555) });
  assert.equal(severe.action.id, 'guided');
  assert.match(severe.text, /^The left stick rests too far off-center for Quick calibration/);
  const pinned = quickPreflightRoute({ left: stick(0.555), right: stick(100, { x: 1, y: 0, noise: 0.1 }) });
  assert.equal(pinned.action.id, 'range');
  assert.equal(pinned.then.id, 'guided');
  assert.match(pinned.text, /^The right stick rests at the very edge/);
});

test('guided result names an axis that got worse even when the stick improved', () => {
  const v = guidedOutcomeView({
    before: { off: [3.1, 0.555], noise: [0, 0], xy: [[3.0, 0.4], [0.4, 0.4]] },
    after: { off: [2.8, 0.555], noise: [0, 0], xy: [[0.4, 2.8], [0.4, 0.4]] },
  });
  assert.match(textOf(v), /left Y axis moved further from center/);
  const ok = guidedOutcomeView({
    before: { off: [3.1, 0.555], noise: [0, 0], xy: [[3.0, 0.4], [0.4, 0.4]] },
    after: { off: [0.555, 0.555], noise: [0, 0], xy: [[0.4, 0.4], [0.4, 0.4]] },
  });
  assert.doesNotMatch(textOf(ok), /moved further/);
});

test('a result three steps worse than the start disables Write; a smaller regression only guards it', () => {
  const big = writeLockFor({ center: { outcome: 'worse-than-start', worst: 12.95, beforeWorst: 0.555 } });
  assert.equal(big.mode, 'disabled');
  assert.ok(big.reasons.some(r => r.code === 'much-worse'));
  const small = writeLockFor({ center: { outcome: 'worse-than-start', worst: 2.0, beforeWorst: 0.555 } });
  assert.equal(small.mode, 'guarded');
  const g = guidedOutcomeView({ before: { off: [0.555, 0.555], noise: [0, 0], xy: [[0.4, 0.4], [0.4, 0.4]] },
    after: { off: [12.95, 3.55], noise: [0, 0], xy: [[12.9, 0.4], [3.5, 0.4]] } });
  assert.equal(g.actions[0].id, 'quick');
  assert.match(textOf(g), /Quick calibration usually brings the sticks back/);
});

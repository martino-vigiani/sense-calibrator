'use strict';

import { rangeStatus, stickCoverageThreshold } from '../calib/range-coverage.js';

// Presentazione soltanto: i requisiti vengono dal tracker e dalle sue soglie.
// Nessun risultato di questo modulo decide Done, Finish anyway o Write.
const compass = ['right', 'lower right', 'down', 'lower left', 'left', 'upper left', 'up', 'upper right'];
const escape = value => String(value).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function shortAreas(bins, total) {
  if (bins.length === total) return ['the whole edge'];
  const seen = new Set(bins.map(bin => {
    const angle = (bin + 0.5) / total * 2 * Math.PI - Math.PI;
    return compass[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
  }));
  return compass.filter(name => seen.has(name));
}

function stickProgress(stick, status, label) {
  const threshold = stickCoverageThreshold(stick);
  const shortBins = stick.bins.flatMap((radius, bin) => radius < threshold ? [bin] : []);
  const coverageMet = status.coverage >= stick.p.minCoverage;
  const sidesMet = status.missingDirs.length === 0;
  const turns = Math.min(stick.p.minTurns, Math.floor(status.turns));
  const sectors = Math.round(status.coverage * 100);
  const requirements = [
    { id: 'coverage', label: 'Edge sectors', value: `${sectors}%`, met: coverageMet,
      detail: `At least ${Math.round(stick.p.minCoverage * 100)}% of edge sectors` },
    { id: 'sides', label: 'All sides', value: `${4 - status.missingDirs.length} of 4`, met: sidesMet,
      detail: sidesMet ? 'All four sides reached' : `Still short: ${status.missingDirs.join(', ')}` },
    { id: 'turns', label: 'Full turns', value: `${turns} of ${stick.p.minTurns}`, met: status.enoughTurns,
      detail: `At least ${stick.p.minTurns} full turns in total` },
    { id: 'reverse', label: 'Other way', value: status.reversed ? 'Done' : '½ turn', met: status.reversed,
      detail: 'At least half a turn in the opposite direction' },
  ];
  const areas = shortAreas(shortBins, stick.p.bins);
  return {
    label, requirements, shortBins: coverageMet ? [] : shortBins, areas, threshold,
    complete: status.complete,
    onlyReverse: coverageMet && sidesMet && status.enoughTurns && !status.reversed,
    needsEdge: !coverageMet || !sidesMet,
    needsCoverage: !coverageMet,
    missingSides: status.missingDirs,
    // Quando il gate è già passato, i pochi settori residui non sembrano un
    // requisito nuovo: 90%, non 100%, resta il criterio di copertura.
    areasText: !coverageMet ? `Short areas: ${areas.join(', ')}.`
      : !sidesMet ? `Short sides: ${status.missingDirs.join(', ')}.` : '',
    dialLabel: `${label} edge coverage ${sectors}%. ${status.complete ? 'All requirements met.'
      : requirements.filter(req => !req.met).map(req => `${req.label}: ${req.detail}.`).join(' ')}`,
  };
}

function stickNames(items) {
  return items.length === 2 ? 'both sticks' : `the ${items[0].label.toLowerCase()}`;
}

export function rangeProgress(tracker, elapsedMs = 0) {
  const status = rangeStatus(tracker, elapsedMs);
  const left = stickProgress(tracker.left, status.left, 'Left stick');
  const right = stickProgress(tracker.right, status.right, 'Right stick');
  const incomplete = [left, right].filter(stick => !stick.complete);
  let action, hint;
  if (status.complete) {
    action = 'complete';
    hint = 'All extremes reached, both directions ✓. Both sticks are ready: press Done.';
  } else if (incomplete.every(stick => stick.onlyReverse)) {
    action = 'reverse';
    const ready = incomplete.length === 1 ? `The ${incomplete[0] === left ? 'right' : 'left'} stick is complete. ` : '';
    hint = `${ready}Reverse ${stickNames(incomplete)} for at least half a turn, staying against the edge.`;
  } else {
    const edge = incomplete.filter(stick => stick.needsCoverage);
    const sides = incomplete.filter(stick => stick.missingSides.length);
    if (edge.length) {
      action = 'edge';
      hint = `Slowly trace the dashed edge sectors on ${stickNames(edge)}, pressing gently against the rim.`;
    } else if (sides.length) {
      action = 'sides';
      hint = 'Press each stick all the way to its short sides: '
        + sides.map(stick => `${stick.label}: ${stick.missingSides.join(', ')}`).join('; ') + '.';
    } else {
      action = 'turns';
      hint = `Keep ${stickNames(incomplete)} against the rim for two full turns in total, then reverse for at least half a turn.`;
    }
  }
  // Suggerimento dopo il tempo già usato per Finish anyway, senza chiamarlo
  // guasto: tanti giri non dicono perché un settore resta corto.
  const repeatedEdge = elapsedMs >= tracker.params.unlockMs
    && [status.left, status.right].some(stick => stick.enoughTurns && stick.coverage < tracker.params.minCoverage);
  const help = repeatedEdge
    ? 'Edge sectors are still short after several turns. Slow down and pause gently against the rim in the dashed areas. If they stay short, do not force the stick. An incomplete finish keeps Write disabled.'
    : '';
  return { status, left, right, action, hint, help };
}

export function rangeRequirementsHtml(view) {
  return view.requirements.map(req => `<li data-met="${req.met}">`
    + `<span class="range-requirement-mark" aria-hidden="true">${req.met ? '✓' : '○'}</span>`
    + `<span>${escape(req.label)}</span><span class="range-requirement-value">${escape(req.value)}</span>`
    + `<span class="sr-only">${escape(req.detail)}. ${req.met ? 'Met' : 'Still needed'}.</span></li>`).join('');
}

// Fotografia del gate già calcolato: nessuna nuova lettura o soglia.
export function rangeCompletion(status, minCoverage) {
  if (!status?.left || !status?.right || !Number.isFinite(minCoverage)) return null;
  const sides = [status.left, status.right];
  return {
    reversed: sides.map(s => s.reversed),
    reverseTurns: sides.map(s => s.reverseTurns),
    missing: sides.map(s => [
      ...(s.coverage < minCoverage ? ['coverage'] : []),
      ...s.missingDirs,
      ...(s.enoughTurns ? [] : ['turns']),
      ...(s.reversed ? [] : ['reverse']),
    ]),
  };
}

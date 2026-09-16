'use strict';

export const CALIBRATION_ENDPOINT = 'https://subralabs.com/api/calib/v1/sessions';

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const isMeasurement = value => isFiniteNumber(value) && value >= 0 && value <= 200;
const isCanonicalTimestamp = value => {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
};

function calibrationPair(value) {
  if (!value || typeof value !== 'object') return undefined;

  const { off, noise } = value;
  if (!Array.isArray(off) || off.length !== 2 || !off.every(isMeasurement)) return undefined;
  if (!Array.isArray(noise) || noise.length !== 2 || !noise.every(isMeasurement)) return undefined;
  return { off: [...off], noise: [...noise] };
}

// The public v1 endpoint accepts one strict quick-calibration record. Richer
// local events stay in the browser until a versioned server contract exists.
export function buildCalibrationUpload(entry) {
  if (!entry || entry.kind !== 'quick') return null;
  if (!isCanonicalTimestamp(entry.t)) return null;
  if (entry.board !== null && (typeof entry.board !== 'string' || entry.board.length > 20)) return null;
  if (entry.fw !== null && !Number.isInteger(entry.fw)) return null;

  const before = calibrationPair(entry.before);
  const after = calibrationPair(entry.after);
  if (before === undefined || after === undefined) return null;

  if (!Array.isArray(entry.passes)
      || entry.passes.length === 0
      || entry.passes.length > 8
      || !entry.passes.every(isFiniteNumber)) {
    return null;
  }
  if (!Number.isInteger(entry.unstableEvents) || entry.unstableEvents < 0 || entry.unstableEvents > 100) {
    return null;
  }
  if (!isFiniteNumber(entry.gate) || entry.gate < 0 || entry.gate > 1) return null;
  if (typeof entry.gateOff !== 'boolean') return null;

  return {
    t: entry.t,
    board: entry.board,
    fw: entry.fw,
    before,
    after,
    passes: [...entry.passes],
    unstableEvents: entry.unstableEvents,
    gate: entry.gate,
    gateOff: entry.gateOff,
  };
}

export async function uploadCalibrationEvent(entry, options = {}) {
  const payload = buildCalibrationUpload(entry);
  if (!payload) return false;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const endpoint = options.endpoint ?? CALIBRATION_ENDPOINT;
  const signal = options.signal
    ?? (globalThis.AbortSignal?.timeout ? AbortSignal.timeout(options.timeoutMs ?? 4000) : undefined);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true,
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) throw new Error(`Telemetry rejected with HTTP ${response.status}`);
  return true;
}

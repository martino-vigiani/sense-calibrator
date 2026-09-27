#!/usr/bin/env bash
# pull-telemetry.sh — rsync calibration telemetry from the VPS into data/telemetry/
# Usage: ./scripts/pull-telemetry.sh
#   sessions.jsonl   v1 (one line per complete Quick calibration)
#   events-v2.jsonl  v2 events (quick, guided, range, flash, save, rest)
set -euo pipefail

REMOTE_USER="martino"
REMOTE_HOST="91.99.217.255"
REMOTE_DIR="/var/lib/calib-telemetry"
LOCAL_DIR="$(dirname "$0")/../data/telemetry"

mkdir -p "$LOCAL_DIR"

rsync -az --progress \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/sessions.jsonl" \
  "${LOCAL_DIR}/sessions.jsonl"
echo "v1 lines received: $(wc -l < "${LOCAL_DIR}/sessions.jsonl")"

# Il file v2 nasce alla prima richiesta valida dopo il deploy del 27 set 2026:
# finché non esiste, la sua assenza non è un errore.
if rsync -az "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/events-v2.jsonl" \
     "${LOCAL_DIR}/events-v2.jsonl" 2>/dev/null; then
  echo "v2 lines received: $(wc -l < "${LOCAL_DIR}/events-v2.jsonl")"
else
  echo "v2 events: none on the server yet"
fi

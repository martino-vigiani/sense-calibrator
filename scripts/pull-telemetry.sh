#!/usr/bin/env bash
# pull-telemetry.sh — rsync calibration telemetry from the VPS into data/telemetry/
#   sessions.jsonl   v1 (complete Quick sessions)
#   events-v2.jsonl  v2 events (from the v2 release on; skipped while it does not exist)
# Usage: ./scripts/pull-telemetry.sh
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

if ssh "${REMOTE_USER}@${REMOTE_HOST}" test -f "${REMOTE_DIR}/events-v2.jsonl"; then
  rsync -az --progress \
    "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/events-v2.jsonl" \
    "${LOCAL_DIR}/events-v2.jsonl"
  echo "v2 lines received: $(wc -l < "${LOCAL_DIR}/events-v2.jsonl")"
else
  echo "v2: no events-v2.jsonl on the server yet"
fi

#!/usr/bin/env bash
# pull-telemetry.sh — rsync calibration sessions from the VPS into data/telemetry/
# Usage: ./scripts/pull-telemetry.sh
set -euo pipefail

REMOTE_USER="martino"
REMOTE_HOST="91.99.217.255"
REMOTE_FILE="/var/lib/calib-telemetry/sessions.jsonl"
LOCAL_DIR="$(dirname "$0")/../data/telemetry"

mkdir -p "$LOCAL_DIR"

rsync -az --progress \
  "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_FILE}" \
  "${LOCAL_DIR}/sessions.jsonl"

echo "Lines received: $(wc -l < "${LOCAL_DIR}/sessions.jsonl")"

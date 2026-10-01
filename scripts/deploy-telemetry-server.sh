#!/usr/bin/env bash
# deploy-telemetry-server.sh — pubblica server/calib-telemetry sul VPS.
# Uso: ./scripts/deploy-telemetry-server.sh [--dry-run]
#
# Il server gira sul VPS sotto pm2 (`calib-telemetry`, porta 3040, nginx
# /api/calib/). I dati stanno in /var/lib/calib-telemetry, fuori dalla
# cartella del codice: --delete non li tocca. .env e i log non vengono mai
# inviati né cancellati.
set -euo pipefail

HOST="martino@91.99.217.255"
REMOTE="/home/martino/calib-telemetry/"
SRC="$(cd "$(dirname "$0")/../server/calib-telemetry" && pwd)/"
DRY=""
[[ "${1:-}" == "--dry-run" ]] && DRY="--dry-run"

echo "==> test locali"
(cd "$SRC" && npm ci --no-audit --no-fund && npm test) || { echo "✗ test falliti: niente deploy" >&2; exit 1; }

echo "==> rsync $SRC → $HOST:$REMOTE ${DRY:+(dry run)}"
rsync -az --delete $DRY --itemize-changes \
  --exclude node_modules --exclude .env --exclude '*.log' --exclude '*.test.js' \
  --exclude .DS_Store --exclude .deploy \
  --filter='protect .env' --filter='protect *.log' \
  "$SRC" "$HOST:$REMOTE"
[[ -n "$DRY" ]] && { echo "dry run: nient'altro eseguito"; exit 0; }

echo "==> npm ci + pm2 reload"
ssh "$HOST" "cd $REMOTE && npm ci --omit=dev --no-audit --no-fund && pm2 reload calib-telemetry --update-env"

echo "==> health"
# PM2 può rispondere prima che la porta torni pronta. Si ritenta solo la
# lettura health, mai il deploy; `curl && echo` nascondeva il fallimento a set -e.
CALIB_HEALTH_OK=0
for attempt in 1 2 3 4 5; do
  if curl --connect-timeout 3 --max-time 5 -fsS https://subralabs.com/api/calib/health; then
    echo
    CALIB_HEALTH_OK=1
    break
  fi
  [[ "$attempt" -eq 5 ]] || sleep 2
done
if [[ "$CALIB_HEALTH_OK" -ne 1 ]]; then
  echo "✗ health non riuscito dopo 5 tentativi: file caricati, servizio da verificare" >&2
  exit 1
fi
echo "✓ deploy completato"

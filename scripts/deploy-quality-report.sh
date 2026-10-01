#!/usr/bin/env bash
# Il report notturno ha una release propria, distinta dal raccoglitore PM2.
set -euo pipefail
exec node "$(dirname "$0")/deploy-quality-report.mjs" "$@"

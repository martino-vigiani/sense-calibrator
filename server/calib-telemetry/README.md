# calib-telemetry

Anonymous calibration session telemetry for [Sense-Calibrator](https://github.com/martino-vigiani/Sense-Calibrator).

Collects structured JSONL records of calibration sessions (v1) and typed calibration events (v2). Those persistent records contain no IP addresses, user-agents, or request metadata. The request IP is kept temporarily in memory only for the per-minute rate limits and removed by periodic cleanup.

The web server in front of the service (nginx, behind Cloudflare) writes its own access log for every request, API calls included: client IP as nginx sees it, time, request line, status, user agent. The log stays on (debugging and abuse protection) and the privacy policy says so; its retention is not documented in this repository and must be confirmed on the VPS (deploy checklist, step 5).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/calib/v1/sessions` | Submit a calibration session (204 on success) |
| `POST` | `/api/calib/v2/events` | Submit one typed calibration event (204 on success) |
| `GET` | `/api/calib/health` | Public health check (`{"status":"ok"}`) |
| `GET` | `/health` | Local full health (uptime + line count, not proxied) |

## Schema (`POST /api/calib/v1/sessions`)

```json
{
  "t": "2024-01-01T00:00:00.000Z",
  "board": "DUALSHOCK4" | null,
  "fw": 312 | null,
  "before": { "off": [0, 0], "noise": [5, 5] } | null,
  "after":  { "off": [2, 1], "noise": [3, 4] } | null,
  "passes": [0.12, 0.08],
  "unstableEvents": 2,
  "gate": 0.95,
  "gateOff": false
}
```

- `board`: string ≤ 20 chars or null
- `fw`: integer or null
- `before` / `after`: null or `{ off: [num,num], noise: [num,num] }` — values must be finite, 0–200
- `passes`: array of ≤ 8 finite numbers
- `unstableEvents`: integer 0–100
- `gate`: finite number 0–1
- `gateOff`: boolean
- Unknown top-level keys → 400

## Schema v2 (`POST /api/calib/v2/events`)

One event per request, validated against `contract/events-v2.schema.json`
(JSON Schema 2020-12, published as `CalibrationEventV2` in
[`openapi.json`](https://subralabs.com/openapi.json)). The schema and
`contract/events-v2.fixtures.json` are byte-for-byte copies of the files in the
Sense-Calibrator repository (`ops/calib-telemetry/contract/`); both test suites
pin the same SHA-256 and run the same fixtures through their own validator, so
a change on one side only fails the other. To check the two checkouts against
each other:

```sh
CALIB_CONTRACT_PEER=../../../Sense-Calibrator/ops/calib-telemetry/contract node --test
```

Six event types, selected by `type`: `quick`, `guided`, `range` (one
calibration each), `flash` (one Write to memory attempt), `save` (how an unsaved
calibration ended: saved, disconnected or page left, with Write-lock reasons and
dialog counters) and `rest` (a 30-second summary of resting stick noise).
Base fields are required; Quick `verification` and Range `completion` are optional and nullable so pages already open before this release still work. Unknown fields are rejected at every level, and every
string is an enum except `sid` (8 hex characters, random per page load, never
stored by the page). There is no serial number, device identifier, free text or
client timestamp. The body limit remains 4 KB; the largest supported Quick diagnostic payload is tested against that limit. Quick diagnostics contain at most 16 existing verification measurements, their stability criterion and retry-hold outcome; Range diagnostics contain reverse-turn progress and missing completion checks. Legacy records are reported as unknown, never inferred stable or complete.

The stored line is the event unchanged plus `receivedDay` (UTC date, no time):

```json
{"v":2,"type":"flash","sid":"3f9a01bc","seq":6,"app":20260927,"board":"BDM-030","fw":16777258,"result":"ok","nv":"locked","attempt":1,"lock":"allowed","receivedDay":"2026-09-28"}
```

`contract/openapi-components.js` derives the OpenAPI components from the schema;
the v2 test fails if `code/subralabs.com/openapi.json` does not match it.

## Rate limit

v1: 10 POST requests per IP per minute (in-memory). v2: 30 events per IP per
minute, in a separate bucket with its own policy name (`calibration-events`),
so events never use up the v1 quota. Both are applied before the JSON body is
parsed. Submission responses expose
`RateLimit-Policy` and `RateLimit` in the current IETF HTTPAPI draft format,
plus the earlier compatibility fields. Exceeding the quota returns `429` and
`Retry-After`.

## Public contract and errors

The OpenAPI 3.1 contract is published at
[`https://subralabs.com/openapi.json`](https://subralabs.com/openapi.json), with
human-readable guidance at
[`https://subralabs.com/developers.html`](https://subralabs.com/developers.html).

Errors use RFC 9457 `application/problem+json` with `type`, `title`, `status`,
`detail`, stable `code`, and a `resolution` hint. The old `error` property is
kept as an alias of `detail` for client compatibility.
Unsupported request media types, charsets, and content encodings return `415`
with the stable code `unsupported_media_type`.

## Data file

Sessions are appended as JSONL to `DATA_PATH` (default `/var/lib/calib-telemetry/sessions.jsonl`). v2 events go to `DATA_V2_PATH` (default `/var/lib/calib-telemetry/events-v2.jsonl`). Each file has its own 50 MB cap → 507.

## Local dev

```sh
npm install
DATA_PATH=/tmp/calib-test.jsonl DATA_V2_PATH=/tmp/calib-v2.jsonl PORT=3040 node server.js
npm test   # v1 and v2 suites
```

## PM2 / deploy

```sh
# On the VPS
pm2 start ecosystem.config.js
pm2 save
```

Nginx upstream: `http://127.0.0.1:3040`  
Deploy target and health URL are in `.deploy`.

## Deploy

The source lives in this repository (`server/calib-telemetry/`); until
2026-09-27 it lived in the SubraLabs monorepo. Deploy from the repo root:

```sh
./scripts/deploy-telemetry-server.sh --dry-run   # shows what would change
./scripts/deploy-telemetry-server.sh             # tests, rsync, npm ci, pm2 reload, health
```

The script runs the tests first and refuses to deploy if they fail. It never
ships or deletes `.env` or logs; the data files live in
`/var/lib/calib-telemetry/`, outside the deploy directory.

Tests: `npm test` in this folder (v1 + v2). Optional cross-checks:
`CALIB_CONTRACT_PEER=../../ops/calib-telemetry/contract npm test` (the page's copy
of the v2 contract must be byte-identical) and `OPENAPI_PATH=<copy of
https://subralabs.com/openapi.json>` (published OpenAPI components must match
the schema). The public API docs (`openapi.json`, `developers.html`,
`privacy.html`) belong to the subralabs.com site and are not deployed from here.

nginx: the vhost proxies the `/api/calib/` prefix to 127.0.0.1:3040; access
logs rotate daily and are kept 14 days (`/etc/logrotate.d/nginx`).

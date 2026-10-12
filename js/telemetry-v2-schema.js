'use strict';

// GENERATO da ops/calib-telemetry/contract/events-v2.schema.json con
// ops/calib-telemetry/contract/sync-schema.mjs. Non modificarlo a mano.
export const EVENTS_V2_SCHEMA = Object.freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://subralabs.com/schemas/calib-events-v2.json",
  "title": "CalibrationEventV2",
  "description": "One anonymous Sense-Calibrator telemetry event (contract v2). Exactly one of seven event types, selected by `type`. Base fields are required; verification and completion diagnostics and the rest timing fields are optional for compatibility with older pages. Every diagnostic object is closed and requires all its fields. Unknown fields are rejected, strings are enums (only `sid` is a pattern). No serial number, device identifier, free text or client timestamp: times are relative to the last calibration of the page load, rounded to 10 seconds.",
  "oneOf": [
    {
      "$ref": "#/$defs/QuickEvent"
    },
    {
      "$ref": "#/$defs/GuidedEvent"
    },
    {
      "$ref": "#/$defs/RangeEvent"
    },
    {
      "$ref": "#/$defs/FlashEvent"
    },
    {
      "$ref": "#/$defs/SaveEvent"
    },
    {
      "$ref": "#/$defs/RestEvent"
    },
    {
      "$ref": "#/$defs/LandingEvent"
    }
  ],
  "discriminator": {
    "propertyName": "type",
    "mapping": {
      "quick": "#/$defs/QuickEvent",
      "guided": "#/$defs/GuidedEvent",
      "range": "#/$defs/RangeEvent",
      "flash": "#/$defs/FlashEvent",
      "save": "#/$defs/SaveEvent",
      "rest": "#/$defs/RestEvent",
      "landing": "#/$defs/LandingEvent"
    }
  },
  "$defs": {
    "Version": {
      "description": "Contract version, always 2.",
      "type": "integer",
      "const": 2
    },
    "Sid": {
      "description": "Random identifier generated for one page load and never stored; links the events of one visit, never two visits.",
      "type": "string",
      "pattern": "^[0-9a-f]{8}$"
    },
    "Seq": {
      "description": "Order of the event within the page load.",
      "type": "integer",
      "minimum": 0,
      "maximum": 255
    },
    "App": {
      "description": "Calendar date (YYYYMMDD) of the calibrator release that sent the event.",
      "type": "integer",
      "minimum": 20260901,
      "maximum": 20991231
    },
    "Board": {
      "description": "DualSense main board revision decoded from the hardware info, or null when unknown.",
      "enum": [
        "BDM-010",
        "BDM-020",
        "BDM-030",
        "BDM-040",
        "BDM-050",
        "BDM-060R",
        "BDM-060M",
        "BDM-060X",
        null
      ]
    },
    "Firmware": {
      "description": "Controller firmware version number, or null when unknown.",
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0,
      "maximum": 4294967295
    },
    "Percent": {
      "description": "Radial stick offset in percent of full travel, rounded to 0.01.",
      "type": "number",
      "minimum": 0,
      "maximum": 200
    },
    "StickPair": {
      "description": "[left, right] radial offsets, or null when not measured.",
      "type": [
        "array",
        "null"
      ],
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "$ref": "#/$defs/Percent"
      }
    },
    "HalfLsb": {
      "description": "Signed axis residual in half-LSB units of the 8-bit stick report (1 = 0.5 LSB = 0.392% of full travel; bytes 127 and 128 map to -1 and +1). Clamped to 64 LSB in either direction.",
      "type": "integer",
      "minimum": -128,
      "maximum": 128
    },
    "AxisPair": {
      "description": "[x, y] signed residuals for one stick, in half-LSB units.",
      "type": "array",
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "$ref": "#/$defs/HalfLsb"
      }
    },
    "StickAxes": {
      "description": "[[left x, left y], [right x, right y]] signed residuals from the per-axis median, or null when not measured.",
      "type": [
        "array",
        "null"
      ],
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "$ref": "#/$defs/AxisPair"
      }
    },
    "DurationS": {
      "description": "Whole seconds, capped at one hour.",
      "type": "integer",
      "minimum": 0,
      "maximum": 3600
    },
    "Count": {
      "type": "integer",
      "minimum": 0,
      "maximum": 50
    },
    "FlashResult": {
      "description": "Outcome class of one Write to memory attempt.",
      "enum": [
        "ok",
        "not-confirmed",
        "nv-unknown",
        "unlock-failed",
        "lock-failed",
        "error"
      ]
    },
    "NvStatus": {
      "description": "NVS status read back after the attempt, or null when not read.",
      "enum": [
        "locked",
        "unlocked",
        "pending_reboot",
        "unknown",
        "error",
        null
      ]
    },
    "LockMode": {
      "description": "Write lock of the page: allowed, guarded (warning and second confirmation) or disabled.",
      "enum": [
        "allowed",
        "guarded",
        "disabled"
      ]
    },
    "LockReason": {
      "enum": [
        "poisoned",
        "needs-power-cycle",
        "catastrophic",
        "pinned",
        "worse-than-start",
        "lost-ground",
        "unverified",
        "range-incomplete",
        "range-already-closed"
      ]
    },
    "Lsb": {
      "description": "Distance in 8-bit steps (1 LSB = 0.784% per axis), rounded to 0.01.",
      "type": "number",
      "minimum": 0,
      "maximum": 256
    },
    "SinceCalS": {
      "description": "Seconds since the last Quick or Guided calibration that changed the controller RAM in this page load, rounded to 10 s and capped at 3600; null when there was none (or a different controller was connected since).",
      "type": [
        "integer",
        "null"
      ],
      "minimum": 0,
      "maximum": 3600
    },
    "OpType": {
      "enum": [
        "quick",
        "guided",
        "range",
        "flash",
        "reconnect",
        "power-cycle"
      ]
    },
    "OpsSince": {
      "description": "The calibration that SinceCalS counts from (quick or guided), then each other kind of operation since then, once, in the order first seen: range (a Range that may have changed the RAM), flash (a Write to memory attempt), reconnect (the controller connected again), power-cycle (a Restart sent or a power-off confirmed). Null when SinceCalS is null.",
      "type": [
        "array",
        "null"
      ],
      "maxItems": 8,
      "uniqueItems": true,
      "items": {
        "$ref": "#/$defs/OpType"
      }
    },
    "LandingPoint": {
      "description": "Where a stick stopped after one release: the mean of a still window in the reported (calibrated) frame.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "axes",
        "sinceCalS"
      ],
      "properties": {
        "axes": {
          "$ref": "#/$defs/AxisPair"
        },
        "sinceCalS": {
          "$ref": "#/$defs/SinceCalS"
        }
      }
    },
    "StickLandings": {
      "description": "Releases of one stick since the calibration in SinceCalS (since the page load when there was none). With count 0 every other field is null and recent is empty.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "count",
        "median",
        "spread",
        "firstS",
        "lastS",
        "recent"
      ],
      "properties": {
        "count": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10000
        },
        "median": {
          "description": "Per-axis median of the landing points, in half-LSB units.",
          "type": [
            "array",
            "null"
          ],
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "$ref": "#/$defs/HalfLsb"
          }
        },
        "spread": {
          "description": "[50th, 95th percentile] distance of the landing points from their median, in LSB.",
          "type": [
            "array",
            "null"
          ],
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "$ref": "#/$defs/Lsb"
          }
        },
        "firstS": {
          "$ref": "#/$defs/SinceCalS"
        },
        "lastS": {
          "$ref": "#/$defs/SinceCalS"
        },
        "recent": {
          "description": "The last landing points, oldest first.",
          "type": "array",
          "maxItems": 20,
          "items": {
            "$ref": "#/$defs/LandingPoint"
          }
        }
      }
    },
    "StickNoise": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "off",
        "p50",
        "p95",
        "max",
        "sx",
        "sy",
        "ex"
      ],
      "properties": {
        "off": {
          "$ref": "#/$defs/Percent"
        },
        "p50": {
          "$ref": "#/$defs/Lsb"
        },
        "p95": {
          "$ref": "#/$defs/Lsb"
        },
        "max": {
          "$ref": "#/$defs/Lsb"
        },
        "sx": {
          "$ref": "#/$defs/Lsb"
        },
        "sy": {
          "$ref": "#/$defs/Lsb"
        },
        "ex": {
          "description": "Excursions (runs of reports) at least 1, 2 and 4 LSB away from the median point.",
          "type": "array",
          "minItems": 3,
          "maxItems": 3,
          "items": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000
          }
        }
      }
    },
    "VerificationAttempt": {
      "description": "One existing post-commit Quick measurement. A hold result describes the centered-hold check, never proof that a hand was released. accepted means the ordinary verification accepted this result below the safety ceiling; extreme readings remain unaccepted even when their stability criterion passed.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "pass",
        "attempt",
        "off",
        "noise",
        "stableFraction",
        "rawNoise",
        "hold",
        "accepted",
        "criterion"
      ],
      "properties": {
        "pass": {
          "type": "integer",
          "minimum": 1,
          "maximum": 8
        },
        "attempt": {
          "type": "integer",
          "minimum": 1,
          "maximum": 2
        },
        "off": {
          "$ref": "#/$defs/StickPair"
        },
        "noise": {
          "description": "[left,right] p95 distance from the median in percent; null when no measurement was obtained.",
          "$ref": "#/$defs/StickPair"
        },
        "stableFraction": {
          "description": "Fraction of reports surviving the existing stability filter, rounded to 0.001; null when unavailable.",
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 1
        },
        "rawNoise": {
          "description": "Worst-stick p95 noise from all reports before filtering, percent rounded to 0.01; null when unavailable.",
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 200
        },
        "hold": {
          "enum": [
            "not-required",
            "released",
            "not-released"
          ]
        },
        "accepted": {
          "type": "boolean"
        },
        "criterion": {
          "description": "Which existing stability rule passed; none also covers a missing measurement. legacy identifies a source without a measured stable fraction.",
          "enum": [
            "stable-fraction",
            "baseline-noise",
            "legacy",
            "none"
          ]
        }
      }
    },
    "QuickVerification": {
      "description": "Diagnostic summaries of existing measurements, or null when unavailable. Older events omit this field. No extra HID reports, timing or calibration commands are requested.",
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "baselineNoise",
        "baselineRawNoise",
        "attempts"
      ],
      "properties": {
        "baselineNoise": {
          "$ref": "#/$defs/StickPair"
        },
        "baselineRawNoise": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 200
        },
        "attempts": {
          "type": "array",
          "maxItems": 16,
          "items": {
            "$ref": "#/$defs/VerificationAttempt"
          }
        }
      }
    },
    "RangeCompletion": {
      "description": "Requirements observed when the range session was closed or abandoned; null if no tracker was available. Older events omit this field. Both arrays and the outer missing array are ordered left, right.",
      "type": [
        "object",
        "null"
      ],
      "additionalProperties": false,
      "required": [
        "reversed",
        "reverseTurns",
        "missing"
      ],
      "properties": {
        "reversed": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "boolean"
          }
        },
        "reverseTurns": {
          "description": "Turns in the less-used direction, rounded to 0.1; reversed retains the decision before rounding.",
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          }
        },
        "missing": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "array",
            "maxItems": 7,
            "uniqueItems": true,
            "items": {
              "enum": [
                "coverage",
                "left",
                "right",
                "up",
                "down",
                "turns",
                "reverse"
              ]
            }
          }
        }
      }
    },
    "QuickEvent": {
      "description": "One Quick calibration run, whatever its outcome.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "v",
        "type",
        "sid",
        "seq",
        "app",
        "board",
        "fw",
        "outcome",
        "start",
        "committed",
        "needsPowerCycle",
        "truncated",
        "before",
        "beforeAxes",
        "after",
        "afterAxes",
        "passes",
        "passAxes",
        "durS"
      ],
      "properties": {
        "v": {
          "$ref": "#/$defs/Version"
        },
        "type": {
          "const": "quick"
        },
        "sid": {
          "$ref": "#/$defs/Sid"
        },
        "seq": {
          "$ref": "#/$defs/Seq"
        },
        "app": {
          "$ref": "#/$defs/App"
        },
        "board": {
          "$ref": "#/$defs/Board"
        },
        "fw": {
          "$ref": "#/$defs/Firmware"
        },
        "outcome": {
          "enum": [
            "centered",
            "within-1-step",
            "residual",
            "residual-deterministic",
            "unstable",
            "worn",
            "lost-ground",
            "worse-than-start",
            "catastrophic",
            "unverified",
            "already-centered",
            "preflight",
            "moved",
            "stalled",
            "disconnected",
            "error"
          ]
        },
        "start": {
          "description": "normal, forced (Calibrate anyway on centered sticks) or recovery (the opt-in pass after a catastrophic result).",
          "enum": [
            "normal",
            "forced",
            "recovery"
          ]
        },
        "committed": {
          "description": "The controller RAM calibration may have changed.",
          "type": "boolean"
        },
        "needsPowerCycle": {
          "type": "boolean"
        },
        "truncated": {
          "description": "Stopped by the session time limit.",
          "type": "boolean"
        },
        "before": {
          "$ref": "#/$defs/StickPair"
        },
        "beforeAxes": {
          "$ref": "#/$defs/StickAxes"
        },
        "after": {
          "$ref": "#/$defs/StickPair"
        },
        "afterAxes": {
          "$ref": "#/$defs/StickAxes"
        },
        "passes": {
          "description": "Verified worst offset after each pass, null for an unverified pass.",
          "type": "array",
          "maxItems": 8,
          "items": {
            "type": [
              "number",
              "null"
            ],
            "minimum": 0,
            "maximum": 200
          }
        },
        "passAxes": {
          "description": "Per-axis residual after each Quick pass, in the same order and count as passes; null for an unverified pass.",
          "type": "array",
          "maxItems": 8,
          "items": {
            "$ref": "#/$defs/StickAxes"
          }
        },
        "verification": {
          "$ref": "#/$defs/QuickVerification"
        },
        "durS": {
          "$ref": "#/$defs/DurationS"
        }
      }
    },
    "GuidedEvent": {
      "description": "One guided (four corner) calibration that sent at least one command.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "v",
        "type",
        "sid",
        "seq",
        "app",
        "board",
        "fw",
        "outcome",
        "committed",
        "needsPowerCycle",
        "step",
        "before",
        "beforeAxes",
        "after",
        "afterAxes",
        "timeouts",
        "escaped",
        "durS"
      ],
      "properties": {
        "v": {
          "$ref": "#/$defs/Version"
        },
        "type": {
          "const": "guided"
        },
        "sid": {
          "$ref": "#/$defs/Sid"
        },
        "seq": {
          "$ref": "#/$defs/Seq"
        },
        "app": {
          "$ref": "#/$defs/App"
        },
        "board": {
          "$ref": "#/$defs/Board"
        },
        "fw": {
          "$ref": "#/$defs/Firmware"
        },
        "outcome": {
          "enum": [
            "done",
            "error",
            "disconnected"
          ]
        },
        "committed": {
          "type": "boolean"
        },
        "needsPowerCycle": {
          "type": "boolean"
        },
        "step": {
          "description": "Last step reached: 0 start, 1-4 corners, 5 done.",
          "type": "integer",
          "minimum": 0,
          "maximum": 5
        },
        "before": {
          "$ref": "#/$defs/StickPair"
        },
        "beforeAxes": {
          "$ref": "#/$defs/StickAxes"
        },
        "after": {
          "$ref": "#/$defs/StickPair"
        },
        "afterAxes": {
          "$ref": "#/$defs/StickAxes"
        },
        "timeouts": {
          "$ref": "#/$defs/Count"
        },
        "escaped": {
          "description": "The confirmed escape for a creeping stick was used.",
          "type": "boolean"
        },
        "durS": {
          "$ref": "#/$defs/DurationS"
        }
      }
    },
    "RangeEvent": {
      "description": "One range calibration that reached rangeEnd.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "v",
        "type",
        "sid",
        "seq",
        "app",
        "board",
        "fw",
        "outcome",
        "committed",
        "coverage",
        "turns",
        "allEdges",
        "durS"
      ],
      "properties": {
        "v": {
          "$ref": "#/$defs/Version"
        },
        "type": {
          "const": "range"
        },
        "sid": {
          "$ref": "#/$defs/Sid"
        },
        "seq": {
          "$ref": "#/$defs/Seq"
        },
        "app": {
          "$ref": "#/$defs/App"
        },
        "board": {
          "$ref": "#/$defs/Board"
        },
        "fw": {
          "$ref": "#/$defs/Firmware"
        },
        "outcome": {
          "enum": [
            "complete",
            "incomplete",
            "already-closed",
            "error"
          ]
        },
        "committed": {
          "type": "boolean"
        },
        "coverage": {
          "description": "[left, right] fraction of the 36 edge sectors covered, rounded to 0.01.",
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          }
        },
        "turns": {
          "description": "[left, right] full turns, rounded to 0.1.",
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          }
        },
        "allEdges": {
          "type": "boolean"
        },
        "completion": {
          "$ref": "#/$defs/RangeCompletion"
        },
        "durS": {
          "$ref": "#/$defs/DurationS"
        }
      }
    },
    "FlashEvent": {
      "description": "One Write to memory attempt.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "v",
        "type",
        "sid",
        "seq",
        "app",
        "board",
        "fw",
        "result",
        "nv",
        "attempt",
        "lock"
      ],
      "properties": {
        "v": {
          "$ref": "#/$defs/Version"
        },
        "type": {
          "const": "flash"
        },
        "sid": {
          "$ref": "#/$defs/Sid"
        },
        "seq": {
          "$ref": "#/$defs/Seq"
        },
        "app": {
          "$ref": "#/$defs/App"
        },
        "board": {
          "$ref": "#/$defs/Board"
        },
        "fw": {
          "$ref": "#/$defs/Firmware"
        },
        "result": {
          "$ref": "#/$defs/FlashResult"
        },
        "nv": {
          "$ref": "#/$defs/NvStatus"
        },
        "attempt": {
          "description": "Attempt number within the unsaved period, from 1.",
          "type": "integer",
          "minimum": 1,
          "maximum": 50
        },
        "lock": {
          "description": "Write lock when the attempt started (guarded means the person confirmed a warning).",
          "enum": [
            "allowed",
            "guarded"
          ]
        }
      }
    },
    "SaveEvent": {
      "description": "How one unsaved period ended: from the first calibration that changed the controller RAM to a successful Write, a disconnect, or leaving the page.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "v",
        "type",
        "sid",
        "seq",
        "app",
        "result",
        "ref",
        "sessions",
        "lock",
        "reasons",
        "opens",
        "reminderOpens",
        "cancels",
        "attempts",
        "lastFlash",
        "seen",
        "waitS"
      ],
      "properties": {
        "v": {
          "$ref": "#/$defs/Version"
        },
        "type": {
          "const": "save"
        },
        "sid": {
          "$ref": "#/$defs/Sid"
        },
        "seq": {
          "$ref": "#/$defs/Seq"
        },
        "app": {
          "$ref": "#/$defs/App"
        },
        "result": {
          "enum": [
            "saved",
            "disconnected",
            "left"
          ]
        },
        "ref": {
          "description": "`seq` of the last calibration event of the period, or null.",
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 255
        },
        "sessions": {
          "description": "Calibration events recorded during the period.",
          "$ref": "#/$defs/Count"
        },
        "lock": {
          "$ref": "#/$defs/LockMode"
        },
        "reasons": {
          "description": "Reasons behind a guarded or disabled Write, when the period ended.",
          "type": "array",
          "maxItems": 9,
          "uniqueItems": true,
          "items": {
            "$ref": "#/$defs/LockReason"
          }
        },
        "opens": {
          "description": "Write dialog opened from the save step.",
          "$ref": "#/$defs/Count"
        },
        "reminderOpens": {
          "description": "Write dialog opened from the fixed reminder bar.",
          "$ref": "#/$defs/Count"
        },
        "cancels": {
          "description": "Write dialog closed without writing.",
          "$ref": "#/$defs/Count"
        },
        "attempts": {
          "$ref": "#/$defs/Count"
        },
        "lastFlash": {
          "enum": [
            "ok",
            "not-confirmed",
            "nv-unknown",
            "unlock-failed",
            "lock-failed",
            "error",
            null
          ]
        },
        "seen": {
          "description": "The save step was scrolled into view at least once.",
          "type": "boolean"
        },
        "waitS": {
          "$ref": "#/$defs/DurationS"
        }
      }
    },
    "RestEvent": {
      "description": "Summary of one window of resting stick readings, taken while the page was visible, no calibration or dialog was open and nobody moved the sticks.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "v",
        "type",
        "sid",
        "seq",
        "app",
        "board",
        "ctx",
        "state",
        "durS",
        "reports",
        "intervalMs",
        "gaps",
        "discarded",
        "sticks"
      ],
      "properties": {
        "v": {
          "$ref": "#/$defs/Version"
        },
        "type": {
          "const": "rest"
        },
        "sid": {
          "$ref": "#/$defs/Sid"
        },
        "seq": {
          "$ref": "#/$defs/Seq"
        },
        "app": {
          "$ref": "#/$defs/App"
        },
        "board": {
          "$ref": "#/$defs/Board"
        },
        "ctx": {
          "description": "drift: a drift test ran during the window; idle otherwise.",
          "enum": [
            "drift",
            "idle"
          ]
        },
        "state": {
          "description": "Calibration activity earlier in this page load: none, a calibration not yet saved, or one saved.",
          "enum": [
            "none",
            "unsaved",
            "saved"
          ]
        },
        "durS": {
          "type": "integer",
          "minimum": 10,
          "maximum": 120
        },
        "reports": {
          "description": "Input reports in the window.",
          "type": "integer",
          "minimum": 1,
          "maximum": 100000
        },
        "intervalMs": {
          "description": "[median, 95th percentile, maximum] interval between input reports, rounded to 0.1 ms.",
          "type": "array",
          "minItems": 3,
          "maxItems": 3,
          "items": {
            "type": "number",
            "minimum": 0,
            "maximum": 60000
          }
        },
        "gaps": {
          "description": "Intervals longer than 100 ms.",
          "type": "integer",
          "minimum": 0,
          "maximum": 10000
        },
        "discarded": {
          "description": "Windows dropped since the previous summary because a stick moved.",
          "type": "integer",
          "minimum": 0,
          "maximum": 1000
        },
        "sticks": {
          "description": "[left, right].",
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "$ref": "#/$defs/StickNoise"
          }
        },
        "sinceCalS": {
          "description": "At the end of the window. Older events omit this field.",
          "$ref": "#/$defs/SinceCalS"
        },
        "opsSince": {
          "$ref": "#/$defs/OpsSince"
        },
        "landings": {
          "description": "Releases of either stick since that calibration; null when SinceCalS is null.",
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 10000
        }
      }
    },
    "LandingEvent": {
      "description": "Where the sticks stopped after each release (thumb pushed past 25% and let go) since the last calibration, from the same input reports as the rest summaries. Sent at most twice per page load: after 20 releases following a calibration, and when the page is left.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "v",
        "type",
        "sid",
        "seq",
        "app",
        "board",
        "trigger",
        "ref",
        "sinceCalS",
        "opsSince",
        "sticks"
      ],
      "properties": {
        "v": {
          "$ref": "#/$defs/Version"
        },
        "type": {
          "const": "landing"
        },
        "sid": {
          "$ref": "#/$defs/Sid"
        },
        "seq": {
          "$ref": "#/$defs/Seq"
        },
        "app": {
          "$ref": "#/$defs/App"
        },
        "board": {
          "$ref": "#/$defs/Board"
        },
        "trigger": {
          "description": "count: 20 releases after a calibration; left: the page was left.",
          "enum": [
            "count",
            "left"
          ]
        },
        "ref": {
          "description": "`seq` of the calibration event SinceCalS counts from, or null.",
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 255
        },
        "sinceCalS": {
          "$ref": "#/$defs/SinceCalS"
        },
        "opsSince": {
          "$ref": "#/$defs/OpsSince"
        },
        "sticks": {
          "description": "[left, right].",
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "$ref": "#/$defs/StickLandings"
          }
        }
      }
    }
  }
});

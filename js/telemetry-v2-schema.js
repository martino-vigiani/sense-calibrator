'use strict';

// GENERATO da ops/calib-telemetry/contract/events-v2.schema.json con
// ops/calib-telemetry/contract/sync-schema.mjs. Non modificarlo a mano.
export const EVENTS_V2_SCHEMA = Object.freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://subralabs.com/schemas/calib-events-v2.json",
  "title": "CalibrationEventV2",
  "description": "One anonymous Sense-Calibrator telemetry event (contract v2). Exactly one of six event types, selected by `type`. Every field is required, unknown fields are rejected, strings are enums (only `sid` is a pattern). No serial number, device identifier, free text or client timestamp.",
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
      "rest": "#/$defs/RestEvent"
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
        }
      }
    }
  }
});

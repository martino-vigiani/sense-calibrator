'use strict';

// GENERATO da ops/calib-telemetry/contract/diagnostics-v1.schema.json con
// ops/calib-telemetry/contract/sync-schema.mjs. Non modificarlo a mano.
export const DIAGNOSTICS_V1_SCHEMA = Object.freeze({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://subralabs.com/schemas/calib-diagnostics-v1.json",
  "title": "DiagnosticsReportV1",
  "description": "A Sense-Calibrator diagnostic recording (contract v1), sent only when the user presses Send to the developer and confirms. At most 30 minutes; every time is milliseconds since the recording started, never a clock time. Events, landings (where a stick stops after each release) and a once-per-second trace of the resting position per stick. No raw input reports, serial number, device identifier or free text. Unknown fields are rejected at every level; embedded calib events are validated against CalibrationEventV2.",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "format",
    "v",
    "app",
    "durMs",
    "stop",
    "params",
    "events",
    "landings",
    "trace",
    "summary",
    "dropped"
  ],
  "properties": {
    "format": {
      "const": "sense-calibrator-diagnostics"
    },
    "v": {
      "description": "Contract version, always 1.",
      "type": "integer",
      "const": 1
    },
    "app": {
      "$ref": "#/$defs/App"
    },
    "durMs": {
      "$ref": "#/$defs/Ms"
    },
    "stop": {
      "description": "Why the recording ended: the user stopped it, the 30-minute limit, or still recording when exported.",
      "enum": [
        "user",
        "time-limit",
        "recording"
      ]
    },
    "params": {
      "$ref": "#/$defs/Params"
    },
    "events": {
      "type": "array",
      "maxItems": 400,
      "items": {
        "$ref": "#/$defs/Event"
      }
    },
    "landings": {
      "type": "array",
      "maxItems": 1500,
      "items": {
        "$ref": "#/$defs/Landing"
      }
    },
    "trace": {
      "type": "array",
      "maxItems": 1860,
      "items": {
        "$ref": "#/$defs/TraceRow"
      }
    },
    "summary": {
      "$ref": "#/$defs/Summary"
    },
    "dropped": {
      "$ref": "#/$defs/Dropped"
    }
  },
  "$defs": {
    "App": {
      "description": "Calendar date (YYYYMMDD) of the calibrator release that recorded the report.",
      "type": "integer",
      "minimum": 20260901,
      "maximum": 20991231
    },
    "Ms": {
      "description": "Milliseconds since the recording started (never a clock time). A recording stops by itself at 30 minutes; one extra minute covers the last events.",
      "type": "integer",
      "minimum": 0,
      "maximum": 1860000
    },
    "Count": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100000
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
    "NvStatus": {
      "description": "NVS status read from the controller, or null when not read.",
      "enum": [
        "locked",
        "unlocked",
        "pending_reboot",
        "unknown",
        "error",
        null
      ]
    },
    "Percent": {
      "description": "Radial stick offset in percent of full travel.",
      "type": "number",
      "minimum": 0,
      "maximum": 200
    },
    "PercentOrNull": {
      "type": [
        "number",
        "null"
      ],
      "minimum": 0,
      "maximum": 200
    },
    "SignedLsb": {
      "description": "Signed axis position in 8-bit steps from the nominal center (1 LSB = 0.784%), in the frame the controller reports (calibrated), rounded to 0.1.",
      "type": "number",
      "minimum": -128,
      "maximum": 128
    },
    "Lsb": {
      "description": "Distance in 8-bit steps, rounded to 0.01.",
      "type": "number",
      "minimum": 0,
      "maximum": 256
    },
    "AxisPair": {
      "description": "[x, y] signed position in LSB.",
      "type": "array",
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "$ref": "#/$defs/SignedLsb"
      }
    },
    "AxisPairOrNull": {
      "type": [
        "array",
        "null"
      ],
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "$ref": "#/$defs/SignedLsb"
      }
    },
    "StickPair": {
      "description": "[left, right] radial offsets in percent.",
      "type": "array",
      "minItems": 2,
      "maxItems": 2,
      "items": {
        "$ref": "#/$defs/Percent"
      }
    },
    "TracePoint": {
      "description": "[x median, y median, spread] for one stick over one second of reports, in LSB. Spread is the larger per-axis max - min; a resting stick stays within about 4.5 LSB (3.5%).",
      "type": "array",
      "minItems": 3,
      "maxItems": 3,
      "items": {
        "type": "number",
        "minimum": -128,
        "maximum": 256
      }
    },
    "TraceRow": {
      "description": "One second of resting-position trace: medians and spread per stick from the input reports of that second.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "n",
        "l",
        "r"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "n": {
          "description": "Input reports in that second.",
          "type": "integer",
          "minimum": 1,
          "maximum": 2000
        },
        "l": {
          "$ref": "#/$defs/TracePoint"
        },
        "r": {
          "$ref": "#/$defs/TracePoint"
        }
      }
    },
    "Landing": {
      "description": "Where a stick stopped after a release (js/calib/landing.js).",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "stick",
        "peak",
        "landAxes",
        "landPct",
        "settleMs"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "stick": {
          "enum": [
            "left",
            "right"
          ]
        },
        "peak": {
          "$ref": "#/$defs/Percent"
        },
        "landAxes": {
          "$ref": "#/$defs/AxisPair"
        },
        "landPct": {
          "$ref": "#/$defs/Percent"
        },
        "settleMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 60000
        }
      }
    },
    "StickSummary": {
      "description": "summarizeLandings for one stick. With count 0 every other field is null.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "count",
        "median",
        "medianPct",
        "spreadLsb",
        "spreadPct",
        "driftLsb",
        "driftPct",
        "settleMs"
      ],
      "properties": {
        "count": {
          "$ref": "#/$defs/Count"
        },
        "median": {
          "$ref": "#/$defs/AxisPairOrNull"
        },
        "medianPct": {
          "$ref": "#/$defs/PercentOrNull"
        },
        "spreadLsb": {
          "description": "[p50, p95] distance of each landing from the median landing, LSB.",
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
        "spreadPct": {
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
        "driftLsb": {
          "type": [
            "number",
            "null"
          ],
          "minimum": 0,
          "maximum": 256
        },
        "driftPct": {
          "$ref": "#/$defs/PercentOrNull"
        },
        "settleMs": {
          "type": [
            "integer",
            "null"
          ],
          "minimum": 0,
          "maximum": 60000
        }
      }
    },
    "Summary": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "left",
        "right"
      ],
      "properties": {
        "left": {
          "$ref": "#/$defs/StickSummary"
        },
        "right": {
          "$ref": "#/$defs/StickSummary"
        }
      }
    },
    "Params": {
      "description": "Landing detector thresholds used for this report.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "moveSpreadPct",
        "stableSpreadPct",
        "holdMs",
        "minPeakPct",
        "maxLandPct"
      ],
      "properties": {
        "moveSpreadPct": {
          "$ref": "#/$defs/Percent"
        },
        "stableSpreadPct": {
          "$ref": "#/$defs/Percent"
        },
        "holdMs": {
          "type": "integer",
          "minimum": 0,
          "maximum": 10000
        },
        "minPeakPct": {
          "$ref": "#/$defs/Percent"
        },
        "maxLandPct": {
          "$ref": "#/$defs/Percent"
        }
      }
    },
    "Dropped": {
      "description": "Items not recorded because a cap was reached.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "events",
        "landings",
        "trace"
      ],
      "properties": {
        "events": {
          "$ref": "#/$defs/Count"
        },
        "landings": {
          "$ref": "#/$defs/Count"
        },
        "trace": {
          "$ref": "#/$defs/Count"
        }
      }
    },
    "ConnectEvent": {
      "description": "A DualSense was connected over USB. No serial, color or firmware build date; the NVS status follows as an nv event.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "board",
        "fw"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "connect"
        },
        "board": {
          "$ref": "#/$defs/Board"
        },
        "fw": {
          "$ref": "#/$defs/Firmware"
        }
      }
    },
    "DisconnectEvent": {
      "description": "The controller went away (unplug, power-off, Disconnect).",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "disconnect"
        }
      }
    },
    "NvEvent": {
      "description": "NVS status read again.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "nv"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "nv"
        },
        "nv": {
          "$ref": "#/$defs/NvStatus"
        }
      }
    },
    "StartEvent": {
      "description": "An operation started (the result follows as a drift or calib event).",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "op"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "start"
        },
        "op": {
          "enum": [
            "drift",
            "quick",
            "guided",
            "range",
            "flash",
            "restart"
          ]
        }
      }
    },
    "DriftEvent": {
      "description": "A drift test result: per-stick offset, noise and signed per-axis median.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "auto",
        "off",
        "noise",
        "axes",
        "unstable"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "drift"
        },
        "auto": {
          "type": "boolean"
        },
        "off": {
          "$ref": "#/$defs/StickPair"
        },
        "noise": {
          "$ref": "#/$defs/StickPair"
        },
        "axes": {
          "type": "array",
          "minItems": 2,
          "maxItems": 2,
          "items": {
            "$ref": "#/$defs/AxisPair"
          }
        },
        "unstable": {
          "type": "boolean"
        }
      }
    },
    "CalibEvent": {
      "description": "The telemetry v2 event the page builds for a calibration, Write or save period (quick, guided, range, flash, save, rest). Validated separately against CalibrationEventV2 (events-v2.schema.json): it carries no serial, device identifier, free text or clock time.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "event"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "calib"
        },
        "event": {
          "type": "object"
        }
      }
    },
    "PowerCycleEvent": {
      "description": "The page marked the controller as needing a power cycle, or cleared that mark.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "lock"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "power-cycle"
        },
        "lock": {
          "enum": [
            "marked",
            "cleared"
          ]
        }
      }
    },
    "RestartEvent": {
      "description": "A Restart was sent; `sent` is whether the command went out.",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "sent"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "restart"
        },
        "sent": {
          "type": "boolean"
        }
      }
    },
    "UnsavedEvent": {
      "description": "The calibration in controller RAM became unsaved (on) or saved/dismissed (off).",
      "type": "object",
      "additionalProperties": false,
      "required": [
        "t",
        "type",
        "on"
      ],
      "properties": {
        "t": {
          "$ref": "#/$defs/Ms"
        },
        "type": {
          "const": "unsaved"
        },
        "on": {
          "type": "boolean"
        }
      }
    },
    "Event": {
      "description": "One recorded event, selected by `type`.",
      "oneOf": [
        {
          "$ref": "#/$defs/ConnectEvent"
        },
        {
          "$ref": "#/$defs/DisconnectEvent"
        },
        {
          "$ref": "#/$defs/NvEvent"
        },
        {
          "$ref": "#/$defs/StartEvent"
        },
        {
          "$ref": "#/$defs/DriftEvent"
        },
        {
          "$ref": "#/$defs/CalibEvent"
        },
        {
          "$ref": "#/$defs/PowerCycleEvent"
        },
        {
          "$ref": "#/$defs/RestartEvent"
        },
        {
          "$ref": "#/$defs/UnsavedEvent"
        }
      ],
      "discriminator": {
        "propertyName": "type",
        "mapping": {
          "connect": "#/$defs/ConnectEvent",
          "disconnect": "#/$defs/DisconnectEvent",
          "nv": "#/$defs/NvEvent",
          "start": "#/$defs/StartEvent",
          "drift": "#/$defs/DriftEvent",
          "calib": "#/$defs/CalibEvent",
          "power-cycle": "#/$defs/PowerCycleEvent",
          "restart": "#/$defs/RestartEvent",
          "unsaved": "#/$defs/UnsavedEvent"
        }
      }
    }
  }
});

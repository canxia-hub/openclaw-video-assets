// Build-time plan catalog from official CLI 1.1.1 schema. Execution refreshes the installed schema.
export const CANVAS_COMMANDS = [
  {
    "command": "model",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "type",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "model list",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "type",
        "type": "string",
        "required": true
      }
    ]
  },
  {
    "command": "model find",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "type",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "voice list",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "offset",
        "type": "integer",
        "required": false
      },
      {
        "name": "count",
        "type": "integer",
        "required": false
      },
      {
        "name": "model",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "node create image",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": false
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "mode",
        "type": "string",
        "required": false
      },
      {
        "name": "prompt",
        "type": "string",
        "required": false
      },
      {
        "name": "model",
        "type": "string",
        "required": false
      },
      {
        "name": "ratio",
        "type": "string",
        "required": false
      },
      {
        "name": "resolution",
        "type": "string",
        "required": false
      },
      {
        "name": "count",
        "type": "integer",
        "required": false
      },
      {
        "name": "ref",
        "type": "string[]",
        "required": false
      },
      {
        "name": "resource-id",
        "type": "string[]",
        "required": false
      },
      {
        "name": "import-kind",
        "type": "string",
        "required": false
      },
      {
        "name": "run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "submit-id",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "node create video",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": false
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "mode",
        "type": "string",
        "required": false
      },
      {
        "name": "prompt",
        "type": "string",
        "required": false
      },
      {
        "name": "model",
        "type": "string",
        "required": false
      },
      {
        "name": "ratio",
        "type": "string",
        "required": false
      },
      {
        "name": "resolution",
        "type": "string",
        "required": false
      },
      {
        "name": "duration",
        "type": "number",
        "required": false
      },
      {
        "name": "count",
        "type": "integer",
        "required": false
      },
      {
        "name": "ref",
        "type": "string[]",
        "required": false
      },
      {
        "name": "resource-id",
        "type": "string[]",
        "required": false
      },
      {
        "name": "import-kind",
        "type": "string",
        "required": false
      },
      {
        "name": "run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "submit-id",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "node create audio",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": false
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "mode",
        "type": "string",
        "required": false
      },
      {
        "name": "prompt",
        "type": "string",
        "required": false
      },
      {
        "name": "model",
        "type": "string",
        "required": false
      },
      {
        "name": "duration",
        "type": "number",
        "required": false
      },
      {
        "name": "voice-id",
        "type": "string",
        "required": false
      },
      {
        "name": "voice-name",
        "type": "string",
        "required": false
      },
      {
        "name": "scenario",
        "type": "string",
        "required": false
      },
      {
        "name": "ref",
        "type": "string[]",
        "required": false
      },
      {
        "name": "resource-id",
        "type": "string[]",
        "required": false
      },
      {
        "name": "import-kind",
        "type": "string",
        "required": false
      },
      {
        "name": "run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "submit-id",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "node create element",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": false
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "description",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "main",
        "type": "string",
        "required": true
      },
      {
        "name": "voice",
        "type": "string",
        "required": false
      },
      {
        "name": "auxiliary",
        "type": "string[]",
        "required": false
      },
      {
        "name": "import-kind",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "node create text",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": false
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "text",
        "type": "string",
        "required": false
      },
      {
        "name": "import-kind",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "node create timeline",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": false
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "clip",
        "type": "string[]",
        "required": false
      },
      {
        "name": "audio-clip",
        "type": "string[]",
        "required": false
      },
      {
        "name": "import-kind",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "node edit image",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "clear-generation",
        "type": "boolean",
        "required": false
      },
      {
        "name": "mode",
        "type": "string",
        "required": false
      },
      {
        "name": "prompt",
        "type": "string",
        "required": false
      },
      {
        "name": "model",
        "type": "string",
        "required": false
      },
      {
        "name": "ratio",
        "type": "string",
        "required": false
      },
      {
        "name": "resolution",
        "type": "string",
        "required": false
      },
      {
        "name": "count",
        "type": "integer",
        "required": false
      },
      {
        "name": "ref",
        "type": "string[]",
        "required": false
      },
      {
        "name": "run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "submit-id",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "node edit video",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "clear-generation",
        "type": "boolean",
        "required": false
      },
      {
        "name": "mode",
        "type": "string",
        "required": false
      },
      {
        "name": "prompt",
        "type": "string",
        "required": false
      },
      {
        "name": "model",
        "type": "string",
        "required": false
      },
      {
        "name": "ratio",
        "type": "string",
        "required": false
      },
      {
        "name": "resolution",
        "type": "string",
        "required": false
      },
      {
        "name": "duration",
        "type": "number",
        "required": false
      },
      {
        "name": "count",
        "type": "integer",
        "required": false
      },
      {
        "name": "ref",
        "type": "string[]",
        "required": false
      },
      {
        "name": "run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "submit-id",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "node edit audio",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "clear-generation",
        "type": "boolean",
        "required": false
      },
      {
        "name": "mode",
        "type": "string",
        "required": false
      },
      {
        "name": "prompt",
        "type": "string",
        "required": false
      },
      {
        "name": "model",
        "type": "string",
        "required": false
      },
      {
        "name": "duration",
        "type": "number",
        "required": false
      },
      {
        "name": "voice-id",
        "type": "string",
        "required": false
      },
      {
        "name": "voice-name",
        "type": "string",
        "required": false
      },
      {
        "name": "scenario",
        "type": "string",
        "required": false
      },
      {
        "name": "ref",
        "type": "string[]",
        "required": false
      },
      {
        "name": "run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "submit-id",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "node edit element",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "description",
        "type": "string",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tags",
        "type": "boolean",
        "required": false
      },
      {
        "name": "main",
        "type": "string",
        "required": false
      },
      {
        "name": "voice",
        "type": "string",
        "required": false
      },
      {
        "name": "auxiliary",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-description",
        "type": "boolean",
        "required": false
      },
      {
        "name": "clear-main",
        "type": "boolean",
        "required": false
      },
      {
        "name": "clear-voice",
        "type": "boolean",
        "required": false
      },
      {
        "name": "clear-auxiliary",
        "type": "boolean",
        "required": false
      }
    ]
  },
  {
    "command": "node edit text",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "text",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "node edit timeline",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "dryRun": true,
    "flags": [
      {
        "name": "x",
        "type": "number",
        "required": false
      },
      {
        "name": "y",
        "type": "number",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      },
      {
        "name": "resource-source",
        "type": "string[]",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "clip",
        "type": "string[]",
        "required": false
      },
      {
        "name": "audio-clip",
        "type": "string[]",
        "required": false
      },
      {
        "name": "clear-tracks",
        "type": "boolean",
        "required": false
      }
    ]
  },
  {
    "command": "node upscale image",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      },
      {
        "name": "submit-id",
        "type": "string[]",
        "required": false
      },
      {
        "name": "mode",
        "type": "string",
        "required": false
      },
      {
        "name": "resolution",
        "type": "string",
        "required": false
      },
      {
        "name": "detail",
        "type": "integer",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      }
    ]
  },
  {
    "command": "node promote video-sample",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "dryRun": true,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string",
        "required": true
      },
      {
        "name": "resolution",
        "type": "string",
        "required": true
      },
      {
        "name": "submit-id",
        "type": "string",
        "required": false
      },
      {
        "name": "title",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": false
      },
      {
        "name": "wait",
        "type": "boolean",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      },
      {
        "name": "dry-run",
        "type": "boolean",
        "required": false
      }
    ]
  },
  {
    "command": "node delete",
    "reads": true,
    "writes": true,
    "confirmation": true,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": false
      },
      {
        "name": "delete-token",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "node delete confirm",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": true
      }
    ]
  },
  {
    "command": "node delete status",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      },
      {
        "name": "update-id",
        "type": "string",
        "required": true
      }
    ]
  },
  {
    "command": "node show",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      }
    ]
  },
  {
    "command": "node find",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "name",
        "type": "string",
        "required": false
      },
      {
        "name": "type",
        "type": "string[]",
        "required": false
      },
      {
        "name": "status",
        "type": "string[]",
        "required": false
      },
      {
        "name": "tag",
        "type": "string[]",
        "required": false
      },
      {
        "name": "limit",
        "type": "integer",
        "required": false
      },
      {
        "name": "offset",
        "type": "integer",
        "required": false
      }
    ]
  },
  {
    "command": "node quote",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      }
    ]
  },
  {
    "command": "node confirm",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      },
      {
        "name": "credit-ceiling",
        "type": "integer",
        "required": true
      }
    ]
  },
  {
    "command": "node run",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "node-id",
        "type": "string[]",
        "required": true
      },
      {
        "name": "submit-id",
        "type": "string[]",
        "required": false
      },
      {
        "name": "credit-token",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "operation status",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "operation wait",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      },
      {
        "name": "interval",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "resource download",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "output",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "resource get",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "resource upload",
    "reads": false,
    "writes": true,
    "confirmation": false,
    "flags": [
      {
        "name": "file",
        "type": "string",
        "required": false
      },
      {
        "name": "type",
        "type": "string",
        "required": false
      },
      {
        "name": "source-url",
        "type": "string",
        "required": false
      },
      {
        "name": "project-id",
        "type": "string",
        "required": true
      },
      {
        "name": "resource-id",
        "type": "string",
        "required": false
      },
      {
        "name": "name",
        "type": "string",
        "required": false
      },
      {
        "name": "import-kind",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "canvas create",
    "reads": false,
    "writes": true,
    "confirmation": false,
    "flags": [
      {
        "name": "project-id",
        "type": "string",
        "required": false
      },
      {
        "name": "use",
        "type": "boolean",
        "required": false
      }
    ]
  },
  {
    "command": "canvas ls",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "limit",
        "type": "integer",
        "required": false
      },
      {
        "name": "cursor",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "canvas use",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "canvas current",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "auth account",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "auth login",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": [
      {
        "name": "force",
        "type": "boolean",
        "required": false
      }
    ]
  },
  {
    "command": "auth logout",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "auth status",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "auth wait",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": [
      {
        "name": "device-code",
        "type": "string",
        "required": true
      },
      {
        "name": "timeout",
        "type": "duration",
        "required": false
      }
    ]
  },
  {
    "command": "auth refresh",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "schema",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "version",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "team ls",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": [
      {
        "name": "limit",
        "type": "integer",
        "required": false
      },
      {
        "name": "cursor",
        "type": "string",
        "required": false
      }
    ]
  },
  {
    "command": "space use",
    "reads": true,
    "writes": true,
    "confirmation": false,
    "flags": []
  },
  {
    "command": "space current",
    "reads": true,
    "writes": false,
    "confirmation": false,
    "flags": []
  }
];

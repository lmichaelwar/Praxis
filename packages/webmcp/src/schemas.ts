import type { JsonSchema, PraxisWebMcpToolName } from "./types";

const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const idSchema = {
  type: "string",
  minLength: 3,
  maxLength: 128,
  pattern: "^[A-Za-z][A-Za-z0-9:_-]{2,127}$",
} as const;

const reasonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 500,
} as const;

const idempotencyKeySchema = {
  type: "string",
  minLength: 8,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$",
} as const;

const frameSchema = {
  type: "integer",
  minimum: 0,
  maximum: 2_147_483_647,
} as const;

const positiveFrameSchema = {
  type: "integer",
  minimum: 1,
  maximum: 2_147_483_647,
} as const;

const stageSchema = {
  type: "string",
  enum: ["treatment", "script", "previz", "assets", "edit", "finish"],
} as const;

const mutationEnvelopeProperties = {
  baseRevision: { type: "integer", minimum: 0 },
  idempotencyKey: idempotencyKeySchema,
  reason: reasonSchema,
} as const;

const scriptBeatPatchSchema = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: 200 },
    narration: { type: "string", maxLength: 8_000 },
    visualIntent: { type: "string", maxLength: 4_000 },
    deliveryCue: { type: ["string", "null"], maxLength: 500 },
    enhancementCues: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    sourceRefs: {
      type: "array",
      maxItems: 24,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    startFrame: frameSchema,
    durationFrames: positiveFrameSchema,
    status: {
      type: "string",
      enum: ["draft", "approved", "stale", "failed", "rejected"],
    },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

const timelineClipSchema = {
  type: "object",
  properties: {
    clipId: idSchema,
    kind: {
      type: "string",
      enum: [
        "scene",
        "image",
        "audio",
        "music",
        "text",
        "caption",
        "video",
        "placeholder",
      ],
    },
    name: { type: "string", minLength: 1, maxLength: 160 },
    startFrame: frameSchema,
    durationFrames: positiveFrameSchema,
    sceneId: idSchema,
    assetId: idSchema,
    assetVersionId: idSchema,
    sourceStartFrame: frameSchema,
    sourceDurationFrames: positiveFrameSchema,
    versionPolicy: { type: "string", enum: ["pinned", "follow-latest"] },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    transform: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        scale: { type: "number", exclusiveMinimum: 0 },
        rotation: { type: "number" },
      },
      additionalProperties: false,
    },
    transitionIn: { type: "string", maxLength: 120 },
    transitionOut: { type: "string", maxLength: 120 },
  },
  required: ["clipId", "kind", "name", "startFrame", "durationFrames"],
  additionalProperties: false,
} as const;

const timelineClipPatchSchema = {
  type: "object",
  properties: {
    startFrame: frameSchema,
    durationFrames: positiveFrameSchema,
    kind: {
      type: "string",
      enum: [
        "scene",
        "image",
        "audio",
        "music",
        "text",
        "caption",
        "video",
        "placeholder",
      ],
    },
    name: { type: "string", minLength: 1, maxLength: 160 },
    sourceStartFrame: frameSchema,
    sourceDurationFrames: {
      oneOf: [positiveFrameSchema, { type: "null" }],
    },
    sceneId: { oneOf: [idSchema, { type: "null" }] },
    assetId: { oneOf: [idSchema, { type: "null" }] },
    assetVersionId: { oneOf: [idSchema, { type: "null" }] },
    versionPolicy: { type: "string", enum: ["pinned", "follow-latest"] },
    opacity: { type: "number", minimum: 0, maximum: 1 },
    transform: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        scale: { type: "number", exclusiveMinimum: 0 },
        rotation: { type: "number" },
      },
      minProperties: 1,
      additionalProperties: false,
    },
    transitionIn: { type: ["string", "null"], maxLength: 120 },
    transitionOut: { type: ["string", "null"], maxLength: 120 },
    status: {
      type: "string",
      enum: ["draft", "approved", "stale", "failed", "rejected"],
    },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

const projectOperationDefinitions = {
  scriptUpdateBeat: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "script.updateBeat" },
      beatId: idSchema,
      patch: scriptBeatPatchSchema,
    },
    required: ["type", "beatId", "patch"],
    additionalProperties: false,
  },
  sceneSetLocked: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "scene.setLocked" },
      sceneId: idSchema,
      locked: { type: "boolean" },
    },
    required: ["type", "sceneId", "locked"],
    additionalProperties: false,
  },
  sceneSetStatus: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "scene.setStatus" },
      sceneId: idSchema,
      status: {
        type: "string",
        enum: ["draft", "approved", "stale", "failed", "rejected"],
      },
    },
    required: ["type", "sceneId", "status"],
    additionalProperties: false,
  },
  timelineMoveClip: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "timeline.moveClip" },
      clipId: idSchema,
      startFrame: frameSchema,
      targetTrackId: idSchema,
    },
    required: ["type", "clipId", "startFrame"],
    additionalProperties: false,
  },
  timelineInsertClip: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "timeline.insertClip" },
      trackId: idSchema,
      clip: timelineClipSchema,
    },
    required: ["type", "trackId", "clip"],
    additionalProperties: false,
  },
  timelineUpdateClip: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "timeline.updateClip" },
      clipId: idSchema,
      patch: timelineClipPatchSchema,
    },
    required: ["type", "clipId", "patch"],
    additionalProperties: false,
  },
  timelineRemoveClip: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "timeline.removeClip" },
      clipId: idSchema,
    },
    required: ["type", "clipId"],
    additionalProperties: false,
  },
  proposalAccept: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "proposal.accept" },
      decisionId: idSchema,
      resolutionReason: { type: "string", maxLength: 1_000 },
    },
    required: ["type", "decisionId"],
    additionalProperties: false,
  },
  proposalReject: {
    type: "object",
    properties: {
      operationId: idSchema,
      type: { const: "proposal.reject" },
      decisionId: idSchema,
      resolutionReason: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    required: ["type", "decisionId", "resolutionReason"],
    additionalProperties: false,
  },
} as const;

export const PRAXIS_WEBMCP_INPUT_SCHEMAS = {
  get_project_context: emptyInputSchema,
  get_current_selection: emptyInputSchema,
  get_change_history: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      sinceRevision: { type: "integer", minimum: 0 },
      actor: { type: "string", enum: ["director", "codex", "system"] },
    },
    additionalProperties: false,
  },
  apply_project_operations: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      dryRun: { type: "boolean", default: false },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          oneOf: Object.keys(projectOperationDefinitions).map((name) => ({
            $ref: `#/$defs/${name}`,
          })),
        },
      },
    },
    required: ["baseRevision", "idempotencyKey", "operations"],
    additionalProperties: false,
    $defs: projectOperationDefinitions,
  },
  set_delegation: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      policies: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        items: {
          type: "object",
          properties: {
            stage: stageSchema,
            mode: { type: "string", enum: ["observe", "propose", "act", "locked"] },
            entityIds: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              uniqueItems: true,
              items: idSchema,
            },
            maxSpendUsd: { type: "number", minimum: 0, maximum: 100 },
            checkpointAfterStage: { type: "boolean" },
          },
          required: ["stage", "mode"],
          additionalProperties: false,
        },
      },
    },
    required: ["baseRevision", "idempotencyKey", "policies"],
    additionalProperties: false,
  },
  create_checkpoint: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      label: { type: "string", minLength: 1, maxLength: 120 },
    },
    required: ["baseRevision", "idempotencyKey"],
    additionalProperties: false,
  },
  restore_checkpoint: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      checkpointId: idSchema,
      dryRun: { type: "boolean", default: false },
    },
    required: ["baseRevision", "idempotencyKey", "checkpointId"],
    additionalProperties: false,
  },
  run_qc: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      scope: { type: "string", enum: ["project", "selection", "timeline"], default: "project" },
      checks: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        items: {
          type: "string",
          enum: [
            "timing",
            "missing_media",
            "narration_overrun",
            "black_frames",
            "audio_clipping",
            "delivery",
          ],
        },
      },
    },
    required: ["baseRevision", "idempotencyKey"],
    additionalProperties: false,
  },
  delegate_production_run: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      role: { type: "string", enum: ["producer-editor", "reviewer"] },
      stages: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        uniqueItems: true,
        items: stageSchema,
      },
      mode: { type: "string", enum: ["propose", "act"] },
      maxSpendUsd: { type: "number", minimum: 0, maximum: 100 },
      preserveLockedEntities: { const: true },
    },
    required: [
      "baseRevision",
      "idempotencyKey",
      "role",
      "stages",
      "mode",
      "maxSpendUsd",
      "preserveLockedEntities",
    ],
    additionalProperties: false,
  },
  generate_scene_asset: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      sceneId: idSchema,
      prompt: { type: "string", minLength: 1, maxLength: 4_000 },
    },
    required: ["baseRevision", "idempotencyKey", "sceneId"],
    additionalProperties: false,
  },
  generate_narration: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      beatIds: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
        items: idSchema,
      },
    },
    required: ["baseRevision", "idempotencyKey"],
    additionalProperties: false,
  },
  start_render: {
    type: "object",
    properties: {
      ...mutationEnvelopeProperties,
      kind: { type: "string", enum: ["preview", "final"] },
    },
    required: ["baseRevision", "idempotencyKey", "kind"],
    additionalProperties: false,
  },
  get_job_status: {
    type: "object",
    properties: { jobId: idSchema },
    required: ["jobId"],
    additionalProperties: false,
  },
  cancel_job: {
    type: "object",
    properties: { jobId: idSchema },
    required: ["jobId"],
    additionalProperties: false,
  },
} as const satisfies Record<PraxisWebMcpToolName, JsonSchema>;

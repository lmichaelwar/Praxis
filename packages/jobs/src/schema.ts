import { IsoDateTimeSchema, StableIdSchema } from "@praxis/project-schema";
import { AgentRunStatusSchema } from "@praxis/agent-runs";
import { z } from "zod";

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_external",
  "succeeded",
  "failed",
  "cancel_requested",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const MediaJobTypeSchema = z.enum([
  "image.generate",
  "speech.generate",
  "render.preview",
  "render.final",
]);
export type MediaJobType = z.infer<typeof MediaJobTypeSchema>;

export const ProviderModeSchema = z.enum(["fake", "openai"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const ImageGenerationRequestSchema = z
  .object({
    assetId: StableIdSchema,
    sceneId: StableIdSchema,
    prompt: z.string().min(1).max(4_000),
    size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1536x1024"),
    format: z.enum(["png", "jpeg", "webp"]).default("png"),
    quality: z.enum(["low", "medium", "high"]).default("low"),
    provider: ProviderModeSchema.default("fake"),
    model: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ImageGenerationRequest = z.infer<typeof ImageGenerationRequestSchema>;

export const SpeechGenerationRequestSchema = z
  .object({
    assetId: StableIdSchema,
    beatIds: z.array(StableIdSchema).min(1).max(64).optional(),
    text: z.string().min(1).max(4_096).optional(),
    provider: ProviderModeSchema.default("fake"),
    model: z.string().min(1).max(128).optional(),
    voice: z.string().min(1).max(128).optional(),
    instructions: z.string().max(1_000).optional(),
    format: z.literal("wav").default("wav"),
  })
  .strict()
  .superRefine((request, context) => {
    if (!request.text && !request.beatIds?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["beatIds"],
        message: "Speech generation requires text or at least one beat ID",
      });
    }
  });
export type SpeechGenerationRequest = z.infer<typeof SpeechGenerationRequestSchema>;

export const RenderRequestSchema = z
  .object({
    renderId: StableIdSchema.optional(),
    rendererVersion: z.string().min(1).max(128).default("praxis-ffmpeg-1"),
  })
  .strict();
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

const JobCreateBaseSchema = z.object({
  jobId: StableIdSchema.optional(),
  idempotencyKey: z.string().min(8).max(160),
  baseRevision: z.number().int().nonnegative(),
  targetEntityIds: z.array(StableIdSchema).max(128).default([]),
});

export const JobCreateRequestSchema = z.discriminatedUnion("jobType", [
  JobCreateBaseSchema.extend({
    jobType: z.literal("image.generate"),
    request: ImageGenerationRequestSchema,
  }).strict(),
  JobCreateBaseSchema.extend({
    jobType: z.literal("speech.generate"),
    request: SpeechGenerationRequestSchema,
  }).strict(),
  JobCreateBaseSchema.extend({
    jobType: z.literal("render.preview"),
    request: RenderRequestSchema.default({ rendererVersion: "praxis-ffmpeg-1" }),
  }).strict(),
  JobCreateBaseSchema.extend({
    jobType: z.literal("render.final"),
    request: RenderRequestSchema.default({ rendererVersion: "praxis-ffmpeg-1" }),
  }).strict(),
]);
export type JobCreateRequest = z.infer<typeof JobCreateRequestSchema>;

export const JobActorSchema = z
  .object({
    kind: z.enum(["director", "codex", "system"]),
    id: z.string().min(1).max(160),
    runId: z.string().min(1).max(160).optional(),
    capabilityMaxSpendUsd: z.number().nonnegative().finite().optional(),
  })
  .strict();
export type JobActor = z.infer<typeof JobActorSchema>;

export const JobOutputSchema = z
  .object({
    assetId: StableIdSchema.optional(),
    assetVersionId: StableIdSchema.optional(),
    renderId: StableIdSchema.optional(),
    objectKey: z.string().min(1).max(1_024),
    posterObjectKey: z.string().min(1).max(1_024).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    posterSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    mimeType: z.string().min(1).max(160),
    byteLength: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    attached: z.boolean().default(false),
    stale: z.boolean().default(false),
    projectRevision: z.number().int().nonnegative(),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();
export type JobOutput = z.infer<typeof JobOutputSchema>;

export const JobRecordSchema = z
  .object({
    jobId: StableIdSchema,
    projectId: StableIdSchema,
    idempotencyKey: z.string().min(8).max(160),
    jobType: MediaJobTypeSchema,
    status: JobStatusSchema,
    actor: JobActorSchema,
    baseRevision: z.number().int().nonnegative(),
    targetEntityIds: z.array(StableIdSchema),
    request: z.record(z.unknown()),
    estimatedCostUsd: z.number().nonnegative().finite(),
    reservedCostUsd: z.number().nonnegative().finite(),
    settledCostUsd: z.number().nonnegative().finite(),
    costIsEstimate: z.boolean().default(true),
    attempt: z.number().int().nonnegative(),
    workflowId: z.string().max(160).optional(),
    output: JobOutputSchema.optional(),
    errorCode: z.string().max(160).optional(),
    errorMessage: z.string().max(2_000).optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const BudgetSummarySchema = z
  .object({
    maxSpendUsd: z.number().nonnegative(),
    reservedUsd: z.number().nonnegative(),
    settledUsd: z.number().nonnegative(),
    availableUsd: z.number(),
  })
  .strict();
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;

export const PersistedAssetRecordSchema = z
  .object({
    assetId: StableIdSchema,
    assetVersionId: StableIdSchema,
    projectId: StableIdSchema,
    kind: z.enum(["image", "audio", "music", "video", "render", "poster", "other"]),
    objectKey: z.string().min(1).max(1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.string().min(1).max(160),
    byteLength: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    provenance: z.record(z.unknown()),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type PersistedAssetRecord = z.infer<typeof PersistedAssetRecordSchema>;

export const RenderRecordSchema = z
  .object({
    renderId: StableIdSchema,
    projectId: StableIdSchema,
    jobId: StableIdSchema,
    projectRevision: z.number().int().nonnegative(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    manifestObjectKey: z.string().min(1).max(1_024).optional(),
    outputObjectKey: z.string().min(1).max(1_024),
    posterObjectKey: z.string().min(1).max(1_024).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationMs: z.number().int().positive(),
    videoCodec: z.literal("h264"),
    audioCodec: z.literal("aac").optional(),
    pixelFormat: z.literal("yuv420p"),
    outdated: z.boolean(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type RenderRecord = z.infer<typeof RenderRecordSchema>;

export const ProjectEventTypeSchema = z.enum([
  "project.committed",
  "project.restored",
  "job.updated",
  "asset.created",
  "render.ready",
  "render.outdated",
  "agent_run.updated",
]);
export type ProjectEventType = z.infer<typeof ProjectEventTypeSchema>;

export const ProjectEventSchema = z
  .object({
    sequence: z.number().int().positive(),
    projectId: StableIdSchema,
    type: ProjectEventTypeSchema,
    createdAt: IsoDateTimeSchema,
    revision: z.number().int().nonnegative().optional(),
    commandId: StableIdSchema.optional(),
    checkpointId: StableIdSchema.optional(),
    jobId: StableIdSchema.optional(),
    status: JobStatusSchema.optional(),
    assetVersionId: StableIdSchema.optional(),
    renderId: StableIdSchema.optional(),
    currentRevision: z.number().int().nonnegative().optional(),
    agentRunId: StableIdSchema.optional(),
    agentRunStatus: AgentRunStatusSchema.optional(),
  })
  .strict();
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;

export const JobTransitionSchema = z
  .object({
    expectedStatuses: z.array(JobStatusSchema).min(1),
    status: JobStatusSchema,
    attempt: z.number().int().nonnegative().optional(),
    workflowId: z.string().max(160).optional(),
    output: JobOutputSchema.optional(),
    actualCostUsd: z.number().nonnegative().finite().optional(),
    costIsEstimate: z.boolean().optional(),
    errorCode: z.string().max(160).optional(),
    errorMessage: z.string().max(2_000).optional(),
  })
  .strict();
export type JobTransition = z.infer<typeof JobTransitionSchema>;

export const terminalJobStatuses = new Set<JobStatus>(["succeeded", "failed", "cancelled"]);

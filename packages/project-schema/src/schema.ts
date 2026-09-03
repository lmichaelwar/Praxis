import { z } from "zod";

export const SCHEMA_VERSION = "0.1" as const;

export const StableIdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9:_-]*$/, "Use a stable, URL-safe entity ID");

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const ActorKindSchema = z.enum(["director", "codex", "system"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

export const EntityStatusSchema = z.enum([
  "draft",
  "approved",
  "stale",
  "failed",
  "rejected",
]);
export type EntityStatus = z.infer<typeof EntityStatusSchema>;

export const EntityMetaSchema = z
  .object({
    id: StableIdSchema,
    revisionCreated: z.number().int().nonnegative(),
    revisionUpdated: z.number().int().nonnegative(),
    authoredBy: ActorKindSchema,
    lastEditedBy: ActorKindSchema.optional(),
    locked: z.boolean().default(false),
    status: EntityStatusSchema.default("draft"),
    derivedFrom: z.array(StableIdSchema).default([]),
    generationJobId: StableIdSchema.optional(),
  })
  .strict()
  .superRefine((meta, context) => {
    if (meta.revisionUpdated < meta.revisionCreated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["revisionUpdated"],
        message: "revisionUpdated cannot precede revisionCreated",
      });
    }
  });
export type EntityMeta = z.infer<typeof EntityMetaSchema>;

export const TimeRangeSchema = z
  .object({
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
  })
  .strict();
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const ProjectMetadataSchema = z
  .object({
    title: z.string().min(1).max(120),
    tagline: z.string().max(240).optional(),
    description: z.string().max(2_000).default(""),
    fps: z.number().int().min(1).max(120),
    frameSize: z
      .object({
        width: z.number().int().positive().max(16_384),
        height: z.number().int().positive().max(16_384),
      })
      .strict(),
    aspectRatio: z.enum(["16:9", "9:16", "1:1", "4:3"]),
    durationFrames: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

export const ProductionBriefSchema = z
  .object({
    premise: z.string().min(1).max(2_000),
    objective: z.string().min(1).max(2_000),
    audience: z.string().min(1).max(500),
    tone: z.array(z.string().min(1).max(80)).min(1).max(12),
    targetDurationFrames: z.number().int().positive(),
    callToAction: z.string().max(500).optional(),
  })
  .strict();
export type ProductionBrief = z.infer<typeof ProductionBriefSchema>;

export const StyleBibleSchema = z
  .object({
    visualDirection: z.string().min(1).max(2_000),
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1).max(12),
    typography: z.array(z.string().min(1).max(120)).max(8),
    motionLanguage: z.array(z.string().min(1).max(240)).max(12),
    audioDirection: z.string().max(1_000).optional(),
  })
  .strict();
export type StyleBible = z.infer<typeof StyleBibleSchema>;

export const ScriptBeatSchema = z
  .object({
    meta: EntityMetaSchema,
    order: z.number().int().nonnegative(),
    title: z.string().min(1).max(160),
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
    narration: z.string().max(2_000),
    visualIntent: z.string().min(1).max(2_000),
    deliveryCue: z.string().max(500).optional(),
    enhancementCues: z.array(z.string().min(1).max(500)).max(12).default([]),
    sourceRefs: z.array(z.string().min(1).max(500)).max(24).default([]),
  })
  .strict();
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

export const SceneSchema = z
  .object({
    meta: EntityMetaSchema,
    beatId: StableIdSchema,
    order: z.number().int().nonnegative(),
    title: z.string().min(1).max(160),
    narrativeRole: z.string().min(1).max(500),
    informationRole: z.string().max(500).default(""),
    visualDescription: z.string().min(1).max(2_000),
    shotIntent: z.string().min(1).max(1_000),
    cameraLanguage: z.string().max(1_000).default("Locked-off"),
    estimatedDurationFrames: z.number().int().positive(),
    requiredAssetIds: z.array(StableIdSchema).default([]),
    heroMoment: z.boolean().default(false),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

export const AssetKindSchema = z.enum([
  "image",
  "audio",
  "music",
  "video",
  "text",
  "font",
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const AssetVersionStatusSchema = z.enum([
  "planned",
  "generating",
  "ready",
  "approved",
  "rejected",
  "stale",
  "failed",
]);

/**
 * An object-store key, never a filesystem path or executable URL. Media bytes
 * remain outside the canonical graph and are resolved by a trusted adapter.
 */
export const ObjectStorageKeySchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "Use a relative, URL-safe object key")
  .refine(
    (key) => !key.includes("://") && key.split("/").every((segment) => segment !== "." && segment !== ".."),
    "Object keys cannot be URLs or contain relative path segments",
  );

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "Use a lowercase SHA-256 digest");

export const AssetVersionProvenanceSchema = z
  .object({
    projectRevision: z.number().int().nonnegative(),
    jobId: StableIdSchema.optional(),
    sourceAssetVersionIds: z.array(StableIdSchema).max(32).default([]),
    providerRequestId: z.string().min(1).max(256).optional(),
  })
  .strict();
export type AssetVersionProvenance = z.infer<typeof AssetVersionProvenanceSchema>;

export const AssetVersionSchema = z
  .object({
    id: StableIdSchema,
    version: z.number().int().positive(),
    status: AssetVersionStatusSchema,
    uri: z.string().min(1).max(2_048),
    mimeType: z.string().min(1).max(160),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationFrames: z.number().int().positive().optional(),
    createdAt: IsoDateTimeSchema,
    provider: z.string().max(160).optional(),
    model: z.string().max(160).optional(),
    prompt: z.string().max(4_000).optional(),
    costUsd: z.number().nonnegative().optional(),
    checksum: z.string().max(256).optional(),
    objectKey: ObjectStorageKeySchema.optional(),
    sha256: Sha256Schema.optional(),
    byteLength: z.number().int().positive().optional(),
    durationMs: z.number().int().positive().optional(),
    provenance: AssetVersionProvenanceSchema.optional(),
  })
  .strict();
export type AssetVersion = z.infer<typeof AssetVersionSchema>;

export const AssetRecordSchema = z
  .object({
    meta: EntityMetaSchema,
    kind: AssetKindSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(2_000).default(""),
    currentVersionId: StableIdSchema.optional(),
    versions: z.array(AssetVersionSchema).default([]),
    tags: z.array(z.string().min(1).max(80)).max(24).default([]),
    pinned: z.boolean().default(false),
  })
  .strict()
  .superRefine((asset, context) => {
    const versionIds = new Set<string>();
    const versionNumbers = new Set<number>();
    for (const [index, version] of asset.versions.entries()) {
      if (versionIds.has(version.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["versions", index, "id"],
          message: `Duplicate asset version ID: ${version.id}`,
        });
      }
      if (versionNumbers.has(version.version)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["versions", index, "version"],
          message: `Duplicate asset version number: ${version.version}`,
        });
      }
      versionIds.add(version.id);
      versionNumbers.add(version.version);
    }

    if (asset.currentVersionId && !versionIds.has(asset.currentVersionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentVersionId"],
        message: "currentVersionId must reference one of the asset versions",
      });
    }
  });
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

export const TimelineTrackKindSchema = z.enum([
  "video",
  "overlay",
  "audio",
  "captions",
]);
export type TimelineTrackKind = z.infer<typeof TimelineTrackKindSchema>;

export const TimelineClipKindSchema = z.enum([
  "scene",
  "image",
  "audio",
  "music",
  "text",
  "caption",
  "video",
  "placeholder",
]);
export type TimelineClipKind = z.infer<typeof TimelineClipKindSchema>;

export const ClipTransformSchema = z
  .object({
    x: z.number().finite().default(0),
    y: z.number().finite().default(0),
    scale: z.number().positive().finite().default(1),
    rotation: z.number().finite().default(0),
  })
  .strict();

export const RenderColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, "Use a six- or eight-digit hex color");

/** A deliberately bounded text style understood by deterministic renderers. */
export const TimelineTextStyleSchema = z
  .object({
    fontFamily: z.string().min(1).max(160).default("Inter Variable"),
    fontSizePx: z.number().positive().max(512).default(64),
    fontWeight: z.number().int().min(100).max(900).default(600),
    fontStyle: z.enum(["normal", "italic"]).default("normal"),
    color: RenderColorSchema.default("#FFFFFF"),
    backgroundColor: RenderColorSchema.optional(),
    textAlign: z.enum(["left", "center", "right"]).default("center"),
    lineHeight: z.number().min(0.5).max(4).default(1.2),
    letterSpacingPx: z.number().finite().min(-32).max(128).default(0),
  })
  .strict();
export type TimelineTextStyle = z.infer<typeof TimelineTextStyleSchema>;

export const TimelineTextPayloadSchema = z.string().max(8_000);
export const ClipGainDbSchema = z.number().finite().min(-96).max(24);

export const TimelineClipSchema = z
  .object({
    meta: EntityMetaSchema,
    kind: TimelineClipKindSchema,
    name: z.string().min(1).max(160),
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
    sourceStartFrame: z.number().int().nonnegative().default(0),
    sourceDurationFrames: z.number().int().positive().optional(),
    sceneId: StableIdSchema.optional(),
    assetId: StableIdSchema.optional(),
    assetVersionId: StableIdSchema.optional(),
    versionPolicy: z.enum(["pinned", "follow-latest"]).default("pinned"),
    opacity: z.number().min(0).max(1).default(1),
    transform: ClipTransformSchema.default({}),
    text: TimelineTextPayloadSchema.optional(),
    textStyle: TimelineTextStyleSchema.optional(),
    gainDb: ClipGainDbSchema.optional(),
    transitionIn: z.string().max(120).optional(),
    transitionOut: z.string().max(120).optional(),
  })
  .strict()
  .superRefine((clip, context) => {
    if ((clip.text !== undefined || clip.textStyle !== undefined) && !["text", "caption"].includes(clip.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [clip.text !== undefined ? "text" : "textStyle"],
        message: "Text payload and style require a text or caption clip",
      });
    }
    if (clip.gainDb !== undefined && !["audio", "music", "video", "scene"].includes(clip.kind)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gainDb"],
        message: "Audio gain requires an audio-capable clip",
      });
    }
  });
export type TimelineClip = z.infer<typeof TimelineClipSchema>;

export const TimelineTrackSchema = z
  .object({
    meta: EntityMetaSchema,
    name: z.string().min(1).max(120),
    kind: TimelineTrackKindSchema,
    order: z.number().int().nonnegative(),
    muted: z.boolean().default(false),
    solo: z.boolean().default(false),
    clips: z.array(TimelineClipSchema).default([]),
  })
  .strict();
export type TimelineTrack = z.infer<typeof TimelineTrackSchema>;

export const TimelineDocumentSchema = z
  .object({
    meta: EntityMetaSchema,
    fps: z.number().int().min(1).max(120),
    durationFrames: z.number().int().nonnegative(),
    tracks: z.array(TimelineTrackSchema).min(1),
  })
  .strict();
export type TimelineDocument = z.infer<typeof TimelineDocumentSchema>;

export const StageNameSchema = z.enum([
  "treatment",
  "script",
  "previz",
  "assets",
  "edit",
  "finish",
]);
export type StageName = z.infer<typeof StageNameSchema>;
export const STAGE_NAMES = StageNameSchema.options;

export const StageStatusSchema = z.enum([
  "pending",
  "active",
  "ready",
  "approved",
  "stale",
  "failed",
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const StageStateSchema = z
  .object({
    name: StageNameSchema,
    status: StageStatusSchema,
    revisionUpdated: z.number().int().nonnegative(),
    staleReasons: z.array(z.string().min(1).max(500)).default([]),
    approvedAt: IsoDateTimeSchema.optional(),
  })
  .strict();
export type StageState = z.infer<typeof StageStateSchema>;

export const StagesSchema = z
  .object({
    treatment: StageStateSchema,
    script: StageStateSchema,
    previz: StageStateSchema,
    assets: StageStateSchema,
    edit: StageStateSchema,
    finish: StageStateSchema,
  })
  .strict()
  .superRefine((stages, context) => {
    for (const name of STAGE_NAMES) {
      if (stages[name].name !== name) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name, "name"],
          message: `Stage map entry ${name} must have name ${name}`,
        });
      }
    }
  });
export type Stages = z.infer<typeof StagesSchema>;

export const DelegationModeSchema = z.enum(["observe", "propose", "act", "locked"]);
export type DelegationMode = z.infer<typeof DelegationModeSchema>;

export const DelegationPolicySchema = z
  .object({
    stage: StageNameSchema,
    mode: DelegationModeSchema,
    maxSpendUsd: z.number().nonnegative().optional(),
    checkpointAfterStage: z.boolean().default(false),
  })
  .strict();
export type DelegationPolicy = z.infer<typeof DelegationPolicySchema>;

export const DelegationMapSchema = z
  .object({
    treatment: DelegationPolicySchema,
    script: DelegationPolicySchema,
    previz: DelegationPolicySchema,
    assets: DelegationPolicySchema,
    edit: DelegationPolicySchema,
    finish: DelegationPolicySchema,
  })
  .strict()
  .superRefine((delegation, context) => {
    for (const stage of STAGE_NAMES) {
      if (delegation[stage].stage !== stage) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [stage, "stage"],
          message: `Delegation map entry ${stage} must target stage ${stage}`,
        });
      }
    }
  });
export type DelegationMap = z.infer<typeof DelegationMapSchema>;

export const DecisionStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "superseded",
]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionRecordSchema = z
  .object({
    meta: EntityMetaSchema,
    kind: z.enum(["proposal", "approval", "rejection", "note"]),
    stage: StageNameSchema.optional(),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(2_000),
    status: DecisionStatusSchema,
    proposedBy: ActorKindSchema,
    proposedAt: IsoDateTimeSchema,
    proposedOperations: z.array(z.record(z.unknown())).max(50).default([]),
    resolvedBy: ActorKindSchema.optional(),
    resolvedAt: IsoDateTimeSchema.optional(),
    resolutionReason: z.string().max(1_000).optional(),
  })
  .strict();
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const CheckpointRefSchema = z
  .object({
    id: StableIdSchema,
    label: z.string().min(1).max(160),
    revision: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
    createdBy: ActorKindSchema,
    reason: z.string().max(1_000).optional(),
  })
  .strict();
export type CheckpointRef = z.infer<typeof CheckpointRefSchema>;

export const DeliverySpecSchema = z
  .object({
    container: z.enum(["mp4", "webm"]),
    videoCodec: z.enum(["h264", "h265", "vp9", "av1"]),
    audioCodec: z.enum(["aac", "opus"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    quality: z.enum(["preview", "standard", "high"]),
  })
  .strict();
export type DeliverySpec = z.infer<typeof DeliverySpecSchema>;

const addUniqueId = (
  id: string,
  path: Array<string | number>,
  ids: Map<string, Array<string | number>>,
  context: z.RefinementCtx,
) => {
  const previousPath = ids.get(id);
  if (previousPath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Entity ID ${id} is already used at ${previousPath.join(".")}`,
    });
    return;
  }
  ids.set(id, path);
};

export const ProductionProjectSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    projectId: StableIdSchema,
    revision: z.number().int().nonnegative(),
    metadata: ProjectMetadataSchema,
    brief: ProductionBriefSchema,
    style: StyleBibleSchema,
    script: z
      .object({
        beats: z.array(ScriptBeatSchema).default([]),
      })
      .strict(),
    scenes: z.array(SceneSchema).default([]),
    assets: z.record(StableIdSchema, AssetRecordSchema).default({}),
    timeline: TimelineDocumentSchema,
    stages: StagesSchema,
    delegation: DelegationMapSchema,
    decisions: z.array(DecisionRecordSchema).default([]),
    checkpoints: z.array(CheckpointRefSchema).default([]),
    delivery: DeliverySpecSchema,
  })
  .strict()
  .superRefine((project, context) => {
    const ids = new Map<string, Array<string | number>>();
    addUniqueId(project.projectId, ["projectId"], ids, context);

    const beatIds = new Set<string>();
    project.script.beats.forEach((beat, index) => {
      addUniqueId(beat.meta.id, ["script", "beats", index, "meta", "id"], ids, context);
      beatIds.add(beat.meta.id);
      if (beat.startFrame + beat.durationFrames > project.metadata.durationFrames) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["script", "beats", index, "durationFrames"],
          message: "Beat extends beyond the project duration",
        });
      }
    });

    const assetIds = new Set(Object.keys(project.assets));
    for (const [assetKey, asset] of Object.entries(project.assets)) {
      if (assetKey !== asset.meta.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assets", assetKey, "meta", "id"],
          message: "Asset record key must match asset.meta.id",
        });
      }
      addUniqueId(asset.meta.id, ["assets", assetKey, "meta", "id"], ids, context);
      asset.versions.forEach((version, index) =>
        addUniqueId(version.id, ["assets", assetKey, "versions", index, "id"], ids, context),
      );
    }

    const sceneIds = new Set<string>();
    project.scenes.forEach((scene, index) => {
      addUniqueId(scene.meta.id, ["scenes", index, "meta", "id"], ids, context);
      sceneIds.add(scene.meta.id);
      if (!beatIds.has(scene.beatId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenes", index, "beatId"],
          message: `Unknown script beat: ${scene.beatId}`,
        });
      }
      scene.requiredAssetIds.forEach((assetId, assetIndex) => {
        if (!assetIds.has(assetId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scenes", index, "requiredAssetIds", assetIndex],
            message: `Unknown asset: ${assetId}`,
          });
        }
      });
    });

    addUniqueId(project.timeline.meta.id, ["timeline", "meta", "id"], ids, context);
    project.timeline.tracks.forEach((track, trackIndex) => {
      addUniqueId(track.meta.id, ["timeline", "tracks", trackIndex, "meta", "id"], ids, context);
      track.clips.forEach((clip, clipIndex) => {
        const path = ["timeline", "tracks", trackIndex, "clips", clipIndex] as const;
        addUniqueId(clip.meta.id, [...path, "meta", "id"], ids, context);
        if (clip.startFrame + clip.durationFrames > project.timeline.durationFrames) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "durationFrames"],
            message: "Clip extends beyond the timeline duration",
          });
        }
        if (clip.sceneId && !sceneIds.has(clip.sceneId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "sceneId"],
            message: `Unknown scene: ${clip.sceneId}`,
          });
        }
        if (clip.assetId && !assetIds.has(clip.assetId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "assetId"],
            message: `Unknown asset: ${clip.assetId}`,
          });
        }
        if (clip.assetId && clip.assetVersionId) {
          const asset = project.assets[clip.assetId];
          if (asset && !asset.versions.some((version) => version.id === clip.assetVersionId)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, "assetVersionId"],
              message: `Version ${clip.assetVersionId} does not belong to ${clip.assetId}`,
            });
          }
        }
        if (clip.assetVersionId && !clip.assetId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "assetVersionId"],
            message: "assetVersionId requires an assetId",
          });
        }
      });
    });

    project.decisions.forEach((decision, index) =>
      addUniqueId(decision.meta.id, ["decisions", index, "meta", "id"], ids, context),
    );
    project.checkpoints.forEach((checkpoint, index) => {
      addUniqueId(checkpoint.id, ["checkpoints", index, "id"], ids, context);
      if (checkpoint.revision > project.revision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["checkpoints", index, "revision"],
          message: "Checkpoint cannot reference a future project revision",
        });
      }
    });

    if (project.timeline.fps !== project.metadata.fps) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeline", "fps"],
        message: "Timeline and project frame rates must match",
      });
    }
    if (project.timeline.durationFrames !== project.metadata.durationFrames) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeline", "durationFrames"],
        message: "Timeline and project durations must match",
      });
    }
    if (
      project.delivery.width !== project.metadata.frameSize.width ||
      project.delivery.height !== project.metadata.frameSize.height ||
      project.delivery.fps !== project.metadata.fps
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delivery"],
        message: "Delivery dimensions and frame rate must match project metadata",
      });
    }
  });
export type ProductionProject = z.infer<typeof ProductionProjectSchema>;

/** Creates canonical metadata for a newly inserted entity. */
export const createEntityMeta = (
  id: string,
  revision: number,
  authoredBy: ActorKind,
  overrides: Partial<Omit<EntityMeta, "id" | "revisionCreated" | "revisionUpdated" | "authoredBy">> = {},
): EntityMeta =>
  EntityMetaSchema.parse({
    id,
    revisionCreated: revision,
    revisionUpdated: revision,
    authoredBy,
    locked: false,
    status: "draft",
    derivedFrom: [],
    ...overrides,
  });

export const parseProductionProject = (input: unknown): ProductionProject =>
  ProductionProjectSchema.parse(input);

export const safeParseProductionProject = (input: unknown) =>
  ProductionProjectSchema.safeParse(input);

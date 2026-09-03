import {
  ActorKindSchema,
  AssetKindSchema,
  AssetVersionSchema,
  CheckpointRefSchema,
  ClipGainDbSchema,
  ClipTransformSchema,
  DecisionStatusSchema,
  EntityStatusSchema,
  IsoDateTimeSchema,
  ProductionProjectSchema,
  StableIdSchema,
  StageNameSchema,
  DelegationModeSchema,
  TimelineClipKindSchema,
  TimelineClipSchema,
  TimelineTextPayloadSchema,
  TimelineTextStyleSchema,
} from "@praxis/project-schema";
import { z } from "zod";

const withOperationId = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({
      operationId: StableIdSchema.optional(),
      ...shape,
    })
    .strict();

export const ScriptBeatPatchSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    startFrame: z.number().int().nonnegative().optional(),
    durationFrames: z.number().int().positive().optional(),
    narration: z.string().max(2_000).optional(),
    visualIntent: z.string().min(1).max(2_000).optional(),
    deliveryCue: z.string().max(500).nullable().optional(),
    enhancementCues: z.array(z.string().min(1).max(500)).max(12).optional(),
    sourceRefs: z.array(z.string().min(1).max(500)).max(24).optional(),
    status: EntityStatusSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Beat patch cannot be empty");
export type ScriptBeatPatch = z.infer<typeof ScriptBeatPatchSchema>;

export const ScenePatchSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    narrativeRole: z.string().min(1).max(500).optional(),
    informationRole: z.string().max(500).optional(),
    visualDescription: z.string().min(1).max(2_000).optional(),
    shotIntent: z.string().min(1).max(1_000).optional(),
    cameraLanguage: z.string().max(1_000).optional(),
    estimatedDurationFrames: z.number().int().positive().optional(),
    requiredAssetIds: z.array(StableIdSchema).max(64).optional(),
    heroMoment: z.boolean().optional(),
  })
  .strict()
  .superRefine((patch, context) => {
    if (
      patch.requiredAssetIds !== undefined &&
      new Set(patch.requiredAssetIds).size !== patch.requiredAssetIds.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiredAssetIds"],
        message: "Scene required asset IDs must be unique",
      });
    }
  })
  .refine((patch) => Object.keys(patch).length > 0, "Scene patch cannot be empty");
export type ScenePatch = z.infer<typeof ScenePatchSchema>;

export const TimelineClipPatchSchema = z
  .object({
    kind: TimelineClipKindSchema.optional(),
    name: z.string().min(1).max(160).optional(),
    startFrame: z.number().int().nonnegative().optional(),
    durationFrames: z.number().int().positive().optional(),
    sourceStartFrame: z.number().int().nonnegative().optional(),
    sourceDurationFrames: z.number().int().positive().nullable().optional(),
    sceneId: StableIdSchema.nullable().optional(),
    assetId: StableIdSchema.nullable().optional(),
    assetVersionId: StableIdSchema.nullable().optional(),
    versionPolicy: z.enum(["pinned", "follow-latest"]).optional(),
    opacity: z.number().min(0).max(1).optional(),
    transform: ClipTransformSchema.partial().strict().optional(),
    text: TimelineTextPayloadSchema.nullable().optional(),
    textStyle: TimelineTextStyleSchema.partial().strict().nullable().optional(),
    gainDb: ClipGainDbSchema.nullable().optional(),
    transitionIn: z.string().max(120).nullable().optional(),
    transitionOut: z.string().max(120).nullable().optional(),
    status: EntityStatusSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "Clip patch cannot be empty");
export type TimelineClipPatch = z.infer<typeof TimelineClipPatchSchema>;

export const UpdateBeatOperationSchema = withOperationId({
  type: z.literal("script.updateBeat"),
  beatId: StableIdSchema,
  patch: ScriptBeatPatchSchema,
});

export const UpdateSceneOperationSchema = withOperationId({
  type: z.literal("scene.update"),
  sceneId: StableIdSchema,
  patch: ScenePatchSchema,
});

export const SetSceneLockedOperationSchema = withOperationId({
  type: z.literal("scene.setLocked"),
  sceneId: StableIdSchema,
  locked: z.boolean(),
});

export const SetSceneStatusOperationSchema = withOperationId({
  type: z.literal("scene.setStatus"),
  sceneId: StableIdSchema,
  status: EntityStatusSchema,
});

export const MoveClipOperationSchema = withOperationId({
  type: z.literal("timeline.moveClip"),
  clipId: StableIdSchema,
  startFrame: z.number().int().nonnegative(),
  targetTrackId: StableIdSchema.optional(),
});

export const InsertClipOperationSchema = withOperationId({
  type: z.literal("timeline.insertClip"),
  trackId: StableIdSchema,
  clip: TimelineClipSchema,
});

export const UpdateClipOperationSchema = withOperationId({
  type: z.literal("timeline.updateClip"),
  clipId: StableIdSchema,
  patch: TimelineClipPatchSchema,
});

export const RemoveClipOperationSchema = withOperationId({
  type: z.literal("timeline.removeClip"),
  clipId: StableIdSchema,
});

export const AssetCreateSpecSchema = z
  .object({
    id: StableIdSchema,
    kind: AssetKindSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(2_000).optional(),
    derivedFrom: z.array(StableIdSchema).max(64).optional(),
    tags: z.array(z.string().min(1).max(80)).max(24).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();
export type AssetCreateSpec = z.infer<typeof AssetCreateSpecSchema>;

export const CreateAssetOperationSchema = withOperationId({
  type: z.literal("asset.create"),
  asset: AssetCreateSpecSchema,
});

/** Versions enter the graph only after immutable, content-addressed media exists. */
export const CommittedAssetVersionSchema = AssetVersionSchema.superRefine((version, context) => {
  if (!["ready", "approved", "rejected", "stale"].includes(version.status)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "Only finalized asset versions can be committed",
    });
  }
  for (const field of ["objectKey", "sha256", "byteLength", "provenance"] as const) {
    if (version[field] === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `Committed asset versions require ${field}`,
      });
    }
  }
});

export const AddAssetVersionOperationSchema = withOperationId({
  type: z.literal("asset.addVersion"),
  assetId: StableIdSchema,
  version: CommittedAssetVersionSchema,
});

export const SelectAssetVersionOperationSchema = withOperationId({
  type: z.literal("asset.selectVersion"),
  assetId: StableIdSchema,
  versionId: StableIdSchema,
});

export const SetDelegationOperationSchema = withOperationId({
  type: z.literal("delegation.set"),
  stage: StageNameSchema,
  mode: DelegationModeSchema,
  maxSpendUsd: z.number().nonnegative().nullable().optional(),
  checkpointAfterStage: z.boolean().optional(),
});

export const AcceptProposalOperationSchema = withOperationId({
  type: z.literal("proposal.accept"),
  decisionId: StableIdSchema,
  resolutionReason: z.string().max(1_000).optional(),
});

export const RejectProposalOperationSchema = withOperationId({
  type: z.literal("proposal.reject"),
  decisionId: StableIdSchema,
  resolutionReason: z.string().min(1).max(1_000),
});

/** Internal but serializable operation used to make proposal resolution invertible. */
export const SetDecisionStateOperationSchema = withOperationId({
  type: z.literal("decision.setState"),
  decisionId: StableIdSchema,
  state: z
    .object({
      status: DecisionStatusSchema,
      resolvedBy: ActorKindSchema.nullable(),
      resolvedAt: IsoDateTimeSchema.nullable(),
      resolutionReason: z.string().max(1_000).nullable(),
    })
    .strict(),
});

export const AddCheckpointOperationSchema = withOperationId({
  type: z.literal("checkpoint.add"),
  checkpoint: CheckpointRefSchema,
});

export const RemoveCheckpointOperationSchema = withOperationId({
  type: z.literal("checkpoint.remove"),
  checkpointId: StableIdSchema,
});

/** Snapshot replacement is deliberately explicit and remains revisioned like every other edit. */
export const RestoreProjectOperationSchema = withOperationId({
  type: z.literal("project.restore"),
  snapshot: ProductionProjectSchema,
  checkpointId: StableIdSchema.optional(),
});

export const ProjectOperationSchema = z.discriminatedUnion("type", [
  UpdateBeatOperationSchema,
  UpdateSceneOperationSchema,
  SetSceneLockedOperationSchema,
  SetSceneStatusOperationSchema,
  MoveClipOperationSchema,
  InsertClipOperationSchema,
  UpdateClipOperationSchema,
  RemoveClipOperationSchema,
  CreateAssetOperationSchema,
  AddAssetVersionOperationSchema,
  SelectAssetVersionOperationSchema,
  SetDelegationOperationSchema,
  AcceptProposalOperationSchema,
  RejectProposalOperationSchema,
  SetDecisionStateOperationSchema,
  AddCheckpointOperationSchema,
  RemoveCheckpointOperationSchema,
  RestoreProjectOperationSchema,
]);
export type ProjectOperation = z.infer<typeof ProjectOperationSchema>;

export const ProjectActorSchema = z
  .object({
    kind: ActorKindSchema,
    sessionId: StableIdSchema,
  })
  .strict();
export type ProjectActor = z.infer<typeof ProjectActorSchema>;

export const ProjectCommandSchema = z
  .object({
    commandId: StableIdSchema,
    idempotencyKey: z.string().min(8).max(128),
    projectId: StableIdSchema,
    baseRevision: z.number().int().nonnegative(),
    actor: ProjectActorSchema,
    reason: z.string().max(500).optional(),
    createdAt: IsoDateTimeSchema.optional(),
    dryRun: z.boolean().default(false),
    operations: z.array(ProjectOperationSchema).min(1).max(50),
  })
  .strict();
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type ProjectCommandInput = z.input<typeof ProjectCommandSchema>;

export interface CreateProjectCommandOptions {
  commandId?: string;
  idempotencyKey?: string;
  actor?: ProjectActor;
  reason?: string;
  createdAt?: string;
  dryRun?: boolean;
}

let commandCounter = 0;

/** Convenience constructor; boundaries should still parse untrusted inputs with ProjectCommandSchema. */
export const createProjectCommand = (
  projectId: string,
  baseRevision: number,
  operations: ProjectOperation[],
  options: CreateProjectCommandOptions = {},
): ProjectCommand => {
  commandCounter += 1;
  const generatedId = `command_${Date.now().toString(36)}_${commandCounter.toString(36)}`;
  return ProjectCommandSchema.parse({
    commandId: options.commandId ?? generatedId,
    idempotencyKey: options.idempotencyKey ?? `${generatedId}:once`,
    projectId,
    baseRevision,
    actor: options.actor ?? { kind: "director", sessionId: "session_director" },
    reason: options.reason,
    createdAt: options.createdAt,
    dryRun: options.dryRun ?? false,
    operations,
  });
};

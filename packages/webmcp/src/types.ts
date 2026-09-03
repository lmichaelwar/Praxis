import type {
  AgentRun,
  AgentRunMode,
  AgentRunRole,
  AgentRunStage,
} from "@praxis/agent-runs";

export type MaybePromise<T> = T | Promise<T>;

export const PRAXIS_STAGES = [
  "treatment",
  "script",
  "previz",
  "assets",
  "edit",
  "finish",
] as const;

export type PraxisStage = (typeof PRAXIS_STAGES)[number];

export const DELEGATION_MODES = ["observe", "propose", "act", "locked"] as const;

export type DelegationMode = (typeof DELEGATION_MODES)[number];

export const PRAXIS_WEBMCP_TOOL_NAMES = [
  "get_project_context",
  "get_current_selection",
  "get_change_history",
  "apply_project_operations",
  "set_delegation",
  "create_checkpoint",
  "restore_checkpoint",
  "run_qc",
  "delegate_production_run",
  "generate_scene_asset",
  "generate_narration",
  "start_render",
  "get_job_status",
  "cancel_job",
] as const;

export type PraxisWebMcpToolName = (typeof PRAXIS_WEBMCP_TOOL_NAMES)[number];

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface WebMcpToolAnnotations {
  readOnlyHint: boolean;
  untrustedContentHint: boolean;
}

export interface WebMcpToolExecutionOptions {
  signal?: AbortSignal;
}

export interface WebMcpToolDefinition {
  readonly name: PraxisWebMcpToolName;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: WebMcpToolAnnotations;
  readonly execute: (
    input: unknown,
    options?: WebMcpToolExecutionOptions,
  ) => MaybePromise<unknown>;
}

export interface WebMcpRegisterToolOptions {
  signal?: AbortSignal;
}

export type WebMcpToolTeardown =
  | (() => MaybePromise<void>)
  | { unregister: () => MaybePromise<void> };

/**
 * The current browser API resolves registration with `undefined`. The teardown
 * forms are accepted for small test hosts and earlier WebMCP implementations.
 */
export interface WebMcpModelContext {
  registerTool(
    tool: WebMcpToolDefinition,
    options?: WebMcpRegisterToolOptions,
  ): MaybePromise<void | WebMcpToolTeardown>;
  /** Optional compatibility hook used only when a legacy host exposes it. */
  unregisterTool?(
    tool: WebMcpToolDefinition | PraxisWebMcpToolName,
  ): MaybePromise<void>;
}

export interface WebMcpDocumentLike {
  readonly modelContext?: WebMcpModelContext | null;
}

export interface WebMcpHostExecutionContext {
  readonly toolName: PraxisWebMcpToolName;
  readonly signal?: AbortSignal;
}

export type EntityStatus = "draft" | "approved" | "stale" | "failed" | "rejected";

export interface ScriptBeatPatch {
  readonly title?: string;
  readonly narration?: string;
  readonly visualIntent?: string;
  readonly deliveryCue?: string | null;
  readonly enhancementCues?: readonly string[];
  readonly sourceRefs?: readonly string[];
  readonly startFrame?: number;
  readonly durationFrames?: number;
  readonly status?: EntityStatus;
}

export interface ClipTransformInput {
  readonly x?: number;
  readonly y?: number;
  readonly scale?: number;
  readonly rotation?: number;
}

/** Host-friendly clip input; the host owns entity metadata and provenance. */
export interface TimelineClipInput {
  readonly clipId: string;
  readonly kind:
    | "scene"
    | "image"
    | "audio"
    | "music"
    | "text"
    | "caption"
    | "video"
    | "placeholder";
  readonly name: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sceneId?: string;
  readonly assetId?: string;
  readonly assetVersionId?: string;
  readonly sourceStartFrame?: number;
  readonly sourceDurationFrames?: number;
  readonly versionPolicy?: "pinned" | "follow-latest";
  readonly opacity?: number;
  readonly transform?: ClipTransformInput;
  readonly transitionIn?: string;
  readonly transitionOut?: string;
}

export interface TimelineClipPatch {
  readonly startFrame?: number;
  readonly durationFrames?: number;
  readonly kind?: TimelineClipInput["kind"];
  readonly name?: string;
  readonly sourceStartFrame?: number;
  readonly sourceDurationFrames?: number | null;
  readonly sceneId?: string | null;
  readonly assetId?: string | null;
  readonly assetVersionId?: string | null;
  readonly versionPolicy?: "pinned" | "follow-latest";
  readonly opacity?: number;
  readonly transform?: ClipTransformInput;
  readonly transitionIn?: string | null;
  readonly transitionOut?: string | null;
  readonly status?: EntityStatus;
}

export type ProjectOperationInput = {
  readonly operationId?: string;
} & (
  | {
      readonly type: "script.updateBeat";
      readonly beatId: string;
      readonly patch: ScriptBeatPatch;
    }
  | {
      readonly type: "scene.setLocked";
      readonly sceneId: string;
      readonly locked: boolean;
    }
  | {
      readonly type: "scene.setStatus";
      readonly sceneId: string;
      readonly status: EntityStatus;
    }
  | {
      readonly type: "timeline.moveClip";
      readonly clipId: string;
      readonly startFrame: number;
      readonly targetTrackId?: string;
    }
  | {
      readonly type: "timeline.insertClip";
      readonly trackId: string;
      readonly clip: TimelineClipInput;
    }
  | {
      readonly type: "timeline.updateClip";
      readonly clipId: string;
      readonly patch: TimelineClipPatch;
    }
  | {
      readonly type: "timeline.removeClip";
      readonly clipId: string;
    }
  | {
      readonly type: "proposal.accept";
      readonly decisionId: string;
      readonly resolutionReason?: string;
    }
  | {
      readonly type: "proposal.reject";
      readonly decisionId: string;
      readonly resolutionReason: string;
    }
);

export interface MutationEnvelopeInput {
  readonly baseRevision: number;
  readonly idempotencyKey: string;
  readonly reason?: string;
}

export interface ChangeHistoryInput {
  readonly limit?: number;
  readonly sinceRevision?: number;
  readonly actor?: "director" | "codex" | "system";
}

export interface ApplyProjectOperationsInput extends MutationEnvelopeInput {
  readonly dryRun?: boolean;
  readonly operations: readonly ProjectOperationInput[];
}

export interface DelegationPolicyInput {
  readonly stage: PraxisStage;
  readonly mode: DelegationMode;
  readonly entityIds?: readonly string[];
  readonly maxSpendUsd?: number;
  readonly checkpointAfterStage?: boolean;
}

export interface SetDelegationInput extends MutationEnvelopeInput {
  readonly policies: readonly DelegationPolicyInput[];
}

export interface CreateCheckpointInput extends MutationEnvelopeInput {
  readonly label?: string;
}

export interface RestoreCheckpointInput extends MutationEnvelopeInput {
  readonly checkpointId: string;
  readonly dryRun?: boolean;
}

export const QC_CHECKS = [
  "timing",
  "missing_media",
  "narration_overrun",
  "black_frames",
  "audio_clipping",
  "delivery",
] as const;

export type QcCheck = (typeof QC_CHECKS)[number];

export interface RunQcInput extends MutationEnvelopeInput {
  readonly scope?: "project" | "selection" | "timeline";
  readonly checks?: readonly QcCheck[];
}

export interface DelegateProductionRunInput extends MutationEnvelopeInput {
  readonly role: AgentRunRole;
  readonly stages: readonly AgentRunStage[];
  readonly mode: AgentRunMode;
  readonly maxSpendUsd: number;
  readonly preserveLockedEntities: true;
}

export interface GenerateSceneAssetInput extends MutationEnvelopeInput {
  readonly sceneId: string;
  readonly prompt?: string;
}

export interface GenerateNarrationInput extends MutationEnvelopeInput {
  readonly beatIds?: readonly string[];
}

export interface StartRenderInput extends MutationEnvelopeInput {
  readonly kind: "preview" | "final";
}

export interface GetJobStatusInput {
  readonly jobId: string;
}

export interface CancelJobInput {
  readonly jobId: string;
}

export interface ProjectStageSummary {
  readonly stage: PraxisStage;
  readonly status:
    | "pending"
    | "active"
    | "ready"
    | "approved"
    | "stale"
    | "failed"
    | "blocked";
  readonly delegation: DelegationMode;
}

export interface ProjectBudgetSummary {
  readonly spentUsd: number;
  readonly maxSpendUsd?: number;
}

export interface ProjectJobSummary {
  readonly jobId: string;
  readonly kind: string;
  readonly status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  readonly progress?: number;
}

/** Deliberately compact; the adapter never accepts a full project snapshot. */
export interface ProjectContextSummary {
  readonly projectId: string;
  readonly revision: number;
  readonly title?: string;
  readonly briefSummary?: string;
  readonly activeStage?: PraxisStage;
  readonly durationFrames?: number;
  readonly fps?: number;
  readonly stages?: readonly ProjectStageSummary[];
  readonly budget?: ProjectBudgetSummary;
  readonly lockedEntityIds?: readonly string[];
  readonly outstandingJobs?: readonly ProjectJobSummary[];
}

export interface CurrentSelectionSummary {
  readonly revision: number;
  readonly activeView?: "treatment" | "script" | "storyboard" | "assets" | "timeline" | "finish";
  readonly playheadFrame?: number;
  readonly beatId?: string;
  readonly sceneId?: string;
  readonly assetId?: string;
  readonly clipId?: string;
}

export interface ChangeHistoryEntrySummary {
  readonly revision: number;
  readonly operationId: string;
  readonly actor: "director" | "codex" | "system";
  readonly action: string;
  readonly summary?: string;
  readonly affectedEntityIds?: readonly string[];
  readonly createdAt?: string;
}

export interface ChangeHistorySummary {
  readonly currentRevision: number;
  readonly entries: readonly ChangeHistoryEntrySummary[];
  readonly hasMore?: boolean;
}

export interface ProjectMutationSummary {
  readonly revision: number;
  readonly appliedOperationIds?: readonly string[];
  readonly affectedEntityIds?: readonly string[];
  readonly invalidatedEntityIds?: readonly string[];
  readonly checkpointId?: string;
  readonly dryRun?: boolean;
}

export interface DelegationMutationSummary extends ProjectMutationSummary {
  readonly updatedStages?: readonly PraxisStage[];
}

export interface CheckpointSummary {
  readonly revision: number;
  readonly checkpointId: string;
  readonly label?: string;
}

export interface RestoreCheckpointSummary extends ProjectMutationSummary {
  readonly restoredCheckpointId: string;
}

export interface QcFindingSummary {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly summary: string;
  readonly entityId?: string;
}

export interface QcRunSummary {
  readonly revision: number;
  readonly jobId?: string;
  readonly status: "queued" | "running" | "completed" | "failed" | "cancelled";
  readonly findings?: readonly QcFindingSummary[];
}

export interface DelegatedProductionRunSummary {
  readonly revision: number;
  readonly agentRun: AgentRun;
}

export interface DurableMediaJobSummary {
  readonly jobId: string;
  readonly jobType: "image.generate" | "speech.generate" | "render.preview" | "render.final";
  readonly status: "queued" | "running" | "waiting_external" | "succeeded" | "failed" | "cancel_requested" | "cancelled";
  readonly baseRevision: number;
  readonly reservedCostUsd: number;
  readonly settledCostUsd: number;
  readonly assetVersionId?: string;
  readonly renderId?: string;
  readonly attached?: boolean;
  readonly stale?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface PraxisWebMcpHost {
  getProjectContext(
    context: WebMcpHostExecutionContext,
  ): MaybePromise<ProjectContextSummary>;
  getCurrentSelection(
    context: WebMcpHostExecutionContext,
  ): MaybePromise<CurrentSelectionSummary>;
  getChangeHistory(
    input: ChangeHistoryInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<ChangeHistorySummary>;
  applyProjectOperations(
    input: ApplyProjectOperationsInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<ProjectMutationSummary>;
  setDelegation(
    input: SetDelegationInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<DelegationMutationSummary>;
  createCheckpoint(
    input: CreateCheckpointInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<CheckpointSummary>;
  restoreCheckpoint(
    input: RestoreCheckpointInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<RestoreCheckpointSummary>;
  runQc(
    input: RunQcInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<QcRunSummary>;
  delegateProductionRun(
    input: DelegateProductionRunInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<DelegatedProductionRunSummary>;
  generateSceneAsset(
    input: GenerateSceneAssetInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<DurableMediaJobSummary>;
  generateNarration(
    input: GenerateNarrationInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<DurableMediaJobSummary>;
  startRender(
    input: StartRenderInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<DurableMediaJobSummary>;
  getJobStatus(
    input: GetJobStatusInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<DurableMediaJobSummary>;
  cancelJob(
    input: CancelJobInput,
    context: WebMcpHostExecutionContext,
  ): MaybePromise<DurableMediaJobSummary>;
}

export interface PraxisWebMcpErrorInit {
  readonly code: string;
  readonly summary: string;
  readonly currentRevision?: number;
  readonly changedEntityIds?: readonly string[];
  readonly retryable?: boolean;
}

export interface PraxisWebMcpErrorSummary {
  readonly code: string;
  readonly summary: string;
  readonly currentRevision?: number;
  readonly changedEntityIds?: readonly string[];
  readonly retryable?: boolean;
}

export type PraxisWebMcpToolResponse<T> =
  | { readonly ok: true; readonly result: T }
  | { readonly ok: false; readonly error: PraxisWebMcpErrorSummary };

/** A host can throw this to return a bounded, agent-actionable failure. */
export class PraxisWebMcpHostError extends Error {
  readonly code: string;
  readonly currentRevision?: number;
  readonly changedEntityIds?: readonly string[];
  readonly retryable?: boolean;

  constructor(init: PraxisWebMcpErrorInit) {
    super(init.summary);
    this.name = "PraxisWebMcpHostError";
    this.code = init.code;
    this.currentRevision = init.currentRevision;
    this.changedEntityIds = init.changedEntityIds;
    this.retryable = init.retryable;
  }
}

export interface RegisterPraxisWebMcpOptions {
  /** Pass `null` to explicitly disable registration for this call. */
  readonly modelContext?: WebMcpModelContext | null;
  /** Aborting this signal disposes the entire project-scoped registration. */
  readonly signal?: AbortSignal;
  /** Register only this bounded subset; catalog order is preserved. */
  readonly toolNames?: readonly PraxisWebMcpToolName[];
}

export interface PraxisWebMcpRegistration {
  readonly supported: boolean;
  readonly registeredToolNames: readonly PraxisWebMcpToolName[];
  readonly signal: AbortSignal;
  readonly unavailableReason?: "model_context_unavailable";
  dispose(reason?: unknown): void;
}

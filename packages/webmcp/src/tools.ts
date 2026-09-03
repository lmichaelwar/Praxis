import { PRAXIS_WEBMCP_INPUT_SCHEMAS } from "./schemas";
import type { AgentRun } from "@praxis/agent-runs";
import type {
  ApplyProjectOperationsInput,
  CancelJobInput,
  ChangeHistoryEntrySummary,
  ChangeHistoryInput,
  ChangeHistorySummary,
  CheckpointSummary,
  CreateCheckpointInput,
  CurrentSelectionSummary,
  DelegateProductionRunInput,
  DelegatedProductionRunSummary,
  DelegationMutationSummary,
  DurableMediaJobSummary,
  GenerateNarrationInput,
  GenerateSceneAssetInput,
  GetJobStatusInput,
  PraxisStage,
  PraxisWebMcpErrorSummary,
  PraxisWebMcpHost,
  PraxisWebMcpToolName,
  PraxisWebMcpToolResponse,
  ProjectContextSummary,
  ProjectJobSummary,
  ProjectMutationSummary,
  ProjectStageSummary,
  QcFindingSummary,
  QcRunSummary,
  RestoreCheckpointInput,
  RestoreCheckpointSummary,
  RunQcInput,
  SetDelegationInput,
  StartRenderInput,
  WebMcpHostExecutionContext,
  WebMcpToolDefinition,
  WebMcpToolExecutionOptions,
} from "./types";
import { PraxisWebMcpHostError } from "./types";

const MAX_IDS = 100;
const MAX_HISTORY_ENTRIES = 50;
const MAX_JOBS = 25;
const MAX_FINDINGS = 50;

function requiredText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Host summary field ${field} must be a non-empty string.`);
  }

  return value.slice(0, maxLength);
}

function optionalText(value: string | undefined, maxLength: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function requiredInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Host summary field ${field} must be a non-negative safe integer.`);
  }

  return value;
}

function optionalFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function boundedIds(ids: readonly string[] | undefined, limit = MAX_IDS): string[] | undefined {
  if (!ids) {
    return undefined;
  }

  return ids.slice(0, limit).map((id) => requiredText(id, "entity id", 128));
}

function summarizeStage(stage: ProjectStageSummary): ProjectStageSummary {
  return {
    stage: stage.stage,
    status: stage.status,
    delegation: stage.delegation,
  };
}

function summarizeJob(job: ProjectJobSummary): ProjectJobSummary {
  return compact({
    jobId: requiredText(job.jobId, "jobId", 128),
    kind: requiredText(job.kind, "job kind", 64),
    status: job.status,
    progress: optionalFiniteNumber(job.progress),
  });
}

function summarizeProjectContext(value: ProjectContextSummary): ProjectContextSummary {
  return compact({
    projectId: requiredText(value.projectId, "projectId", 128),
    revision: requiredInteger(value.revision, "revision"),
    title: optionalText(value.title, 200),
    briefSummary: optionalText(value.briefSummary, 2_000),
    activeStage: value.activeStage,
    durationFrames:
      value.durationFrames === undefined
        ? undefined
        : requiredInteger(value.durationFrames, "durationFrames"),
    fps: optionalFiniteNumber(value.fps),
    stages: value.stages?.slice(0, 6).map(summarizeStage),
    budget: value.budget
      ? compact({
          spentUsd: optionalFiniteNumber(value.budget.spentUsd) ?? 0,
          maxSpendUsd: optionalFiniteNumber(value.budget.maxSpendUsd),
        })
      : undefined,
    lockedEntityIds: boundedIds(value.lockedEntityIds),
    outstandingJobs: value.outstandingJobs?.slice(0, MAX_JOBS).map(summarizeJob),
  });
}

function summarizeSelection(value: CurrentSelectionSummary): CurrentSelectionSummary {
  return compact({
    revision: requiredInteger(value.revision, "revision"),
    activeView: value.activeView,
    playheadFrame:
      value.playheadFrame === undefined
        ? undefined
        : requiredInteger(value.playheadFrame, "playheadFrame"),
    beatId: optionalText(value.beatId, 128),
    sceneId: optionalText(value.sceneId, 128),
    assetId: optionalText(value.assetId, 128),
    clipId: optionalText(value.clipId, 128),
  });
}

function summarizeHistoryEntry(value: ChangeHistoryEntrySummary): ChangeHistoryEntrySummary {
  return compact({
    revision: requiredInteger(value.revision, "history revision"),
    operationId: requiredText(value.operationId, "operationId", 128),
    actor: value.actor,
    action: requiredText(value.action, "history action", 128),
    summary: optionalText(value.summary, 500),
    affectedEntityIds: boundedIds(value.affectedEntityIds, 50),
    createdAt: optionalText(value.createdAt, 64),
  });
}

function summarizeHistory(value: ChangeHistorySummary): ChangeHistorySummary {
  return compact({
    currentRevision: requiredInteger(value.currentRevision, "currentRevision"),
    entries: value.entries.slice(0, MAX_HISTORY_ENTRIES).map(summarizeHistoryEntry),
    hasMore: value.hasMore,
  });
}

function summarizeMutation(value: ProjectMutationSummary): ProjectMutationSummary {
  return compact({
    revision: requiredInteger(value.revision, "revision"),
    appliedOperationIds: boundedIds(value.appliedOperationIds),
    affectedEntityIds: boundedIds(value.affectedEntityIds),
    invalidatedEntityIds: boundedIds(value.invalidatedEntityIds),
    checkpointId: optionalText(value.checkpointId, 128),
    dryRun: value.dryRun,
  });
}

function summarizeDelegation(value: DelegationMutationSummary): DelegationMutationSummary {
  return compact({
    ...summarizeMutation(value),
    updatedStages: value.updatedStages?.slice(0, 6) as PraxisStage[] | undefined,
  });
}

function summarizeCheckpoint(value: CheckpointSummary): CheckpointSummary {
  return compact({
    revision: requiredInteger(value.revision, "revision"),
    checkpointId: requiredText(value.checkpointId, "checkpointId", 128),
    label: optionalText(value.label, 120),
  });
}

function summarizeRestore(value: RestoreCheckpointSummary): RestoreCheckpointSummary {
  return {
    ...summarizeMutation(value),
    restoredCheckpointId: requiredText(
      value.restoredCheckpointId,
      "restoredCheckpointId",
      128,
    ),
  };
}

function summarizeFinding(value: QcFindingSummary): QcFindingSummary {
  return compact({
    severity: value.severity,
    code: requiredText(value.code, "QC code", 64),
    summary: requiredText(value.summary, "QC summary", 500),
    entityId: optionalText(value.entityId, 128),
  });
}

function summarizeQc(value: QcRunSummary): QcRunSummary {
  return compact({
    revision: requiredInteger(value.revision, "revision"),
    jobId: optionalText(value.jobId, 128),
    status: value.status,
    findings: value.findings?.slice(0, MAX_FINDINGS).map(summarizeFinding),
  });
}

function summarizeAgentRun(value: AgentRun): AgentRun {
  const maxSpendUsd = optionalFiniteNumber(value.maxSpendUsd);
  if (maxSpendUsd === undefined || maxSpendUsd < 0) {
    throw new TypeError("Host summary field maxSpendUsd must be a non-negative finite number.");
  }
  return compact({
    id: requiredText(value.id, "AgentRun id", 128),
    projectId: requiredText(value.projectId, "AgentRun projectId", 128),
    checkpointId: requiredText(value.checkpointId, "AgentRun checkpointId", 128),
    baseRevision: requiredInteger(value.baseRevision, "AgentRun baseRevision"),
    role: value.role,
    stages: value.stages?.slice(0, 6),
    mode: value.mode,
    status: value.status,
    scopes: value.scopes.slice(0, 16),
    deniedEntityIds: boundedIds(value.deniedEntityIds, 256) ?? [],
    maxSpendUsd,
    claimExpiresAt: requiredText(value.claimExpiresAt, "AgentRun claimExpiresAt", 64),
    leaseExpiresAt: optionalText(value.leaseExpiresAt, 64),
    codexTaskId: optionalText(value.codexTaskId, 256),
    codexTaskUrl: optionalText(value.codexTaskUrl, 2_048),
    lastHeartbeatAt: optionalText(value.lastHeartbeatAt, 64),
    completionSummary: optionalText(value.completionSummary, 4_000),
    errorCode: optionalText(value.errorCode, 160),
    errorMessage: optionalText(value.errorMessage, 2_000),
    createdAt: requiredText(value.createdAt, "AgentRun createdAt", 64),
    updatedAt: requiredText(value.updatedAt, "AgentRun updatedAt", 64),
  }) as AgentRun;
}

function summarizeDelegatedRun(
  value: DelegatedProductionRunSummary,
): DelegatedProductionRunSummary {
  const agentRun = summarizeAgentRun(value.agentRun);
  return {
    // The checkpoint created as part of delegation is the authoritative run base.
    revision: agentRun.baseRevision,
    agentRun,
  };
}

function summarizeDurableJob(value: DurableMediaJobSummary): DurableMediaJobSummary {
  return compact({
    jobId: requiredText(value.jobId, "jobId", 128),
    jobType: value.jobType,
    status: value.status,
    baseRevision: requiredInteger(value.baseRevision, "baseRevision"),
    reservedCostUsd: optionalFiniteNumber(value.reservedCostUsd) ?? 0,
    settledCostUsd: optionalFiniteNumber(value.settledCostUsd) ?? 0,
    assetVersionId: optionalText(value.assetVersionId, 128),
    renderId: optionalText(value.renderId, 128),
    attached: value.attached,
    stale: value.stale,
    errorCode: optionalText(value.errorCode, 128),
    errorMessage: optionalText(value.errorMessage, 500),
  });
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }

  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function isAbortFailure(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function safeError(error: unknown): PraxisWebMcpErrorSummary {
  if (!(error instanceof PraxisWebMcpHostError)) {
    return {
      code: "HOST_ERROR",
      summary: "The project host could not complete this tool call.",
      retryable: false,
    };
  }

  const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "HOST_ERROR";
  return compact({
    code,
    summary: optionalText(error.message, 500) ?? "The project host rejected this tool call.",
    currentRevision:
      error.currentRevision === undefined
        ? undefined
        : requiredInteger(error.currentRevision, "currentRevision"),
    changedEntityIds: boundedIds(error.changedEntityIds, 50),
    retryable: error.retryable,
  });
}

async function executeHost<T, U>(
  toolName: PraxisWebMcpToolName,
  lifecycleSignal: AbortSignal | undefined,
  executionOptions: WebMcpToolExecutionOptions | undefined,
  invoke: (context: WebMcpHostExecutionContext) => Promise<T> | T,
  summarize: (value: T) => U,
): Promise<PraxisWebMcpToolResponse<U>> {
  throwIfAborted(lifecycleSignal);
  throwIfAborted(executionOptions?.signal);

  const context = compact({
    toolName,
    signal: executionOptions?.signal,
  }) as WebMcpHostExecutionContext;

  try {
    const result = await invoke(context);
    throwIfAborted(executionOptions?.signal);
    return { ok: true, result: summarize(result) };
  } catch (error) {
    if (isAbortFailure(error, executionOptions?.signal)) {
      throw error;
    }

    return { ok: false, error: safeError(error) };
  }
}

function asInput<T>(input: unknown): T {
  return (input ?? {}) as T;
}

export function createPraxisWebMcpTools(
  host: PraxisWebMcpHost,
  lifecycleSignal?: AbortSignal,
): readonly WebMcpToolDefinition[] {
  return [
    {
      name: "get_project_context",
      title: "Get project context",
      description:
        "Read a bounded summary of the open video project: revision, stage state, duration, budget, locks, and active jobs. Does not mutate project state.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.get_project_context,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (_input, options) =>
        executeHost(
          "get_project_context",
          lifecycleSignal,
          options,
          (context) => host.getProjectContext(context),
          summarizeProjectContext,
        ),
    },
    {
      name: "get_current_selection",
      title: "Get current selection",
      description:
        "Read the director's active view, playhead, and selected beat, scene, asset, or clip. Does not mutate project state.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.get_current_selection,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (_input, options) =>
        executeHost(
          "get_current_selection",
          lifecycleSignal,
          options,
          (context) => host.getCurrentSelection(context),
          summarizeSelection,
        ),
    },
    {
      name: "get_change_history",
      title: "Get change history",
      description:
        "Read a bounded list of recent director, Codex, and system operations. Does not mutate project state.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.get_change_history,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, options) => {
        const parsed = asInput<ChangeHistoryInput>(input);
        return executeHost(
          "get_change_history",
          lifecycleSignal,
          options,
          (context) => host.getChangeHistory(parsed, context),
          summarizeHistory,
        );
      },
    },
    {
      name: "apply_project_operations",
      title: "Apply project operations",
      description:
        "Atomically apply a bounded batch of semantic edits to the open project. Side effect: may commit a new revision. Requires the revision returned by get_project_context; locked entities remain protected by the host.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.apply_project_operations,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<ApplyProjectOperationsInput>(input);
        return executeHost(
          "apply_project_operations",
          lifecycleSignal,
          options,
          (context) => host.applyProjectOperations(parsed, context),
          summarizeMutation,
        );
      },
    },
    {
      name: "set_delegation",
      title: "Set delegation",
      description:
        "Set Codex authority for bounded production stages or entities. Side effect: commits delegation and budget policy changes at baseRevision.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.set_delegation,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<SetDelegationInput>(input);
        return executeHost(
          "set_delegation",
          lifecycleSignal,
          options,
          (context) => host.setDelegation(parsed, context),
          summarizeDelegation,
        );
      },
    },
    {
      name: "create_checkpoint",
      title: "Create checkpoint",
      description:
        "Create a reversible checkpoint of the open project. Side effect: records a checkpoint at baseRevision.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.create_checkpoint,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<CreateCheckpointInput>(input);
        return executeHost(
          "create_checkpoint",
          lifecycleSignal,
          options,
          (context) => host.createCheckpoint(parsed, context),
          summarizeCheckpoint,
        );
      },
    },
    {
      name: "restore_checkpoint",
      title: "Restore checkpoint",
      description:
        "Restore a named durable project checkpoint. Side effect: replaces current project state with a new revision; hosts may reject dryRun when the gateway cannot preview snapshots.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.restore_checkpoint,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<RestoreCheckpointInput>(input);
        return executeHost(
          "restore_checkpoint",
          lifecycleSignal,
          options,
          (context) => host.restoreCheckpoint(parsed, context),
          summarizeRestore,
        );
      },
    },
    {
      name: "run_qc",
      title: "Run quality checks",
      description:
        "Run bounded deterministic checks over the gateway-hydrated snapshot at baseRevision. The current host does not persist this QC result.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.run_qc,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, options) => {
        const parsed = asInput<RunQcInput>(input);
        return executeHost(
          "run_qc",
          lifecycleSignal,
          options,
          (context) => host.runQc(parsed, context),
          summarizeQc,
        );
      },
    },
    {
      name: "delegate_production_run",
      title: "Delegate production run",
      description:
        "Create a checkpointed, budget-limited AgentRun for asynchronous production. Side effect: saves delegation policy and creates a durable run at baseRevision for dispatcher claim.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.delegate_production_run,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<DelegateProductionRunInput>(input);
        return executeHost(
          "delegate_production_run",
          lifecycleSignal,
          options,
          (context) => host.delegateProductionRun(parsed, context),
          summarizeDelegatedRun,
        );
      },
    },
    {
      name: "generate_scene_asset",
      title: "Generate scene asset",
      description:
        "Queue a bounded image-generation job for one scene. Side effect: reserves provider budget and may attach an immutable asset version at baseRevision.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.generate_scene_asset,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<GenerateSceneAssetInput>(input);
        return executeHost(
          "generate_scene_asset",
          lifecycleSignal,
          options,
          (context) => host.generateSceneAsset(parsed, context),
          summarizeDurableJob,
        );
      },
    },
    {
      name: "generate_narration",
      title: "Generate narration",
      description:
        "Queue a bounded speech-generation job for selected script beats. Side effect: reserves provider budget and may attach an immutable audio version at baseRevision.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.generate_narration,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<GenerateNarrationInput>(input);
        return executeHost(
          "generate_narration",
          lifecycleSignal,
          options,
          (context) => host.generateNarration(parsed, context),
          summarizeDurableJob,
        );
      },
    },
    {
      name: "start_render",
      title: "Start render",
      description:
        "Queue a preview or final render against an immutable project revision. Side effect: reserves render budget and creates a durable render job at baseRevision.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.start_render,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<StartRenderInput>(input);
        return executeHost(
          "start_render",
          lifecycleSignal,
          options,
          (context) => host.startRender(parsed, context),
          summarizeDurableJob,
        );
      },
    },
    {
      name: "get_job_status",
      title: "Get media job status",
      description:
        "Read a bounded status summary for one durable media or render job. Does not expose provider requests, credentials, or object-store keys.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.get_job_status,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (input, options) => {
        const parsed = asInput<GetJobStatusInput>(input);
        return executeHost(
          "get_job_status",
          lifecycleSignal,
          options,
          (context) => host.getJobStatus(parsed, context),
          summarizeDurableJob,
        );
      },
    },
    {
      name: "cancel_job",
      title: "Cancel media job",
      description:
        "Request cancellation of one durable media or render job. Side effect: advances the server-managed job state when cancellation is still possible.",
      inputSchema: PRAXIS_WEBMCP_INPUT_SCHEMAS.cancel_job,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: (input, options) => {
        const parsed = asInput<CancelJobInput>(input);
        return executeHost(
          "cancel_job",
          lifecycleSignal,
          options,
          (context) => host.cancelJob(parsed, context),
          summarizeDurableJob,
        );
      },
    },
  ];
}

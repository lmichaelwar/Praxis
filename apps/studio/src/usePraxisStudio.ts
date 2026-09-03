import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRun,
  AgentRunMode,
  AgentRunRole,
  AgentRunStage,
  CreateAgentRunRequest,
} from "@praxis/agent-runs";
import {
  createProjectCommand,
  type ProjectCommandError,
  type ProjectOperation,
} from "@praxis/commands";
import type { JobCreateRequest, JobRecord } from "@praxis/jobs";
import {
  AssetVersionSchema,
  createSeedProject,
  ProductionProjectSchema,
  type ActorKind,
  type AssetVersion,
  type ProductionProject,
} from "@praxis/project-schema";
import {
  PraxisApiError,
  PraxisConflictError,
  PraxisRemoteClient,
  type AssetSummary,
  type CheckpointSummary,
  type CommandCommitResponse,
  type HistorySummary,
  type ProjectBudgetSummary,
  type ProjectEventSubscription,
  type ProjectHydrationResponse,
  type RenderSummary,
  type SubscribeProjectEventsOptions,
} from "@praxis/remote-client";
import type { ToastView } from "./components/ToastStack";
import { lockedEntityIds } from "./locked-entities";
import { projectScenes, projectStages, projectTracks } from "./view-model";
import {
  STAGE_ORDER,
  type AssetVersionView,
  type BackendConnectionView,
  type CloudRunView,
  type DelegationDraft,
  type JobQueueView,
  type LedgerView,
  type SelectionView,
  type StudioActor,
  type StudioStageName,
} from "./ui-types";

const PROJECT_LOCATOR_KEY = "praxis:studio:project-id:v1";
const DEFAULT_PREVIEW_URL = "/media/fax-oracle-corridor.png";
const STABLE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{2,127}$/;

export type StudioGateway = Pick<
  PraxisRemoteClient,
  | "getProject"
  | "createProject"
  | "applyCommand"
  | "undoProject"
  | "redoProject"
  | "createCheckpoint"
  | "restoreCheckpoint"
  | "createJob"
  | "getJob"
  | "cancelJob"
  | "createAgentRun"
  | "cancelAgentRun"
  | "assetAccessUrl"
  | "subscribeProjectEvents"
> & Partial<Pick<PraxisRemoteClient, "createBrowserSession">>;

interface UsePraxisStudioOptions {
  gateway?: StudioGateway;
  projectId?: string;
}

interface StudioMutationSummary {
  revision: number;
  appliedOperationIds: string[];
  affectedEntityIds: string[];
  invalidatedEntityIds: string[];
  dryRun: boolean;
  checkpointId?: string;
}

export type StudioCommandResult =
  | {
      ok: true;
      project: ProductionProject;
      previewProject?: ProductionProject;
      result: StudioMutationSummary;
    }
  | {
      ok: false;
      project: ProductionProject;
      error: ProjectCommandError;
    };

type CloudRunState = CloudRunView;

interface AgentRunAuthority {
  stages: readonly AgentRunStage[];
  mode: AgentRunMode;
}

const idleRun: CloudRunState = {
  id: "cloud_run_idle",
  label: "Gateway production",
  status: "idle",
  baseRevision: 0,
  maxSpendUsd: 0,
};

const AGENT_RUN_SCOPES: CreateAgentRunRequest["scopes"] = [
  "project:read",
  "command:write",
  "job:create",
  "job:read",
  "job:cancel",
  "agent:read",
  "agent:write",
];

function cloudRunView(run: AgentRun | undefined): CloudRunState {
  if (!run) return idleRun;
  return {
    id: run.id,
    label: run.role === "reviewer" ? "Codex review" : "Codex production",
    status: run.status,
    role: run.role,
    baseRevision: run.baseRevision,
    maxSpendUsd: run.maxSpendUsd,
    claimExpiresAt: run.claimExpiresAt,
    leaseExpiresAt: run.leaseExpiresAt,
    codexTaskUrl: run.codexTaskUrl,
    completionSummary: run.completionSummary,
    errorMessage: run.errorMessage,
  };
}

const TERMINAL_AGENT_RUN_STATUSES = new Set<AgentRun["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

function preferredAgentRun(runs: readonly AgentRun[]): AgentRun | undefined {
  let latestActive: AgentRun | undefined;
  let latestTerminal: AgentRun | undefined;
  for (const run of runs) {
    if (TERMINAL_AGENT_RUN_STATUSES.has(run.status)) {
      if (!latestTerminal || run.updatedAt > latestTerminal.updatedAt) latestTerminal = run;
    } else if (!latestActive || run.updatedAt > latestActive.updatedAt) {
      latestActive = run;
    }
  }
  return latestActive ?? latestTerminal;
}

function agentRunAuthority(draft: DelegationDraft, role: AgentRunRole): AgentRunAuthority {
  const mode: AgentRunMode = role === "reviewer" ? "propose" : "act";
  return {
    mode,
    stages: STAGE_ORDER.filter((stage): stage is AgentRunStage => draft.modes[stage] === mode),
  };
}

function deniedLockedEntities(project: ProductionProject): string[] {
  return lockedEntityIds(project);
}

function derivedIdempotencyKey(value: string, suffix: string): string {
  return `${value.slice(0, Math.max(8, 159 - suffix.length))}:${suffix}`.slice(0, 160);
}

const initialSelection: SelectionView = {
  sceneId: "scene_03",
  clipId: "clip_scene_03",
  playheadFrame: 285,
  activeView: "script",
};

const emptyHistory: HistorySummary = { canUndo: false, canRedo: false, entries: [] };
const emptyBudget: ProjectBudgetSummary = {
  maxSpendUsd: 1,
  reservedUsd: 0,
  settledUsd: 0,
  availableUsd: 1,
};

function nextId(prefix: string) {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? Math.random().toString(36).slice(2);
  return `${prefix}_${random}`;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function persistedAssetVersion(
  record: AssetSummary,
  project: ProductionProject,
  version: number,
): AssetVersion {
  const provenance = record.provenance as Record<string, unknown>;
  const projectRevision = typeof provenance.projectRevision === "number"
    && Number.isInteger(provenance.projectRevision)
    && provenance.projectRevision >= 0
    ? provenance.projectRevision
    : project.revision;
  const jobId = optionalString(provenance.jobId, 128);
  const providerRequestId = optionalString(provenance.providerRequestId, 256);
  const sourceAssetVersionIds = Array.isArray(provenance.sourceAssetVersionIds)
    ? provenance.sourceAssetVersionIds.filter(
      (candidate): candidate is string => typeof candidate === "string" && STABLE_ID_PATTERN.test(candidate),
    ).slice(0, 32)
    : [];

  return AssetVersionSchema.parse({
    id: record.assetVersionId,
    version,
    status: "ready",
    uri: `/api/projects/${record.projectId}/assets/${record.assetVersionId}/access`,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    durationFrames: record.durationMs
      ? Math.max(1, Math.round((record.durationMs / 1_000) * project.metadata.fps))
      : undefined,
    createdAt: record.createdAt,
    provider: optionalString(provenance.provider, 160),
    model: optionalString(provenance.model, 160),
    checksum: record.sha256,
    objectKey: record.objectKey,
    sha256: record.sha256,
    byteLength: record.byteLength,
    provenance: {
      projectRevision,
      sourceAssetVersionIds,
      ...(jobId && STABLE_ID_PATTERN.test(jobId) ? { jobId } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
    },
  });
}

function projectLocator(explicit?: string) {
  if (explicit) return explicit;
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(PROJECT_LOCATOR_KEY);
    if (stored) return stored;
  }
  return createSeedProject().projectId;
}

function actorSession(actor: ActorKind) {
  return actor === "codex" ? "session_webmcp" : actor === "system" ? "session_system" : "session_director";
}

function delegationDraftFromProject(project: ProductionProject): DelegationDraft {
  return {
    modes: Object.fromEntries(
      STAGE_ORDER.map((stage) => [stage, project.delegation[stage].mode]),
    ) as DelegationDraft["modes"],
    maxSpendUsd: project.delegation.assets.maxSpendUsd ?? 1,
    preserveLocked: true,
  };
}

function connectionMessage(error: unknown) {
  if (error instanceof PraxisApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "The control plane could not be reached.";
}

function historyActor(value: unknown): StudioActor {
  return value === "codex" || value === "system" ? value : "director";
}

function historyLedger(history: HistorySummary, checkpoints: readonly CheckpointSummary[]): LedgerView[] {
  const entries = history.entries.map((entry, index): LedgerView => ({
    id: entry.commandId || `history_${index}`,
    revision: entry.resultRevision ?? (entry as { revisionAfter?: number }).revisionAfter ?? 0,
    actor: historyActor(entry.actorKind),
    action: entry.reason ?? "Project command committed",
    detail: `${entry.affectedEntityIds?.length ?? 0} affected · ${entry.staleEntityIds?.length ?? 0} stale`,
    timestamp: entry.createdAt ?? (entry as { committedAt?: string }).committedAt ?? "",
    tone: (entry.staleEntityIds?.length ?? 0) > 0 ? "warning" : "normal",
  }));
  const checkpointEntries = checkpoints.map((checkpoint): LedgerView => ({
    id: `ledger_${checkpoint.checkpointId}`,
    revision: checkpoint.revision,
    actor: historyActor(checkpoint.createdBy),
    action: `Checkpoint · ${checkpoint.label}`,
    detail: checkpoint.reason ?? "Durable restore point",
    timestamp: checkpoint.createdAt,
    tone: "success",
    checkpointId: checkpoint.checkpointId,
  }));
  return [...entries, ...checkpointEntries]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 80);
}

function domainFailure(error: unknown, project: ProductionProject): StudioCommandResult {
  if (error instanceof PraxisConflictError) {
    return {
      ok: false,
      project,
      error: {
        code: "REVISION_CONFLICT",
        expectedRevision: error.expectedRevision ?? project.revision,
        currentRevision: error.currentRevision ?? project.revision,
        changedEntities: [...error.changedEntityIds],
        summary: error.message,
      },
    };
  }
  const api = error instanceof PraxisApiError ? error : undefined;
  return {
    ok: false,
    project,
    error: {
      code: "INVALID_OPERATION",
      operationType: api?.code,
      summary: connectionMessage(error),
    },
  };
}

export function usePraxisStudio(options: UsePraxisStudioOptions = {}) {
  const seed = useMemo(createSeedProject, []);
  const projectId = useMemo(() => projectLocator(options.projectId), [options.projectId]);
  const defaultGateway = useRef<StudioGateway | null>(null);
  if (!defaultGateway.current && typeof window !== "undefined") {
    defaultGateway.current = new PraxisRemoteClient({
      baseUrl: window.location.origin,
      refreshBrowserSessionOnUnauthorized: true,
    });
  }
  const gateway = options.gateway ?? defaultGateway.current;

  const [project, setProject] = useState(seed);
  const [history, setHistory] = useState<HistorySummary>(emptyHistory);
  const [checkpoints, setCheckpoints] = useState<readonly CheckpointSummary[]>([]);
  const [jobs, setJobs] = useState<readonly JobRecord[]>([]);
  const [budget, setBudget] = useState<ProjectBudgetSummary>(emptyBudget);
  const [assets, setAssets] = useState<readonly AssetSummary[]>([]);
  const [renders, setRenders] = useState<readonly RenderSummary[]>([]);
  const [agentRuns, setAgentRuns] = useState<readonly AgentRun[]>([]);
  const [latestEventSequence, setLatestEventSequence] = useState(0);
  const [connection, setConnection] = useState<BackendConnectionView>({
    status: "loading",
    message: "Connecting to the Praxis control plane…",
  });
  const [isReady, setIsReady] = useState(false);
  const [pendingActions, setPendingActions] = useState(0);
  const [selection, setSelection] = useState<SelectionView>(initialSelection);
  const [inspectedAssetVersionId, setInspectedAssetVersionId] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<StudioStageName>("edit");
  const [isPlaying, setIsPlaying] = useState(false);
  const [delegationOpen, setDelegationOpen] = useState(false);
  const [delegationDraft, setDelegationDraft] = useState(() => delegationDraftFromProject(seed));
  const [editingSceneId, setEditingSceneId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastView[]>([]);
  const projectRef = useRef(project);
  const hydrationRef = useRef<ProjectHydrationResponse | null>(null);

  const commitProject = useCallback((next: ProductionProject) => {
    projectRef.current = next;
    setProject(next);
  }, []);

  const addToast = useCallback((toast: Omit<ToastView, "id">) => {
    const id = nextId("toast");
    setToasts((current) => [...current, { ...toast, id }]);
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        setToasts((current) => current.filter((candidate) => candidate.id !== id));
      }, 5_200);
    }
  }, []);

  const applyHydration = useCallback((value: ProjectHydrationResponse) => {
    const parsed = ProductionProjectSchema.parse(value.project);
    const firstHydration = hydrationRef.current === null;
    hydrationRef.current = value;
    commitProject(parsed);
    setHistory(value.history);
    setCheckpoints(value.checkpoints);
    setJobs(value.jobs);
    setBudget(value.budget);
    setAssets(value.assets);
    setRenders(value.renders);
    setAgentRuns(value.agentRuns ?? []);
    setLatestEventSequence(value.latestEventSequence);
    if (firstHydration) setDelegationDraft(delegationDraftFromProject(parsed));
    setSelection((current) => {
      const sceneExists = parsed.scenes.some((scene) => scene.meta.id === current.sceneId);
      return sceneExists ? current : { ...current, sceneId: parsed.scenes[0]?.meta.id ?? null };
    });
    if (typeof window !== "undefined") window.localStorage.setItem(PROJECT_LOCATOR_KEY, parsed.projectId);
    setIsReady(true);
    setConnection({ status: "connected", message: `Live · event ${value.latestEventSequence}` });
    return value;
  }, [commitProject]);

  const refresh = useCallback(async (quiet = false) => {
    if (!gateway) throw new Error("No browser gateway is available.");
    if (!quiet) setConnection({ status: "loading", message: "Hydrating the durable project…" });
    try {
      return applyHydration(await gateway.getProject(projectId));
    } catch (firstError) {
      let error = firstError;
      if (
        error instanceof PraxisApiError &&
        error.status === 401 &&
        gateway.createBrowserSession
      ) {
        try {
          await gateway.createBrowserSession();
          return applyHydration(await gateway.getProject(projectId));
        } catch (sessionError) {
          error = sessionError;
        }
      }
      if (error instanceof PraxisApiError && error.status === 404) {
        return applyHydration(await gateway.createProject({ projectId, snapshot: seed }));
      }
      if (!quiet) {
        setConnection({ status: "error", message: connectionMessage(error) });
        setIsReady(false);
      }
      throw error;
    }
  }, [applyHydration, gateway, projectId, seed]);

  useEffect(() => {
    let live = true;
    void refresh().catch(() => {
      if (!live) return;
    });
    return () => { live = false; };
  }, [refresh]);

  useEffect(() => {
    if (!gateway || !isReady) return;
    const options: SubscribeProjectEventsOptions = {
      afterSequence: latestEventSequence,
      reconnect: true,
      onEvent: async () => {
        await refresh(true).catch(() => undefined);
      },
      onGap: async (gap) => {
        setConnection({
          status: "reconnecting",
          message: `Event gap ${gap.expectedSequence}–${gap.receivedSequence - 1}; reconciling…`,
        });
        await refresh(true).catch(() => undefined);
      },
      onError: async (error) => {
        setConnection({ status: "reconnecting", message: "Event stream reconnecting…" });
        if (error instanceof PraxisApiError && error.status === 401) {
          await refresh(true).catch(() => undefined);
        }
      },
    };
    const subscription: ProjectEventSubscription = gateway.subscribeProjectEvents(projectId, options);
    void subscription.done.catch(() => undefined);
    return () => subscription.close();
  }, [gateway, isReady, projectId, refresh]);

  useEffect(() => {
    const selected = projectScenes(project).find((scene) => scene.id === selection.sceneId);
    if (!isPlaying || !selected) return;
    const timer = window.setInterval(() => {
      setSelection((current) => {
        const end = selected.startFrame + selected.durationFrames;
        const frame = current.playheadFrame + 3;
        return { ...current, playheadFrame: frame >= end ? selected.startFrame : frame };
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [isPlaying, project, selection.sceneId]);

  const withPending = useCallback(async <T,>(work: () => Promise<T>) => {
    setPendingActions((count) => count + 1);
    try {
      return await work();
    } finally {
      setPendingActions((count) => Math.max(0, count - 1));
    }
  }, []);

  const reconcileMutation = useCallback(async (response: CommandCommitResponse) => {
    commitProject(ProductionProjectSchema.parse(response.project));
    if (response.eventSequence !== undefined) setLatestEventSequence(response.eventSequence);
    await refresh(true).catch(() => undefined);
    setConnection({ status: "connected", message: `Synced · revision ${response.revision}` });
    return response;
  }, [commitProject, refresh]);

  const handleFailure = useCallback(async (error: unknown, title = "Command rejected") => {
    let authoritative = projectRef.current;
    if (error instanceof PraxisConflictError) {
      const hydration = await refresh(true).catch(() => undefined);
      if (hydration) authoritative = hydration.project;
      setConnection({
        status: "conflict",
        message: `Revision ${error.expectedRevision ?? "?"} lost to ${error.currentRevision ?? authoritative.revision}; authoritative state reloaded.`,
      });
    } else {
      setConnection((current) => current.status === "connected" ? current : {
        status: "error",
        message: connectionMessage(error),
      });
    }
    addToast({ title, detail: connectionMessage(error), tone: "warning" });
    return domainFailure(error, authoritative);
  }, [addToast, refresh]);

  const executeOperations = useCallback(async (
    operations: ProjectOperation[],
    reason: string,
    actor: ActorKind = "director",
    baseRevision?: number,
    dryRun = false,
    idempotencyKey?: string,
  ): Promise<StudioCommandResult> => withPending(async () => {
    if (!gateway || !isReady) return domainFailure(new Error("Studio is still hydrating."), projectRef.current);
    const current = projectRef.current;
    const command = createProjectCommand(current.projectId, baseRevision ?? current.revision, operations, {
      actor: { kind: actor, sessionId: actorSession(actor) },
      reason,
      dryRun,
      idempotencyKey,
    });
    try {
      const response = await gateway.applyCommand(current.projectId, command);
      await reconcileMutation(response);
      const committed = ProductionProjectSchema.parse(response.project);
      return {
        ok: true,
        project: dryRun ? current : committed,
        ...(dryRun ? { previewProject: committed } : {}),
        result: {
          revision: response.revision,
          appliedOperationIds: command.operations.map((operation, index) => operation.operationId ?? `${command.commandId}:op:${index}`),
          affectedEntityIds: [...response.affectedEntityIds],
          invalidatedEntityIds: [...response.staleEntityIds],
          dryRun,
          ...(response.checkpointId ? { checkpointId: response.checkpointId } : {}),
        },
      };
    } catch (error) {
      return handleFailure(error);
    }
  }), [gateway, handleFailure, isReady, reconcileMutation, withPending]);

  const simpleRevisionMutation = useCallback(async (
    action: "undo" | "redo",
    idempotencyKey = nextId(action),
  ) => withPending(async () => {
    if (!gateway || !isReady) return;
    try {
      const request = { baseRevision: projectRef.current.revision, idempotencyKey };
      const response = action === "undo"
        ? await gateway.undoProject(projectId, request)
        : await gateway.redoProject(projectId, request);
      await reconcileMutation(response);
      addToast({ title: action === "undo" ? "Command undone" : "Command redone", detail: `Project is now revision ${response.revision}.`, tone: "success" });
    } catch (error) {
      await handleFailure(error, action === "undo" ? "Unable to undo" : "Unable to redo");
    }
  }), [addToast, gateway, handleFailure, isReady, projectId, reconcileMutation, withPending]);

  const scenes = useMemo(() => projectScenes(project), [project]);
  const stages = useMemo(() => projectStages(project), [project]);
  const tracks = useMemo(() => projectTracks(project), [project]);
  const ledger = useMemo(() => historyLedger(history, checkpoints), [checkpoints, history]);
  const cloudRun = useMemo(() => cloudRunView(preferredAgentRun(agentRuns)), [agentRuns]);
  const selectedScene = scenes.find((scene) => scene.id === selection.sceneId) ?? scenes[0] ?? null;
  const editingScene = scenes.find((scene) => scene.id === editingSceneId) ?? null;

  const selectScene = useCallback((sceneId: string) => {
    const scene = projectScenes(projectRef.current).find((candidate) => candidate.id === sceneId);
    const clip = projectRef.current.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.sceneId === sceneId);
    setSelection((current) => ({
      ...current,
      sceneId,
      clipId: clip?.meta.id ?? current.clipId,
      playheadFrame: scene?.startFrame ?? current.playheadFrame,
    }));
    setInspectedAssetVersionId(null);
  }, []);

  const selectClip = useCallback((clipId: string, sceneId?: string) => {
    const clip = projectRef.current.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.meta.id === clipId);
    setSelection((current) => ({
      ...current,
      clipId,
      sceneId: sceneId ?? clip?.sceneId ?? current.sceneId,
      playheadFrame: clip?.startFrame ?? current.playheadFrame,
    }));
    setInspectedAssetVersionId(null);
  }, []);

  const toggleSceneLock = useCallback(async (sceneId: string, locked: boolean) => {
    await executeOperations(
      [{ type: "scene.setLocked", sceneId, locked }],
      locked ? "Director locked scene" : "Director unlocked scene",
    );
  }, [executeOperations]);

  const updateSceneBeat = useCallback(async (sceneId: string, narration: string, visualIntent: string) => {
    const scene = projectRef.current.scenes.find((candidate) => candidate.meta.id === sceneId);
    if (!scene) return;
    const result = await executeOperations(
      [{ type: "script.updateBeat", beatId: scene.beatId, patch: { narration, visualIntent } }],
      "Director revised script beat",
    );
    if (result.ok) {
      setEditingSceneId(null);
      addToast({
        title: "Beat committed",
        detail: `${result.result.invalidatedEntityIds.length} downstream entities became stale; placements were preserved.`,
        tone: "success",
      });
    }
  }, [addToast, executeOperations]);

  const moveClip = useCallback(async (clipId: string, startFrame: number) => {
    if (clipId.startsWith("proposal:")) {
      addToast({ title: "Proposal branch", detail: "Accept the proposal before moving its ghost edit.", tone: "info" });
      return;
    }
    await executeOperations([{ type: "timeline.moveClip", clipId, startFrame }], "Director moved timeline clip");
  }, [addToast, executeOperations]);

  const delegationOperations = useCallback((draft: DelegationDraft): ProjectOperation[] =>
    STAGE_ORDER.map((stage): ProjectOperation => ({
      type: "delegation.set",
      stage,
      mode: draft.modes[stage],
      maxSpendUsd: stage === "assets" ? draft.maxSpendUsd : 0,
    })), []);

  const saveDelegation = useCallback(async () => {
    const result = await executeOperations(delegationOperations(delegationDraft), "Director updated delegation policy");
    if (result.ok) {
      setDelegationOpen(false);
      addToast({ title: "Delegation saved", detail: "Stage authority is durable and revisioned.", tone: "success" });
    }
    return result;
  }, [addToast, delegationDraft, delegationOperations, executeOperations]);

  const createCheckpoint = useCallback(async (
    label: string,
    actor: ActorKind = "director",
    baseRevision?: number,
    idempotencyKey = nextId("checkpoint"),
  ) => withPending(async () => {
    const current = projectRef.current;
    if (!gateway || !isReady) return { result: domainFailure(new Error("Studio is still hydrating."), current), checkpointId: "" };
    try {
      const response = await gateway.createCheckpoint(projectId, {
        baseRevision: baseRevision ?? current.revision,
        idempotencyKey,
        label,
        reason: actor === "codex" ? "Codex requested a durable checkpoint" : label,
        ...(actor === "codex" ? { actor: { kind: "codex" as const } } : {}),
      });
      await reconcileMutation(response);
      return {
        checkpointId: response.checkpointId,
        result: {
          ok: true,
          project: response.project,
          result: {
            revision: response.revision,
            appliedOperationIds: [],
            affectedEntityIds: [...response.affectedEntityIds],
            invalidatedEntityIds: [...response.staleEntityIds],
            dryRun: false,
            checkpointId: response.checkpointId,
          },
        } satisfies StudioCommandResult,
      };
    } catch (error) {
      return { result: await handleFailure(error, "Checkpoint failed"), checkpointId: "" };
    }
  }), [gateway, handleFailure, isReady, projectId, reconcileMutation, withPending]);

  const restoreCheckpoint = useCallback(async (
    checkpointId: string,
    baseRevision?: number,
    dryRun = false,
    actor: ActorKind = "director",
    idempotencyKey = nextId("restore"),
  ): Promise<StudioCommandResult | null> => withPending(async () => {
    const current = projectRef.current;
    if (!checkpoints.some((checkpoint) => checkpoint.checkpointId === checkpointId)) return null;
    if (dryRun) {
      return {
        ok: true,
        project: current,
        previewProject: current,
        result: {
          revision: current.revision,
          appliedOperationIds: [],
          affectedEntityIds: [],
          invalidatedEntityIds: [],
          dryRun: true,
          checkpointId,
        },
      };
    }
    if (!gateway || !isReady) return domainFailure(new Error("Studio is still hydrating."), current);
    try {
      const response = await gateway.restoreCheckpoint(projectId, checkpointId, {
        baseRevision: baseRevision ?? current.revision,
        idempotencyKey,
        reason: actor === "codex" ? "Codex restored checkpoint" : "Director restored checkpoint",
      });
      await reconcileMutation(response);
      setDelegationDraft(delegationDraftFromProject(response.project));
      addToast({ title: "Checkpoint restored", detail: `Project advanced safely to revision ${response.revision}.`, tone: "success" });
      return {
        ok: true,
        project: response.project,
        result: {
          revision: response.revision,
          appliedOperationIds: [],
          affectedEntityIds: [...response.affectedEntityIds],
          invalidatedEntityIds: [...response.staleEntityIds],
          dryRun: false,
          checkpointId,
        },
      };
    } catch (error) {
      return handleFailure(error, "Restore failed");
    }
  }), [addToast, checkpoints, gateway, handleFailure, isReady, projectId, reconcileMutation, withPending]);

  const launchCloudRun = useCallback(async (
    draft: DelegationDraft,
    actor: ActorKind = "director",
    baseRevision?: number,
    idempotencyKey = nextId("delegation"),
    role: AgentRunRole = "producer-editor",
    authority: AgentRunAuthority = agentRunAuthority(draft, role),
  ) => {
    if (role === "reviewer" && authority.mode !== "propose") {
      return {
        result: domainFailure(
          new Error("Reviewer AgentRuns are proposal-only."),
          projectRef.current,
        ),
        checkpointId: "",
        runId: "",
      };
    }
    if (authority.stages.length === 0) {
      return {
        result: domainFailure(
          new Error(`No stages grant ${authority.mode} authority for this AgentRun.`),
          projectRef.current,
        ),
        checkpointId: "",
        runId: "",
      };
    }
    const result = await executeOperations(
      delegationOperations(draft),
      actor === "codex" ? "Codex delegated production policy" : "Director delegated script → scene plan → rough cut",
      actor,
      baseRevision,
      false,
      idempotencyKey,
    );
    if (!result.ok) return { result, checkpointId: "", runId: "" };
    if (!gateway || !isReady) {
      return { result: domainFailure(new Error("Studio is still hydrating."), result.project), checkpointId: "", runId: "" };
    }
    try {
      const created = await withPending(() => gateway.createAgentRun(projectId, {
        idempotencyKey: derivedIdempotencyKey(idempotencyKey, "agent-run"),
        baseRevision: result.project.revision,
        role,
        stages: [...authority.stages],
        mode: authority.mode,
        scopes: AGENT_RUN_SCOPES,
        deniedEntityIds: deniedLockedEntities(result.project),
        maxSpendUsd: draft.maxSpendUsd,
        checkpointLabel: "Before delegated production",
        checkpointReason: actor === "codex"
          ? "WebMCP delegated a bounded production run"
          : "Director delegated Script → Rough cut",
      }));
      setAgentRuns((current) => [created.run, ...current.filter((run) => run.id !== created.run.id)]);
      if (created.eventSequence !== undefined) setLatestEventSequence(created.eventSequence);
      await refresh(true).catch(() => undefined);
      setDelegationOpen(false);
      addToast({
        title: "AgentRun created",
        detail: `${created.run.id} is durable and awaiting dispatcher claim.`,
        tone: "success",
      });
      return {
        result,
        checkpointId: created.run.checkpointId,
        runId: created.run.id,
        agentRun: created.run,
      };
    } catch (error) {
      return {
        result: await handleFailure(error, "AgentRun creation failed"),
        checkpointId: "",
        runId: "",
      };
    }
  }, [addToast, delegationOperations, executeOperations, gateway, handleFailure, isReady, projectId, refresh, withPending]);

  const createMediaJob = useCallback(async (request: JobCreateRequest) => withPending(async () => {
    if (!gateway || !isReady) throw new Error("Studio is still hydrating.");
    try {
      const response = await gateway.createJob(projectId, request);
      setJobs((current) => [response.job, ...current.filter((job) => job.jobId !== response.job.jobId)]);
      if (response.eventSequence !== undefined) setLatestEventSequence(response.eventSequence);
      await refresh(true).catch(() => undefined);
      addToast({ title: "Job queued", detail: `${response.job.jobType} · ${response.job.jobId}`, tone: "success" });
      return response.job;
    } catch (error) {
      await handleFailure(error, "Job rejected");
      throw error;
    }
  }), [addToast, gateway, handleFailure, isReady, projectId, refresh, withPending]);

  const generateSceneAsset = useCallback((sceneId = selection.sceneId ?? undefined, prompt?: string, idempotencyKey = nextId("image"), baseRevision?: number) => {
    const scene = projectRef.current.scenes.find((candidate) => candidate.meta.id === sceneId);
    if (!scene) return Promise.reject(new Error("Select a scene before generating media."));
    const assetId = scene.requiredAssetIds[0];
    if (!assetId) return Promise.reject(new Error("The selected scene has no image asset target."));
    return createMediaJob({
      jobType: "image.generate",
      idempotencyKey,
      baseRevision: baseRevision ?? projectRef.current.revision,
      targetEntityIds: [scene.meta.id, assetId],
      request: {
        assetId,
        sceneId: scene.meta.id,
        prompt: prompt ?? scene.visualDescription,
        size: "1536x1024",
        format: "png",
        quality: "low",
        provider: "fake",
      },
    });
  }, [createMediaJob, selection.sceneId]);

  const generateNarration = useCallback((beatIds?: readonly string[], idempotencyKey = nextId("speech"), baseRevision?: number) => {
    const selectedBeatId = projectRef.current.scenes.find((scene) => scene.meta.id === selection.sceneId)?.beatId;
    const targets = beatIds?.length ? [...beatIds] : selectedBeatId ? [selectedBeatId] : projectRef.current.script.beats.map((beat) => beat.meta.id);
    return createMediaJob({
      jobType: "speech.generate",
      idempotencyKey,
      baseRevision: baseRevision ?? projectRef.current.revision,
      targetEntityIds: ["asset_narration", ...targets],
      request: {
        assetId: "asset_narration",
        beatIds: targets,
        provider: "fake",
        format: "wav",
      },
    });
  }, [createMediaJob, selection.sceneId]);

  const startRender = useCallback((kind: "preview" | "final" = "preview", idempotencyKey = nextId(`render_${kind}`), baseRevision?: number) =>
    createMediaJob({
      jobType: kind === "final" ? "render.final" : "render.preview",
      idempotencyKey,
      baseRevision: baseRevision ?? projectRef.current.revision,
      targetEntityIds: [projectRef.current.timeline.meta.id],
      request: { rendererVersion: "praxis-ffmpeg-1" },
    }), [createMediaJob]);

  const getJob = useCallback(async (jobId: string) => {
    if (!gateway) throw new Error("No gateway is available.");
    const response = await gateway.getJob(projectId, jobId);
    setJobs((current) => [response.job, ...current.filter((job) => job.jobId !== jobId)]);
    return response.job;
  }, [gateway, projectId]);

  const cancelJob = useCallback(async (jobId: string) => {
    if (!gateway) throw new Error("No gateway is available.");
    const response = await gateway.cancelJob(projectId, jobId);
    setJobs((current) => [response.job, ...current.filter((job) => job.jobId !== jobId)]);
    addToast({ title: "Cancellation requested", detail: jobId, tone: "info" });
    return response.job;
  }, [addToast, gateway, projectId]);

  const selectedAssetId = project.scenes.find((scene) => scene.meta.id === selection.sceneId)?.requiredAssetIds[0];
  const selectedAsset = selectedAssetId ? project.assets[selectedAssetId] : undefined;
  const assetVersions = useMemo<AssetVersionView[]>(() => {
    if (!selectedAsset) return [];
    const canonicalVersionIds = new Set(selectedAsset.versions.map((version) => version.id));
    const canonical = [...selectedAsset.versions].sort((left, right) => right.version - left.version).map((version) => {
      const persisted = assets.some((record) => record.assetVersionId === version.id);
      return {
        id: version.id,
        label: `v${version.version} · ${version.status}`,
        status: version.status,
        selected: (inspectedAssetVersionId ?? selectedAsset.currentVersionId) === version.id,
        unattached: false,
        ...(persisted && gateway ? { accessUrl: gateway.assetAccessUrl(projectId, version.id) } : {}),
      };
    });
    const unattached = assets
      .filter((record) => record.assetId === selectedAssetId && !canonicalVersionIds.has(record.assetVersionId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((record): AssetVersionView => ({
        id: record.assetVersionId,
        label: `${record.assetVersionId} · stale / unattached`,
        status: "stale",
        selected: inspectedAssetVersionId === record.assetVersionId,
        unattached: true,
        ...(gateway ? { accessUrl: gateway.assetAccessUrl(projectId, record.assetVersionId) } : {}),
      }));
    return [...unattached, ...canonical];
  }, [assets, gateway, inspectedAssetVersionId, projectId, selectedAsset, selectedAssetId]);

  const selectAssetVersion = useCallback(async (versionId: string) => {
    const current = projectRef.current;
    const assetId = current.scenes.find((scene) => scene.meta.id === selection.sceneId)?.requiredAssetIds[0];
    if (!assetId) return;
    const canonical = current.assets[assetId]?.versions.some((version) => version.id === versionId) ?? false;
    const persisted = assets.some((record) => record.assetId === assetId && record.assetVersionId === versionId);
    if (!canonical && persisted) {
      setInspectedAssetVersionId(versionId);
      return;
    }
    setInspectedAssetVersionId(null);
    const operations: ProjectOperation[] = [{ type: "asset.selectVersion", assetId, versionId }];
    const clip = current.timeline.tracks.flatMap((track) => track.clips).find((candidate) => candidate.meta.id === selection.clipId);
    if (clip?.assetId === assetId) {
      operations.push({ type: "timeline.updateClip", clipId: clip.meta.id, patch: { assetVersionId: versionId, versionPolicy: "pinned" } });
    }
    await executeOperations(operations, `Director selected ${versionId}`);
  }, [assets, executeOperations, selection.clipId, selection.sceneId]);

  const adoptAssetVersion = useCallback(async (versionId: string) => {
    const current = projectRef.current;
    const assetId = current.scenes.find((scene) => scene.meta.id === selection.sceneId)?.requiredAssetIds[0];
    const asset = assetId ? current.assets[assetId] : undefined;
    const record = assetId
      ? assets.find((candidate) => candidate.assetId === assetId && candidate.assetVersionId === versionId)
      : undefined;
    if (!assetId || !asset || !record) {
      return handleFailure(new Error("The persisted asset is no longer available for this scene."), "Asset adoption failed");
    }
    if (asset.versions.some((version) => version.id === versionId)) {
      setInspectedAssetVersionId(null);
      return selectAssetVersion(versionId);
    }

    let version: AssetVersion;
    try {
      version = persistedAssetVersion(
        record,
        current,
        Math.max(0, ...asset.versions.map((candidate) => candidate.version)) + 1,
      );
    } catch (error) {
      return handleFailure(error, "Asset adoption failed");
    }

    const operations: ProjectOperation[] = [
      { type: "asset.addVersion", assetId, version },
      { type: "asset.selectVersion", assetId, versionId },
    ];
    for (const track of current.timeline.tracks) {
      if (track.meta.locked) continue;
      for (const clip of track.clips) {
        if (clip.assetId !== assetId || clip.meta.locked) continue;
        const scene = clip.sceneId
          ? current.scenes.find((candidate) => candidate.meta.id === clip.sceneId)
          : undefined;
        if (scene?.meta.locked) continue;
        operations.push({
          type: "timeline.updateClip",
          clipId: clip.meta.id,
          patch: { assetVersionId: versionId, versionPolicy: "pinned", status: "approved" },
        });
      }
    }

    const result = await executeOperations(operations, `Director adopted unattached asset ${versionId}`);
    if (result.ok) {
      setInspectedAssetVersionId(null);
      addToast({
        title: "Asset adopted",
        detail: `${versionId} is now canonical and pinned to matching unlocked clips.`,
        tone: "success",
      });
    }
    return result;
  }, [addToast, assets, executeOperations, handleFailure, selectAssetVersion, selection.sceneId]);

  const previewedAssetVersion = assetVersions.find((version) => version.selected);
  const inspectedPersisted = previewedAssetVersion?.unattached
    ? assets.find((record) => record.assetId === selectedAssetId && record.assetVersionId === previewedAssetVersion.id)
    : undefined;
  const selectedVersion = selectedAsset?.versions.find((version) => version.id === selectedAsset.currentVersionId);
  const selectedPersisted = selectedVersion ? assets.find((record) => record.assetVersionId === selectedVersion.id) : undefined;
  const previewAssetUrl = inspectedPersisted && gateway
    ? gateway.assetAccessUrl(projectId, inspectedPersisted.assetVersionId)
    : selectedPersisted && gateway
    ? gateway.assetAccessUrl(projectId, selectedPersisted.assetVersionId)
    : selectedVersion?.uri?.startsWith("/") ? selectedVersion.uri : DEFAULT_PREVIEW_URL;

  const completedRenderJob = [...jobs]
    .filter((job) => job.status === "succeeded" && job.jobType.startsWith("render.") && job.output?.assetVersionId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const renderPlaybackUrl = !previewedAssetVersion?.unattached && completedRenderJob?.output?.assetVersionId && gateway
    ? gateway.assetAccessUrl(projectId, completedRenderJob.output.assetVersionId)
    : undefined;
  const renderRevision = completedRenderJob?.output?.projectRevision;
  const renderOutdated = completedRenderJob
    ? Boolean(completedRenderJob.output?.stale || renderRevision !== project.revision)
    : false;

  const jobQueue = useMemo<JobQueueView[]>(() => [...jobs]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 8)
    .map((job) => ({
      id: job.jobId,
      type: job.jobType,
      status: job.status,
      baseRevision: job.baseRevision,
      reservedCostUsd: job.reservedCostUsd,
      settledCostUsd: job.settledCostUsd,
      ...(job.errorMessage ? { error: job.errorMessage } : {}),
      stale: job.output?.stale,
      attached: job.output?.attached,
      cancellable: ["queued", "running", "waiting_external", "cancel_requested"].includes(job.status),
    })), [jobs]);

  const resetDemo = useCallback(async () => {
    const snapshot = createSeedProject();
    const result = await executeOperations([{ type: "project.restore", snapshot }], "Director reset the durable demo");
    if (result.ok) {
      setSelection(initialSelection);
      addToast({ title: "Demo reset", detail: "The durable project returned to the deterministic Fax Oracle seed.", tone: "success" });
    }
  }, [addToast, executeOperations]);

  const startCloudRun = useCallback(() => launchCloudRun(delegationDraft), [delegationDraft, launchCloudRun]);
  const cancelCloudRun = useCallback(async () => {
    if (!gateway || cloudRun.status === "idle") return;
    try {
      const cancelled = await withPending(() => gateway.cancelAgentRun(projectId, cloudRun.id, {
        idempotencyKey: nextId("cancel_agent_run"),
      }));
      setAgentRuns((current) => [cancelled.run, ...current.filter((run) => run.id !== cancelled.run.id)]);
      if (cancelled.eventSequence !== undefined) setLatestEventSequence(cancelled.eventSequence);
      addToast({ title: "AgentRun cancelled", detail: cancelled.run.id, tone: "info" });
    } catch (error) {
      await handleFailure(error, "AgentRun cancellation failed");
    }
  }, [addToast, cloudRun, gateway, handleFailure, projectId, withPending]);
  const setPlayheadFrame = useCallback((playheadFrame: number) => setSelection((current) => ({ ...current, playheadFrame })), []);

  return {
    project,
    history,
    checkpoints,
    spendUsd: budget.settledUsd,
    reservedUsd: budget.reservedUsd,
    budget,
    jobs,
    jobQueue,
    assets,
    renders,
    agentRuns,
    stages,
    scenes,
    tracks,
    ledger,
    selection,
    selectedScene,
    editingScene,
    activeStage,
    isPlaying,
    delegationOpen,
    delegationDraft,
    cloudRun,
    toasts,
    connection,
    isReady,
    pendingActions,
    assetVersions,
    previewedAssetVersion,
    previewAssetUrl,
    renderPlaybackUrl,
    renderRevision,
    renderOutdated,
    setActiveStage,
    setSelection,
    selectScene,
    selectClip,
    setPlayheadFrame,
    setIsPlaying,
    setDelegationOpen,
    setDelegationDraft,
    setEditingSceneId,
    toggleSceneLock,
    updateSceneBeat,
    moveClip,
    saveDelegation,
    startCloudRun,
    launchCloudRun,
    createCheckpoint,
    cancelCloudRun,
    restoreCheckpoint,
    resetDemo,
    requestRender: () => startRender("preview"),
    requestFinalRender: () => startRender("final"),
    generateSceneAsset,
    generateNarration,
    startRender,
    getJob,
    cancelJob,
    selectAssetVersion,
    adoptAssetVersion,
    undo: () => simpleRevisionMutation("undo"),
    redo: () => simpleRevisionMutation("redo"),
    executeOperations,
    retryConnection: () => refresh(false),
    dismissToast: (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)),
  };
}

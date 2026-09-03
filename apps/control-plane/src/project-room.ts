import { DurableObject } from "cloudflare:workers";
import {
  AGENT_RUN_STAGES,
  AgentRunFinishInputSchema,
  AgentRunDispatchInputSchema,
  AgentRunHeartbeatInputSchema,
  AgentRunSchema,
  AgentRunStatusSchema,
  CreateAgentRunInputSchema,
  assertAgentRunTransition,
  isTerminalAgentRunStatus,
  type AgentClaimTicketClaims,
  type AgentRun,
  type AgentRunFinishInput,
  type AgentRunStage,
  type AgentRunStatus,
  type CreateAgentRunInput,
} from "@praxis/agent-runs";
import { ProjectCommandSchema, type ProjectCommand, type ProjectCommandError } from "@praxis/commands";
import {
  applyCommandWithHistory,
  checkpointRef,
  createCheckpoint,
  createCheckpointCommand,
  createProjectHistory,
  createRestoreCheckpointCommand,
  ProjectCheckpointSchema,
  ProjectHistorySchema,
  redoLastCommand,
  undoLastCommand,
  type HistoryResult,
  type ProjectCheckpoint,
  type ProjectHistory,
} from "@praxis/history";
import {
  BudgetSummarySchema,
  estimateJobCostUsd,
  JobActorSchema,
  JobCreateRequestSchema,
  JobOutputSchema,
  JobRecordSchema,
  JobTransitionSchema,
  PersistedAssetRecordSchema,
  ProjectEventSchema,
  RenderRecordSchema,
  terminalJobStatuses,
  type JobActor,
  type JobCreateRequest,
  type JobOutput,
  type JobRecord,
  type JobTransition,
  type PersistedAssetRecord,
  type ProjectEvent,
  type ProjectEventType,
  type RenderRecord,
} from "@praxis/jobs";
import { ProductionProjectSchema, StableIdSchema, type ProductionProject } from "@praxis/project-schema";
import { z } from "zod";
import { deniedProjectMutationEntities } from "./capabilities";
import { claimTicketDigest, mintAgentClaimTicket } from "./agent-claim-ticket";
import type { Env } from "./env";
import { parseJson, sha256Json, stableJson } from "./json";
import { workflowInstanceId } from "./workflow-instance";

const STORAGE_SCHEMA_VERSION = 3;
const encoder = new TextEncoder();
const AGENT_OPERATION_STAGES: Readonly<Record<string, AgentRunStage>> = {
  "script.updateBeat": "script",
  "scene.update": "previz",
  "scene.setStatus": "previz",
  "timeline.moveClip": "edit",
  "timeline.insertClip": "edit",
  "timeline.updateClip": "edit",
  "timeline.removeClip": "edit",
};
const AGENT_JOB_STAGES: Readonly<Record<JobRecord["jobType"], readonly AgentRunStage[]>> = {
  "image.generate": ["assets", "previz", "edit"],
  "speech.generate": ["assets", "previz", "edit"],
  "render.preview": ["edit"],
  "render.final": ["finish"],
};

const lockedCanonicalEntityIds = (project: ProductionProject): ReadonlySet<string> => {
  const ids = new Set<string>();
  const add = (meta: { id: string; locked: boolean }) => {
    if (meta.locked) ids.add(meta.id);
  };
  for (const beat of project.script.beats) add(beat.meta);
  for (const scene of project.scenes) add(scene.meta);
  for (const asset of Object.values(project.assets)) add(asset.meta);
  add(project.timeline.meta);
  for (const track of project.timeline.tracks) {
    add(track.meta);
    for (const clip of track.clips) add(clip.meta);
  }
  for (const decision of project.decisions) add(decision.meta);
  return ids;
};

export const FinalizeRenderJobInputSchema = z
  .object({
    jobId: StableIdSchema,
    expectedStatuses: z.array(z.enum(["running", "waiting_external"])).min(1).max(2),
    output: JobOutputSchema,
    videoAsset: PersistedAssetRecordSchema,
    posterAsset: PersistedAssetRecordSchema,
    render: RenderRecordSchema,
    actualCostUsd: z.number().nonnegative().finite().optional(),
    costIsEstimate: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    const issue = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const expectEqual = (actual: unknown, expected: unknown, path: Array<string | number>, message: string) => {
      if (actual !== expected) issue(path, message);
    };

    if (new Set(input.expectedStatuses).size !== input.expectedStatuses.length) {
      issue(["expectedStatuses"], "Expected job statuses must be unique");
    }
    expectEqual(input.videoAsset.kind, "render", ["videoAsset", "kind"], "Video asset kind must be render");
    expectEqual(input.posterAsset.kind, "poster", ["posterAsset", "kind"], "Poster asset kind must be poster");
    if (input.videoAsset.assetVersionId === input.posterAsset.assetVersionId) {
      issue(["posterAsset", "assetVersionId"], "Video and poster asset versions must be distinct");
    }
    if (input.videoAsset.objectKey === input.posterAsset.objectKey) {
      issue(["posterAsset", "objectKey"], "Video and poster object keys must be distinct");
    }

    expectEqual(input.render.jobId, input.jobId, ["render", "jobId"], "Render job ID must match jobId");
    expectEqual(input.output.renderId, input.render.renderId, ["output", "renderId"], "Output render ID must match the render record");
    expectEqual(input.output.assetId, input.videoAsset.assetId, ["output", "assetId"], "Output asset ID must match the video asset");
    expectEqual(input.output.assetVersionId, input.videoAsset.assetVersionId, ["output", "assetVersionId"], "Output asset version must match the video asset");
    expectEqual(input.videoAsset.projectId, input.render.projectId, ["videoAsset", "projectId"], "Video asset project must match the render project");
    expectEqual(input.posterAsset.projectId, input.render.projectId, ["posterAsset", "projectId"], "Poster asset project must match the render project");

    expectEqual(input.output.objectKey, input.render.outputObjectKey, ["output", "objectKey"], "Output object key must match the render record");
    expectEqual(input.videoAsset.objectKey, input.render.outputObjectKey, ["videoAsset", "objectKey"], "Video asset object key must match the render record");
    expectEqual(input.output.posterObjectKey, input.render.posterObjectKey, ["output", "posterObjectKey"], "Output poster key must match the render record");
    expectEqual(input.posterAsset.objectKey, input.render.posterObjectKey, ["posterAsset", "objectKey"], "Poster asset object key must match the render record");
    expectEqual(input.output.sha256, input.render.sha256, ["output", "sha256"], "Output hash must match the render record");
    expectEqual(input.videoAsset.sha256, input.render.sha256, ["videoAsset", "sha256"], "Video asset hash must match the render record");
    expectEqual(input.output.posterSha256, input.posterAsset.sha256, ["output", "posterSha256"], "Output poster hash must match the poster asset");

    expectEqual(input.videoAsset.mimeType, "video/mp4", ["videoAsset", "mimeType"], "Render video must be video/mp4");
    expectEqual(input.posterAsset.mimeType, "image/jpeg", ["posterAsset", "mimeType"], "Render poster must be image/jpeg");
    expectEqual(input.output.mimeType, input.videoAsset.mimeType, ["output", "mimeType"], "Output MIME type must match the video asset");
    expectEqual(input.output.byteLength, input.render.byteLength, ["output", "byteLength"], "Output byte length must match the render record");
    expectEqual(input.videoAsset.byteLength, input.render.byteLength, ["videoAsset", "byteLength"], "Video asset byte length must match the render record");
    expectEqual(input.output.width, input.render.width, ["output", "width"], "Output width must match the render record");
    expectEqual(input.videoAsset.width, input.render.width, ["videoAsset", "width"], "Video asset width must match the render record");
    expectEqual(input.output.height, input.render.height, ["output", "height"], "Output height must match the render record");
    expectEqual(input.videoAsset.height, input.render.height, ["videoAsset", "height"], "Video asset height must match the render record");
    expectEqual(input.output.durationMs, input.render.durationMs, ["output", "durationMs"], "Output duration must match the render record");
    expectEqual(input.videoAsset.durationMs, input.render.durationMs, ["videoAsset", "durationMs"], "Video asset duration must match the render record");
    expectEqual(input.output.projectRevision, input.render.projectRevision, ["output", "projectRevision"], "Output revision must match the render record");
    expectEqual(input.output.attached, true, ["output", "attached"], "A finalized render output must be attached");
    expectEqual(input.output.stale, input.render.outdated, ["output", "stale"], "Output stale and render outdated flags must agree");

    for (const [field, asset] of [["videoAsset", input.videoAsset], ["posterAsset", input.posterAsset]] as const) {
      expectEqual(asset.provenance.jobId, input.jobId, [field, "provenance", "jobId"], "Asset provenance job ID must match jobId");
      expectEqual(asset.provenance.projectRevision, input.render.projectRevision, [field, "provenance", "projectRevision"], "Asset provenance revision must match the render record");
      expectEqual(asset.provenance.manifestSha256, input.render.manifestHash, [field, "provenance", "manifestSha256"], "Asset provenance manifest hash must match the render record");
    }
  });

export type FinalizeRenderJobInput = z.infer<typeof FinalizeRenderJobInputSchema>;

export interface FinalizeRenderJobResult {
  job: JobRecord;
  videoAsset: PersistedAssetRecord;
  posterAsset: PersistedAssetRecord;
  render: RenderRecord;
  eventSequence: number;
  idempotentReplay: boolean;
}

export const FinalizeMediaJobInputSchema = z
  .object({
    jobId: StableIdSchema,
    expectedStatuses: z.array(z.enum(["running", "waiting_external"])).min(1).max(2),
    output: JobOutputSchema,
    asset: PersistedAssetRecordSchema,
    command: ProjectCommandSchema.optional(),
    actualCostUsd: z.number().nonnegative().finite().optional(),
    costIsEstimate: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    const issue = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const expectEqual = (actual: unknown, expected: unknown, path: Array<string | number>, message: string) => {
      if (actual !== expected) issue(path, message);
    };

    if (new Set(input.expectedStatuses).size !== input.expectedStatuses.length) {
      issue(["expectedStatuses"], "Expected job statuses must be unique");
    }
    if (input.asset.kind !== "image" && input.asset.kind !== "audio") {
      issue(["asset", "kind"], "Media finalization assets must be image or audio records");
    }
    expectEqual(input.output.assetId, input.asset.assetId, ["output", "assetId"], "Output asset ID must match the asset record");
    expectEqual(input.output.assetVersionId, input.asset.assetVersionId, ["output", "assetVersionId"], "Output asset version must match the asset record");
    expectEqual(input.output.objectKey, input.asset.objectKey, ["output", "objectKey"], "Output object key must match the asset record");
    expectEqual(input.output.sha256, input.asset.sha256, ["output", "sha256"], "Output hash must match the asset record");
    expectEqual(input.output.mimeType, input.asset.mimeType, ["output", "mimeType"], "Output MIME type must match the asset record");
    expectEqual(input.output.byteLength, input.asset.byteLength, ["output", "byteLength"], "Output byte length must match the asset record");
    expectEqual(input.output.width, input.asset.width, ["output", "width"], "Output width must match the asset record");
    expectEqual(input.output.height, input.asset.height, ["output", "height"], "Output height must match the asset record");
    expectEqual(input.output.durationMs, input.asset.durationMs, ["output", "durationMs"], "Output duration must match the asset record");
    expectEqual(input.output.projectRevision, input.asset.provenance.projectRevision, ["output", "projectRevision"], "Output revision must match asset provenance");
    expectEqual(input.asset.provenance.jobId, input.jobId, ["asset", "provenance", "jobId"], "Asset provenance job ID must match jobId");
    if (input.output.renderId !== undefined || input.output.posterObjectKey !== undefined || input.output.posterSha256 !== undefined) {
      issue(["output"], "Media job output cannot contain render or poster fields");
    }
    if (!input.command) return;
    expectEqual(input.command.actor.kind, "system", ["command", "actor", "kind"], "Media finalization commands must use the system actor");
    expectEqual(input.command.projectId, input.asset.projectId, ["command", "projectId"], "Command project must match the asset record");
    expectEqual(input.command.dryRun, false, ["command", "dryRun"], "Media finalization commands cannot be dry runs");
    const additions = input.command.operations.filter((operation) => operation.type === "asset.addVersion");
    if (additions.length !== 1) {
      issue(["command", "operations"], "Media finalization command must contain exactly one asset.addVersion operation");
      return;
    }
    const addition = additions[0]!;
    expectEqual(addition.assetId, input.asset.assetId, ["command", "operations"], "Asset version operation must target the finalized asset");
    expectEqual(addition.version.id, input.asset.assetVersionId, ["command", "operations"], "Command version ID must match the asset record");
    expectEqual(addition.version.objectKey, input.asset.objectKey, ["command", "operations"], "Command version object key must match the asset record");
    expectEqual(addition.version.sha256, input.asset.sha256, ["command", "operations"], "Command version hash must match the asset record");
    expectEqual(addition.version.checksum, input.asset.sha256, ["command", "operations"], "Command version checksum must match the asset record hash");
    expectEqual(addition.version.mimeType, input.asset.mimeType, ["command", "operations"], "Command version MIME type must match the asset record");
    expectEqual(addition.version.byteLength, input.asset.byteLength, ["command", "operations"], "Command version byte length must match the asset record");
    expectEqual(addition.version.width, input.asset.width, ["command", "operations"], "Command version width must match the asset record");
    expectEqual(addition.version.height, input.asset.height, ["command", "operations"], "Command version height must match the asset record");
    expectEqual(addition.version.durationMs, input.asset.durationMs, ["command", "operations"], "Command version duration must match the asset record");
    expectEqual(addition.version.createdAt, input.asset.createdAt, ["command", "operations"], "Command version timestamp must match the asset record");
    expectEqual(addition.version.provenance?.jobId, input.jobId, ["command", "operations"], "Command version provenance job ID must match jobId");
    expectEqual(addition.version.provenance?.projectRevision, input.output.projectRevision, ["command", "operations"], "Command version provenance revision must match the output");
    for (const operation of input.command.operations) {
      if (operation.type !== "asset.selectVersion") continue;
      expectEqual(operation.assetId, input.asset.assetId, ["command", "operations"], "Version selection must target the finalized asset");
      expectEqual(operation.versionId, input.asset.assetVersionId, ["command", "operations"], "Version selection must target the finalized version");
    }
  });

export type FinalizeMediaJobInput = z.infer<typeof FinalizeMediaJobInputSchema>;

export interface FinalizeMediaJobResult {
  job: JobRecord;
  asset: PersistedAssetRecord;
  command?: MutationResponse;
  eventSequence: number;
  idempotentReplay: boolean;
}

export interface RoomError {
  code: string;
  message: string;
  expectedRevision?: number;
  currentRevision?: number;
  changedEntityIds?: string[];
  lockedEntityIds?: string[];
  entityId?: string;
  deniedEntityIds?: string[];
  issues?: unknown[];
}

export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: RoomError };

interface SqlRow {
  [key: string]: SqlStorageValue;
}

interface StoredProjectRow extends SqlRow {
  snapshot_json: string;
  revision: number;
}

interface StoredHistoryRow extends SqlRow {
  history_json: string;
}

interface StoredResultRow extends SqlRow {
  request_hash: string;
  result_json: string;
}

interface EventRow extends SqlRow {
  sequence: number;
  event_type: ProjectEventType;
  payload_json: string;
  created_at: string;
}

interface BudgetRow extends SqlRow {
  reserved_usd: number;
  settled_usd: number;
}

interface CapabilitySpendRow extends SqlRow {
  reserved_usd: number;
  settled_usd: number;
}

interface JobRow extends SqlRow {
  job_id: string;
  project_id: string;
  idempotency_key: string;
  job_type: JobRecord["jobType"];
  status: JobRecord["status"];
  actor_json: string;
  base_revision: number;
  target_entity_ids_json: string;
  request_json: string;
  estimated_cost_usd: number;
  reserved_cost_usd: number;
  settled_cost_usd: number;
  cost_is_estimate: number;
  attempt: number;
  lease_or_workflow_id: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  cancel_requested_at: string | null;
  reconciliation_failures: number;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow extends SqlRow {
  checkpoint_id: string;
  revision: number;
  label: string;
  snapshot_json: string;
  created_by: string;
  reason: string | null;
  created_at: string;
}

interface AssetRow extends SqlRow {
  asset_id: string;
  asset_version_id: string;
  project_id: string;
  kind: PersistedAssetRecord["kind"];
  object_key: string;
  sha256: string;
  mime_type: string;
  byte_length: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  provenance_json: string;
  created_at: string;
}

interface RenderRow extends SqlRow {
  render_id: string;
  project_id: string;
  job_id: string;
  project_revision: number;
  manifest_hash: string;
  manifest_object_key: string | null;
  output_object_key: string;
  poster_object_key: string | null;
  sha256: string;
  byte_length: number;
  width: number;
  height: number;
  duration_ms: number;
  video_codec: string;
  audio_codec: string | null;
  pixel_format: string;
  outdated: number;
  created_at: string;
}

interface AgentRunRow extends SqlRow {
  run_id: string;
  project_id: string;
  checkpoint_id: string;
  base_revision: number;
  role: AgentRun["role"];
  stages_json: string;
  mode: NonNullable<AgentRun["mode"]>;
  status: AgentRunStatus;
  scopes_json: string;
  denied_entity_ids_json: string;
  max_spend_usd: number;
  claim_ticket_ttl_seconds: number;
  claim_expires_at: string;
  lease_expires_at: string | null;
  codex_task_id: string | null;
  codex_task_url: string | null;
  last_heartbeat_at: string | null;
  completion_summary: string | null;
  error_code: string | null;
  error_message: string | null;
  idempotency_key: string;
  request_hash: string;
  created_at: string;
  updated_at: string;
}

interface AgentRunMutationRow extends SqlRow {
  request_hash: string;
  response_json: string;
}

interface AgentDispatchAttemptRow extends SqlRow {
  attempt_id: string;
  run_id: string;
  dispatcher_id: string;
  status: "leased" | "submitted" | "unknown" | "failed" | "claimed";
  codex_task_id: string | null;
  codex_task_url: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentClaimTicketRow extends SqlRow {
  ticket_id: string;
  run_id: string;
  dispatch_attempt_id: string;
  ticket_digest: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface AgentRunMutationResult {
  run: AgentRun;
  eventSequence: number;
  idempotentReplay: boolean;
}

export interface AgentRunDispatchLease {
  run: AgentRun;
  dispatchAttemptId: string;
  claimTicket: string;
}

export interface AgentRunDispatchView {
  run: AgentRun;
  dispatchAttemptId: string;
}

export interface AgentRunContext {
  run: AgentRun;
  project: ProductionProject;
  checkpoint: { checkpointId: string; revision: number; label: string; createdBy: string; createdAt: string; reason?: string };
  history: ProjectHydration["history"];
  jobs: JobRecord[];
  budget: ProjectHydration["budget"];
}

export interface MutationResponse {
  project: ProductionProject;
  revision: number;
  commandId: string;
  affectedEntityIds: string[];
  staleEntityIds: string[];
  eventSequence?: number;
  idempotentReplay: boolean;
  checkpointId?: string;
}

export interface MutationAuthorization {
  deniedEntityIds?: string[];
  runId?: string;
}

export interface ProjectHydration {
  project: ProductionProject;
  history: {
    canUndo: boolean;
    canRedo: boolean;
    entries: Array<{
      entryId: string;
      commandId: string;
      reason?: string;
      actorKind: string;
      revisionBefore: number;
      revisionAfter: number;
      committedAt: string;
      affectedEntityIds: string[];
      staleEntityIds: string[];
    }>;
  };
  checkpoints: Array<{ checkpointId: string; revision: number; label: string; createdBy: string; createdAt: string; reason?: string }>;
  jobs: JobRecord[];
  budget: ReturnType<typeof BudgetSummarySchema.parse>;
  assets: PersistedAssetRecord[];
  renders: RenderRecord[];
  agentRuns: AgentRun[];
  latestEventSequence: number;
}

export interface ProjectRoomRpc {
  initialize(snapshotInput: unknown): Promise<RoomResult<ProjectHydration>>;
  getHydration(): Promise<RoomResult<ProjectHydration>>;
  applyCommand(commandInput: unknown, authorization?: MutationAuthorization): Promise<RoomResult<MutationResponse>>;
  undo(input: { commandId: string; idempotencyKey: string; baseRevision: number; actor: ProjectCommand["actor"]; deniedEntityIds?: string[] }): Promise<RoomResult<MutationResponse>>;
  redo(input: { commandId: string; idempotencyKey: string; baseRevision: number; actor: ProjectCommand["actor"]; deniedEntityIds?: string[] }): Promise<RoomResult<MutationResponse>>;
  createCheckpoint(input: { checkpointId: string; commandId: string; idempotencyKey: string; baseRevision: number; label: string; reason?: string; actor: ProjectCommand["actor"]; deniedEntityIds?: string[] }): Promise<RoomResult<MutationResponse>>;
  restoreCheckpoint(input: { checkpointId: string; commandId: string; idempotencyKey: string; baseRevision: number; reason?: string; actor: ProjectCommand["actor"]; deniedEntityIds?: string[] }): Promise<RoomResult<MutationResponse>>;
  createJob(requestInput: unknown, actorInput: unknown): Promise<RoomResult<{ job: JobRecord; eventSequence: number; idempotentReplay: boolean }>>;
  listJobs(): Promise<RoomResult<JobRecord[]>>;
  getJob(jobId: string): Promise<RoomResult<JobRecord>>;
  attachWorkflow(jobId: string, workflowId: string): Promise<RoomResult<JobRecord>>;
  transitionJob(jobId: string, transitionInput: unknown): Promise<RoomResult<{ job: JobRecord; eventSequence: number }>>;
  finalizeRenderJob(input: unknown): Promise<RoomResult<FinalizeRenderJobResult>>;
  finalizeMediaJob(input: unknown): Promise<RoomResult<FinalizeMediaJobResult>>;
  cancelJob(jobId: string): Promise<RoomResult<{ job: JobRecord; eventSequence: number }>>;
  recordAsset(recordInput: unknown): Promise<RoomResult<PersistedAssetRecord>>;
  getAssetByVersion(assetVersionId: string): Promise<RoomResult<PersistedAssetRecord>>;
  recordRender(recordInput: unknown): Promise<RoomResult<{ render: RenderRecord; eventSequence: number }>>;
  getRender(renderId: string): Promise<RoomResult<RenderRecord>>;
  createAgentRun(input: unknown, actor: ProjectCommand["actor"]): Promise<RoomResult<AgentRunMutationResult>>;
  listAgentRuns(): Promise<RoomResult<AgentRun[]>>;
  getAgentRun(runId: string): Promise<RoomResult<AgentRun>>;
  getAgentRunContext(runId: string): Promise<RoomResult<AgentRunContext>>;
  leaseNextAgentRun(dispatcherId: string, leaseSeconds: number): Promise<RoomResult<AgentRunDispatchLease | undefined>>;
  listDispatchAgentRuns(statuses: AgentRunStatus[]): Promise<RoomResult<AgentRunDispatchView[]>>;
  recordAgentDispatchResult(runId: string, dispatchAttemptId: string, input: unknown): Promise<RoomResult<AgentRunMutationResult>>;
  claimAgentRun(claims: AgentClaimTicketClaims, ticketDigest: string): Promise<RoomResult<AgentRunMutationResult>>;
  heartbeatAgentRun(runId: string, input: unknown): Promise<RoomResult<AgentRunMutationResult>>;
  finishAgentRun(runId: string, input: unknown): Promise<RoomResult<AgentRunMutationResult>>;
  cancelAgentRun(runId: string, idempotencyKey: string): Promise<RoomResult<AgentRunMutationResult>>;
}

export type ProjectRoomClient = ProjectRoomRpc & Pick<DurableObjectStub, "fetch">;

const sqlMigrations: Array<{ version: number; statements: string[] }> = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS project_state (
        project_id TEXT PRIMARY KEY,
        storage_schema_version INTEGER NOT NULL,
        project_schema_version TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS history_state (
        project_id TEXT PRIMARY KEY,
        history_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS operations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        actor_kind TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        result_revision INTEGER NOT NULL,
        command_json TEXT NOT NULL,
        inverse_json TEXT,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, command_id),
        UNIQUE(project_id, idempotency_key)
      )`,
      `CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        label TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        target_entity_ids_json TEXT NOT NULL,
        request_json TEXT NOT NULL,
        estimated_cost_usd REAL NOT NULL,
        reserved_cost_usd REAL NOT NULL,
        settled_cost_usd REAL NOT NULL DEFAULT 0,
        cost_is_estimate INTEGER NOT NULL DEFAULT 1,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_or_workflow_id TEXT,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, idempotency_key)
      )`,
      `CREATE TABLE IF NOT EXISTS budget_state (
        project_id TEXT PRIMARY KEY,
        reserved_usd REAL NOT NULL DEFAULT 0,
        settled_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS capability_spend (
        capability_key TEXT PRIMARY KEY,
        reserved_usd REAL NOT NULL DEFAULT 0,
        settled_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS asset_records (
        asset_version_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        object_key TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        duration_ms INTEGER,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS renders (
        render_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL UNIQUE,
        project_revision INTEGER NOT NULL,
        manifest_hash TEXT NOT NULL,
        manifest_object_key TEXT,
        output_object_key TEXT NOT NULL UNIQUE,
        poster_object_key TEXT,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        video_codec TEXT NOT NULL,
        audio_codec TEXT,
        pixel_format TEXT NOT NULL,
        outdated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_events_sequence ON events(sequence)",
      "CREATE INDEX IF NOT EXISTS idx_assets_asset ON asset_records(asset_id, created_at)",
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE IF NOT EXISTS agent_runs (
        run_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        denied_entity_ids_json TEXT NOT NULL,
        max_spend_usd REAL NOT NULL,
        claim_ticket_ttl_seconds INTEGER NOT NULL,
        claim_expires_at TEXT NOT NULL,
        lease_expires_at TEXT,
        codex_task_id TEXT,
        codex_task_url TEXT,
        last_heartbeat_at TEXT,
        completion_summary TEXT,
        error_code TEXT,
        error_message TEXT,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, idempotency_key)
      )`,
      `CREATE TABLE IF NOT EXISTS agent_run_claim_tickets (
        ticket_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        dispatch_attempt_id TEXT NOT NULL,
        ticket_digest TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(run_id)
      )`,
      `CREATE TABLE IF NOT EXISTS agent_run_dispatch_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        dispatcher_id TEXT NOT NULL,
        status TEXT NOT NULL,
        codex_task_id TEXT,
        codex_task_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES agent_runs(run_id)
      )`,
      `CREATE TABLE IF NOT EXISTS agent_run_mutations (
        run_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, idempotency_key),
        FOREIGN KEY(run_id) REFERENCES agent_runs(run_id)
      )`,
      "CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_agent_tickets_run ON agent_run_claim_tickets(run_id, created_at)",
      "CREATE INDEX IF NOT EXISTS idx_agent_attempts_run ON agent_run_dispatch_attempts(run_id, created_at)",
      "ALTER TABLE jobs ADD COLUMN cancel_requested_at TEXT",
      "ALTER TABLE jobs ADD COLUMN reconciliation_failures INTEGER NOT NULL DEFAULT 0",
    ],
  },
  {
    version: 3,
    statements: [
      `ALTER TABLE agent_runs ADD COLUMN stages_json TEXT NOT NULL
       DEFAULT '["treatment","script","previz","assets","edit","finish"]'`,
      "ALTER TABLE agent_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'act'",
    ],
  },
];

const commandError = (error: ProjectCommandError | { code: string; summary: string }, project: ProductionProject): RoomResult<never> => {
  const base = { code: error.code, message: error.summary };
  if (error.code === "REVISION_CONFLICT") {
    const conflict = error as Extract<ProjectCommandError, { code: "REVISION_CONFLICT" }>;
    const locked = conflict.changedEntities.filter((id) => {
      const scene = project.scenes.find((candidate) => candidate.meta.id === id);
      const asset = project.assets[id];
      return scene?.meta.locked || asset?.meta.locked;
    });
    return {
      ok: false,
      status: 409,
      error: {
        ...base,
        expectedRevision: conflict.expectedRevision,
        currentRevision: conflict.currentRevision,
        changedEntityIds: conflict.changedEntities,
        lockedEntityIds: locked,
      },
    };
  }
  if (error.code === "ENTITY_LOCKED") {
    const locked = error as Extract<ProjectCommandError, { code: "ENTITY_LOCKED" }>;
    return { ok: false, status: 423, error: { ...base, entityId: locked.entityId, lockedEntityIds: [locked.entityId] } };
  }
  if (error.code === "ENTITY_NOT_FOUND") return { ok: false, status: 404, error: { ...base, entityId: (error as { entityId: string }).entityId } };
  if (error.code === "ACTOR_NOT_AUTHORIZED") return { ok: false, status: 403, error: base };
  if (error.code === "HISTORY_EMPTY") return { ok: false, status: 409, error: base };
  return { ok: false, status: 422, error: { ...base, issues: "issues" in error ? error.issues : undefined } };
};

const mutationAuthorizationError = (
  before: ProductionProject,
  after: ProductionProject,
  deniedEntityIds: string[] | undefined,
): RoomResult<never> | undefined => {
  const denied = deniedProjectMutationEntities(before, after, deniedEntityIds ?? []);
  if (!denied.length) return undefined;
  return {
    ok: false,
    status: 403,
    error: {
      code: "CAPABILITY_ENTITY_DENIED",
      message: "Capability denies one or more entities changed by this mutation",
      deniedEntityIds: denied,
    },
  };
};

const rowToJob = (row: JobRow): JobRecord =>
  JobRecordSchema.parse({
    jobId: row.job_id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    jobType: row.job_type,
    status: row.status,
    actor: parseJson(row.actor_json),
    baseRevision: row.base_revision,
    targetEntityIds: parseJson(row.target_entity_ids_json),
    request: parseJson(row.request_json),
    estimatedCostUsd: row.estimated_cost_usd,
    reservedCostUsd: row.reserved_cost_usd,
    settledCostUsd: row.settled_cost_usd,
    costIsEstimate: Boolean(row.cost_is_estimate),
    attempt: row.attempt,
    workflowId: row.lease_or_workflow_id ?? undefined,
    output: row.result_json ? parseJson(row.result_json) : undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const rowToAsset = (row: AssetRow): PersistedAssetRecord =>
  PersistedAssetRecordSchema.parse({
    assetId: row.asset_id,
    assetVersionId: row.asset_version_id,
    projectId: row.project_id,
    kind: row.kind,
    objectKey: row.object_key,
    sha256: row.sha256,
    mimeType: row.mime_type,
    byteLength: row.byte_length,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    provenance: parseJson(row.provenance_json),
    createdAt: row.created_at,
  });

const rowToRender = (row: RenderRow): RenderRecord =>
  RenderRecordSchema.parse({
    renderId: row.render_id,
    projectId: row.project_id,
    jobId: row.job_id,
    projectRevision: row.project_revision,
    manifestHash: row.manifest_hash,
    manifestObjectKey: row.manifest_object_key ?? undefined,
    outputObjectKey: row.output_object_key,
    posterObjectKey: row.poster_object_key ?? undefined,
    sha256: row.sha256,
    byteLength: row.byte_length,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec ?? undefined,
    pixelFormat: row.pixel_format,
    outdated: Boolean(row.outdated),
    createdAt: row.created_at,
  });

const rowToAgentRun = (row: AgentRunRow): AgentRun =>
  AgentRunSchema.parse({
    id: row.run_id,
    projectId: row.project_id,
    checkpointId: row.checkpoint_id,
    baseRevision: row.base_revision,
    role: row.role,
    stages: parseJson(row.stages_json),
    mode: row.mode,
    status: row.status,
    scopes: parseJson(row.scopes_json),
    deniedEntityIds: parseJson(row.denied_entity_ids_json),
    maxSpendUsd: row.max_spend_usd,
    claimExpiresAt: row.claim_expires_at,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    codexTaskId: row.codex_task_id ?? undefined,
    codexTaskUrl: row.codex_task_url ?? undefined,
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    completionSummary: row.completion_summary ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class ProjectRoom extends DurableObject<Env> {
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private readonly bindings: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      await this.scheduleReconciliation();
    });
  }

  private migrate() {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`);
      const applied = new Set(
        this.ctx.storage.sql.exec<{ version: number }>("SELECT version FROM _sql_schema_migrations").toArray().map((row) => row.version),
      );
      for (const migration of sqlMigrations) {
        if (applied.has(migration.version)) continue;
        for (const statement of migration.statements) this.ctx.storage.sql.exec(statement);
        this.ctx.storage.sql.exec(
          "INSERT INTO _sql_schema_migrations(version, applied_at) VALUES (?, ?)",
          migration.version,
          new Date().toISOString(),
        );
      }
    });
  }

  private loadProject(): ProductionProject | undefined {
    const row = this.ctx.storage.sql.exec<StoredProjectRow>("SELECT snapshot_json, revision FROM project_state LIMIT 1").toArray()[0];
    return row ? ProductionProjectSchema.parse(parseJson(row.snapshot_json)) : undefined;
  }

  private requireProject(): ProductionProject {
    const project = this.loadProject();
    if (!project) throw new Error("Project has not been initialized");
    return project;
  }

  private loadHistory(projectId: string): ProjectHistory {
    const row = this.ctx.storage.sql
      .exec<StoredHistoryRow>("SELECT history_json FROM history_state WHERE project_id = ?", projectId)
      .toArray()[0];
    return row ? ProjectHistorySchema.parse(parseJson(row.history_json)) : createProjectHistory(projectId);
  }

  private saveProject(project: ProductionProject, history: ProjectHistory, timestamp: string) {
    this.ctx.storage.sql.exec(
      `INSERT INTO project_state(project_id, storage_schema_version, project_schema_version, revision, snapshot_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET storage_schema_version=excluded.storage_schema_version,
       project_schema_version=excluded.project_schema_version, revision=excluded.revision,
       snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at`,
      project.projectId,
      STORAGE_SCHEMA_VERSION,
      project.schemaVersion,
      project.revision,
      stableJson(project),
      timestamp,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO history_state(project_id, history_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET history_json=excluded.history_json, updated_at=excluded.updated_at`,
      project.projectId,
      stableJson(history),
      timestamp,
    );
  }

  private appendEvent(projectId: string, type: ProjectEventType, payload: Omit<ProjectEvent, "sequence" | "projectId" | "type" | "createdAt">, timestamp: string): ProjectEvent {
    const row = this.ctx.storage.sql
      .exec<{ sequence: number }>(
        "INSERT INTO events(project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?) RETURNING sequence",
        projectId,
        type,
        stableJson(payload),
        timestamp,
      )
      .one();
    return ProjectEventSchema.parse({ sequence: row.sequence, projectId, type, createdAt: timestamp, ...payload });
  }

  private publish(events: ProjectEvent[]) {
    for (const event of events) {
      const frame = encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      for (const controller of [...this.subscribers]) {
        try {
          controller.enqueue(frame);
        } catch {
          this.subscribers.delete(controller);
        }
      }
    }
  }

  private syncSucceededMediaOutputFlags(project: ProductionProject, timestamp: string) {
    const rows = this.ctx.storage.sql
      .exec<Pick<JobRow, "job_id" | "result_json">>(
        `SELECT job_id, result_json FROM jobs
         WHERE status = 'succeeded' AND job_type IN ('image.generate', 'speech.generate') AND result_json IS NOT NULL`,
      )
      .toArray();
    for (const row of rows) {
      const parsed = JobOutputSchema.safeParse(parseJson(row.result_json!));
      if (!parsed.success || !parsed.data.assetId || !parsed.data.assetVersionId) continue;
      const graphAsset = project.assets[parsed.data.assetId];
      const version = graphAsset?.versions.find((candidate) => candidate.id === parsed.data.assetVersionId);
      const attached = graphAsset?.currentVersionId === parsed.data.assetVersionId && version !== undefined;
      const stale = !attached || version?.status === "stale" || graphAsset?.meta.status === "stale";
      if (parsed.data.attached === attached && parsed.data.stale === stale) continue;
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET result_json = ?, updated_at = ? WHERE job_id = ?",
        stableJson({ ...parsed.data, attached, stale }),
        timestamp,
        row.job_id,
      );
    }
  }

  private changedRenderEvents(project: ProductionProject, timestamp: string): ProjectEvent[] {
    this.syncSucceededMediaOutputFlags(project, timestamp);
    const rows = this.ctx.storage.sql
      .exec<{ render_id: string; job_id: string }>(
        "SELECT render_id, job_id FROM renders WHERE outdated = 0 AND project_revision < ? ORDER BY created_at",
        project.revision,
      )
      .toArray();
    if (rows.length) {
      this.ctx.storage.sql.exec("UPDATE renders SET outdated = 1 WHERE outdated = 0 AND project_revision < ?", project.revision);
      for (const row of rows) {
        const job = this.ctx.storage.sql
          .exec<Pick<JobRow, "result_json" | "status">>("SELECT result_json, status FROM jobs WHERE job_id = ?", row.job_id)
          .toArray()[0];
        if (!job?.result_json || job.status !== "succeeded") continue;
        const output = JobOutputSchema.safeParse(parseJson(job.result_json));
        if (!output.success || output.data.stale) continue;
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET result_json = ?, updated_at = ? WHERE job_id = ?",
          stableJson({ ...output.data, stale: true }),
          timestamp,
          row.job_id,
        );
      }
    }
    return rows.map((row) =>
      this.appendEvent(project.projectId, "render.outdated", { renderId: row.render_id, currentRevision: project.revision }, timestamp),
    );
  }

  private operationReplay(projectId: string, idempotencyKey: string, requestHash: string): RoomResult<MutationResponse> | undefined {
    const row = this.ctx.storage.sql
      .exec<StoredResultRow>("SELECT request_hash, result_json FROM operations WHERE project_id = ? AND idempotency_key = ?", projectId, idempotencyKey)
      .toArray()[0];
    if (!row) return undefined;
    if (row.request_hash !== requestHash) {
      return { ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency key was already used with a different request" } };
    }
    const response = parseJson<MutationResponse>(row.result_json);
    return { ok: true, value: { ...response, idempotentReplay: true } };
  }

  async initialize(snapshotInput: unknown): Promise<RoomResult<ProjectHydration>> {
    const parsed = ProductionProjectSchema.safeParse(snapshotInput);
    if (!parsed.success) return { ok: false, status: 422, error: { code: "INVALID_PROJECT", message: parsed.error.message } };
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const existing = this.loadProject();
      if (existing && existing.projectId !== parsed.data.projectId) throw new Error("Durable Object already belongs to another project");
      if (!existing) {
        this.saveProject(parsed.data, createProjectHistory(parsed.data.projectId), now);
        this.ctx.storage.sql.exec(
          "INSERT INTO budget_state(project_id, reserved_usd, settled_usd, updated_at) VALUES (?, 0, 0, ?)",
          parsed.data.projectId,
          now,
        );
        for (const checkpoint of parsed.data.checkpoints) {
          if (checkpoint.revision !== parsed.data.revision) continue;
          this.ctx.storage.sql.exec(
            `INSERT INTO checkpoints(checkpoint_id, revision, label, snapshot_json, created_by, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            checkpoint.id,
            checkpoint.revision,
            checkpoint.label,
            stableJson(parsed.data),
            checkpoint.createdBy,
            checkpoint.reason ?? null,
            checkpoint.createdAt,
          );
        }
      }
    });
    return { ok: true, value: this.hydrateSync() };
  }

  async getHydration(): Promise<RoomResult<ProjectHydration>> {
    if (!this.loadProject()) return { ok: false, status: 404, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } };
    return { ok: true, value: this.hydrateSync() };
  }

  private budgetSync(project: ProductionProject) {
    const row = this.ctx.storage.sql
      .exec<BudgetRow>("SELECT reserved_usd, settled_usd FROM budget_state WHERE project_id = ?", project.projectId)
      .toArray()[0] ?? { reserved_usd: 0, settled_usd: 0 };
    const maxSpendUsd = project.delegation.assets.maxSpendUsd ?? 0;
    return BudgetSummarySchema.parse({
      maxSpendUsd,
      reservedUsd: row.reserved_usd,
      settledUsd: row.settled_usd,
      availableUsd: maxSpendUsd - row.reserved_usd - row.settled_usd,
    });
  }

  private hydrateSync(): ProjectHydration {
    const project = this.requireProject();
    const history = this.loadHistory(project.projectId);
    const checkpoints = this.ctx.storage.sql.exec<CheckpointRow>("SELECT * FROM checkpoints ORDER BY created_at DESC").toArray();
    const jobs = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC").toArray().map(rowToJob);
    const assets = this.ctx.storage.sql.exec<AssetRow>("SELECT * FROM asset_records ORDER BY created_at DESC").toArray().map(rowToAsset);
    const renders = this.ctx.storage.sql.exec<RenderRow>("SELECT * FROM renders ORDER BY created_at DESC").toArray().map(rowToRender);
    const agentRuns = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs ORDER BY created_at DESC").toArray().map(rowToAgentRun);
    const latest = this.ctx.storage.sql.exec<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM events").one().sequence ?? 0;
    return {
      project,
      history: {
        canUndo: history.entries.length > 0,
        canRedo: history.redoStack.length > 0,
        entries: history.entries.map((entry) => ({
          entryId: entry.entryId,
          commandId: entry.command.commandId,
          reason: entry.command.reason,
          actorKind: entry.command.actor.kind,
          revisionBefore: entry.revisionBefore,
          revisionAfter: entry.revisionAfter,
          committedAt: entry.committedAt,
          affectedEntityIds: entry.affectedEntityIds,
          staleEntityIds: entry.invalidatedEntityIds,
        })),
      },
      checkpoints: checkpoints.map((row) => ({
        checkpointId: row.checkpoint_id,
        revision: row.revision,
        label: row.label,
        createdBy: row.created_by,
        createdAt: row.created_at,
        reason: row.reason ?? undefined,
      })),
      jobs,
      budget: this.budgetSync(project),
      assets,
      renders,
      agentRuns,
      latestEventSequence: latest,
    };
  }

  private applyCommandSync(
    command: ProjectCommand,
    requestHash: string,
    now: string,
    preparedApplication?: Extract<HistoryResult, { ok: true }>,
    deniedEntityIds?: string[],
    runId?: string,
  ): { response: RoomResult<MutationResponse>; events: ProjectEvent[] } {
    const project = this.requireProject();
    const replay = this.operationReplay(project.projectId, command.idempotencyKey, requestHash);
    if (replay) return { response: replay, events: [] };
    let agentRun: AgentRun | undefined;
    if (runId) {
      const row = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).toArray()[0];
      if (!row || row.project_id !== project.projectId) {
        return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_DENIED", message: "Capability AgentRun does not belong to this project" } }, events: [] };
      }
      agentRun = rowToAgentRun(row);
      if (!(["claimed", "working"] as AgentRunStatus[]).includes(agentRun.status)) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT", message: `AgentRun ${runId} cannot write while ${agentRun.status}` } }, events: [] };
      }
      if (!agentRun.leaseExpiresAt || Date.parse(agentRun.leaseExpiresAt) <= Date.parse(now)) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_LEASE_EXPIRED", message: "AgentRun lease has expired" } }, events: [] };
      }
      if (agentRun.role !== "producer-editor") {
        return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_ROLE_DENIED", message: "Reviewer AgentRuns cannot mutate the production graph" } }, events: [] };
      }
      if ((agentRun.mode ?? "act") !== "act") {
        return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_MODE_DENIED", message: "Propose-mode AgentRuns cannot commit authoritative commands" } }, events: [] };
      }
      const deniedOperations = command.operations.map((operation) => operation.type).filter((type) => !AGENT_OPERATION_STAGES[type]);
      if (deniedOperations.length) {
        return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_OPERATION_DENIED", message: `AgentRun cannot submit ${[...new Set(deniedOperations)].join(", ")}` } }, events: [] };
      }
      const delegatedStages = new Set<AgentRunStage>(agentRun.stages ?? AGENT_RUN_STAGES);
      const deniedStages = command.operations
        .map((operation) => AGENT_OPERATION_STAGES[operation.type])
        .filter((stage): stage is AgentRunStage => Boolean(stage) && !delegatedStages.has(stage));
      if (deniedStages.length) {
        return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_STAGE_DENIED", message: `AgentRun lacks delegated ${[...new Set(deniedStages)].join(", ")} authority` } }, events: [] };
      }
    }
    const application = preparedApplication ?? applyCommandWithHistory(project, this.loadHistory(project.projectId), command);
    if (!application.ok) return { response: commandError(application.error, project), events: [] };
    const authorizationError = mutationAuthorizationError(
      project,
      application.application.previewProject ?? application.project,
      deniedEntityIds,
    );
    if (authorizationError) return { response: authorizationError, events: [] };
    const restoreOperation = command.operations.find((operation) => operation.type === "project.restore");
    const event = application.application.result.dryRun
      ? undefined
      : restoreOperation?.type === "project.restore" && restoreOperation.checkpointId
        ? this.appendEvent(project.projectId, "project.restored", {
            revision: application.project.revision,
            checkpointId: restoreOperation.checkpointId,
          }, now)
        : this.appendEvent(project.projectId, "project.committed", {
            revision: application.project.revision,
            commandId: command.commandId,
          }, now);
    const response: MutationResponse = {
      project: application.application.result.dryRun ? application.application.previewProject ?? project : application.project,
      revision: application.application.result.dryRun ? project.revision : application.project.revision,
      commandId: command.commandId,
      affectedEntityIds: application.application.result.affectedEntityIds,
      staleEntityIds: application.application.result.invalidatedEntityIds,
      eventSequence: event?.sequence,
      idempotentReplay: false,
    };
    if (!application.application.result.dryRun) this.saveProject(application.project, application.history, now);
    this.ctx.storage.sql.exec(
      `INSERT INTO operations(project_id, command_id, idempotency_key, request_hash, actor_kind, actor_id, base_revision,
       result_revision, command_json, inverse_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.projectId,
      command.commandId,
      command.idempotencyKey,
      requestHash,
      command.actor.kind,
      command.actor.sessionId,
      command.baseRevision,
      response.revision,
      stableJson(command),
      stableJson(application.application.inverseCommand),
      stableJson(response),
      now,
    );
    const events = event ? [event, ...this.changedRenderEvents(application.project, now)] : [];
    if (agentRun?.status === "claimed" && !application.application.result.dryRun) {
      this.ctx.storage.sql.exec(
        "UPDATE agent_runs SET status = 'working', last_heartbeat_at = ?, updated_at = ? WHERE run_id = ? AND status = 'claimed'",
        now,
        now,
        agentRun.id,
      );
      events.push(this.appendEvent(project.projectId, "agent_run.updated", { agentRunId: agentRun.id, agentRunStatus: "working" }, now));
    }
    return { response: { ok: true, value: response }, events };
  }

  async applyCommand(commandInput: unknown, authorization: MutationAuthorization = {}): Promise<RoomResult<MutationResponse>> {
    const parsed = ProjectCommandSchema.safeParse(commandInput);
    if (!parsed.success) return { ok: false, status: 400, error: { code: "INVALID_COMMAND", message: parsed.error.message } };
    const command = parsed.data;
    const { createdAt: _createdAt, ...hashableCommand } = command;
    const requestHash = await sha256Json(hashableCommand);
    const now = command.createdAt ?? new Date().toISOString();
    const result = this.ctx.storage.transactionSync(() =>
      this.applyCommandSync(command, requestHash, now, undefined, authorization.deniedEntityIds, authorization.runId),
    );
    this.publish(result.events);
    return result.response;
  }

  private async historyMutation(
    kind: "undo" | "redo",
    input: {
      commandId: string;
      idempotencyKey: string;
      baseRevision: number;
      actor: { kind: "director" | "codex" | "system"; sessionId: string };
      deniedEntityIds?: string[];
    },
  ): Promise<RoomResult<MutationResponse>> {
    const { deniedEntityIds, ...mutationInput } = input;
    const requestHash = await sha256Json({ kind, ...mutationInput });
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<MutationResponse>; events: ProjectEvent[] } => {
      const project = this.requireProject();
      const replay = this.operationReplay(project.projectId, input.idempotencyKey, requestHash);
      if (replay) return { response: replay, events: [] };
      if (input.baseRevision !== project.revision) {
        return {
          response: {
            ok: false,
            status: 409,
            error: { code: "REVISION_CONFLICT", message: "Project revision changed", expectedRevision: input.baseRevision, currentRevision: project.revision, changedEntityIds: [], lockedEntityIds: [] },
          },
          events: [],
        };
      }
      const history = this.loadHistory(project.projectId);
      const application: HistoryResult = kind === "undo" ? undoLastCommand(project, history, input.actor) : redoLastCommand(project, history, input.actor);
      if (!application.ok) return { response: commandError(application.error, project), events: [] };
      const authorizationError = mutationAuthorizationError(project, application.project, deniedEntityIds);
      if (authorizationError) return { response: authorizationError, events: [] };
      const event = this.appendEvent(project.projectId, "project.committed", { revision: application.project.revision, commandId: input.commandId }, now);
      const response: MutationResponse = {
        project: application.project,
        revision: application.project.revision,
        commandId: input.commandId,
        affectedEntityIds: application.application.result.affectedEntityIds,
        staleEntityIds: application.application.result.invalidatedEntityIds,
        eventSequence: event.sequence,
        idempotentReplay: false,
      };
      this.saveProject(application.project, application.history, now);
      this.ctx.storage.sql.exec(
        `INSERT INTO operations(project_id, command_id, idempotency_key, request_hash, actor_kind, actor_id, base_revision,
         result_revision, command_json, inverse_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        project.projectId,
        input.commandId,
        input.idempotencyKey,
        requestHash,
        input.actor.kind,
        input.actor.sessionId,
        input.baseRevision,
        response.revision,
        stableJson({ kind, ...mutationInput }),
        stableJson(application.application.inverseCommand),
        stableJson(response),
        now,
      );
      return { response: { ok: true, value: response }, events: [event, ...this.changedRenderEvents(application.project, now)] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  undo(input: Parameters<ProjectRoom["historyMutation"]>[1]) {
    return this.historyMutation("undo", input);
  }

  redo(input: Parameters<ProjectRoom["historyMutation"]>[1]) {
    return this.historyMutation("redo", input);
  }

  async createCheckpoint(input: { checkpointId: string; commandId: string; idempotencyKey: string; baseRevision: number; label: string; reason?: string; actor: ProjectCommand["actor"]; deniedEntityIds?: string[] }): Promise<RoomResult<MutationResponse>> {
    const { deniedEntityIds, ...mutationInput } = input;
    const requestHash = await sha256Json({ type: "checkpoint.create", ...mutationInput });
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<MutationResponse>; events: ProjectEvent[] } => {
      const current = this.requireProject();
      const replay = this.operationReplay(current.projectId, input.idempotencyKey, requestHash);
      if (replay) return { response: replay, events: [] };
      if (input.baseRevision !== current.revision) {
        return {
          response: {
            ok: false,
            status: 409,
            error: {
              code: "REVISION_CONFLICT",
              message: "Project revision changed",
              expectedRevision: input.baseRevision,
              currentRevision: current.revision,
              changedEntityIds: [],
              lockedEntityIds: [],
            },
          },
          events: [],
        };
      }
      const checkpoint = createCheckpoint(current, {
        id: input.checkpointId,
        label: input.label,
        reason: input.reason,
        actor: input.actor,
        createdAt: now,
      });
      const command = ProjectCommandSchema.parse({
        ...createCheckpointCommand(current, checkpoint, {
          actor: input.actor,
          commandId: input.commandId,
          idempotencyKey: input.idempotencyKey,
          reason: input.reason,
        }),
        createdAt: now,
      });
      const history = this.loadHistory(current.projectId);
      const application = applyCommandWithHistory(current, history, command);
      if (!application.ok) return { response: commandError(application.error, current), events: [] };
      const authorizationError = mutationAuthorizationError(current, application.project, deniedEntityIds);
      if (authorizationError) return { response: authorizationError, events: [] };
      const event = this.appendEvent(current.projectId, "project.committed", { revision: application.project.revision, commandId: command.commandId }, now);
      const response: MutationResponse = {
        project: application.project,
        revision: application.project.revision,
        commandId: command.commandId,
        affectedEntityIds: application.application.result.affectedEntityIds,
        staleEntityIds: application.application.result.invalidatedEntityIds,
        eventSequence: event.sequence,
        idempotentReplay: false,
        checkpointId: checkpoint.id,
      };
      this.ctx.storage.sql.exec(
        `INSERT INTO checkpoints(checkpoint_id, revision, label, snapshot_json, created_by, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        checkpoint.id,
        checkpoint.revision,
        checkpoint.label,
        stableJson(checkpoint.snapshot),
        checkpoint.createdBy,
        checkpoint.reason ?? null,
        checkpoint.createdAt,
      );
      this.saveProject(application.project, application.history, now);
      this.ctx.storage.sql.exec(
        `INSERT INTO operations(project_id, command_id, idempotency_key, request_hash, actor_kind, actor_id, base_revision,
         result_revision, command_json, inverse_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        current.projectId,
        command.commandId,
        command.idempotencyKey,
        requestHash,
        command.actor.kind,
        command.actor.sessionId,
        command.baseRevision,
        response.revision,
        stableJson(command),
        stableJson(application.application.inverseCommand),
        stableJson(response),
        now,
      );
      return { response: { ok: true, value: response }, events: [event, ...this.changedRenderEvents(application.project, now)] };
    });
    this.publish(result.events);
    return result.response;
  }

  async restoreCheckpoint(input: { checkpointId: string; commandId: string; idempotencyKey: string; baseRevision: number; reason?: string; actor: ProjectCommand["actor"]; deniedEntityIds?: string[] }): Promise<RoomResult<MutationResponse>> {
    const project = this.loadProject();
    if (!project) return { ok: false, status: 404, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } };
    const row = this.ctx.storage.sql
      .exec<CheckpointRow>("SELECT * FROM checkpoints WHERE checkpoint_id = ?", input.checkpointId)
      .toArray()[0];
    if (!row) return { ok: false, status: 404, error: { code: "CHECKPOINT_NOT_FOUND", message: "Checkpoint does not exist" } };
    const checkpoint: ProjectCheckpoint = ProjectCheckpointSchema.parse({
      id: row.checkpoint_id,
      label: row.label,
      projectId: project.projectId,
      revision: row.revision,
      createdAt: row.created_at,
      createdBy: row.created_by,
      reason: row.reason ?? undefined,
      snapshot: parseJson(row.snapshot_json),
    });
    const command = createRestoreCheckpointCommand(project, checkpoint, {
      actor: input.actor,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    });
    return this.applyCommand(
      { ...command, baseRevision: input.baseRevision },
      { deniedEntityIds: input.deniedEntityIds },
    );
  }

  async createJob(requestInput: unknown, actorInput: unknown): Promise<RoomResult<{ job: JobRecord; eventSequence: number; idempotentReplay: boolean }>> {
    const parsedRequest = JobCreateRequestSchema.safeParse(requestInput);
    const parsedActor = JobActorSchema.safeParse(actorInput);
    if (!parsedRequest.success) return { ok: false, status: 400, error: { code: "INVALID_JOB", message: parsedRequest.error.message } };
    if (!parsedActor.success) return { ok: false, status: 400, error: { code: "INVALID_JOB", message: parsedActor.error.message } };
    const request = parsedRequest.data;
    const actor = parsedActor.data;
    const requestHash = await sha256Json({ request, actor });
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<{ job: JobRecord; eventSequence: number; idempotentReplay: boolean }>; events: ProjectEvent[] } => {
      const project = this.requireProject();
      const existing = this.ctx.storage.sql
        .exec<JobRow & { request_hash: string }>("SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?", project.projectId, request.idempotencyKey)
        .toArray()[0];
      if (existing) {
        if (existing.request_hash !== requestHash) return { response: { ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "Idempotency key was already used with a different job request" } }, events: [] };
        return { response: { ok: true, value: { job: rowToJob(existing), eventSequence: this.latestEventSequenceSync(), idempotentReplay: true } }, events: [] };
      }
      if (request.baseRevision !== project.revision) {
        return { response: { ok: false, status: 409, error: { code: "REVISION_CONFLICT", message: "Project revision changed", expectedRevision: request.baseRevision, currentRevision: project.revision, changedEntityIds: [], lockedEntityIds: [] } }, events: [] };
      }
      let agentRun: AgentRun | undefined;
      if (actor.runId) {
        const runRow = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", actor.runId).toArray()[0];
        if (!runRow || runRow.project_id !== project.projectId) {
          return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_DENIED", message: "Capability AgentRun does not belong to this project" } }, events: [] };
        }
        agentRun = rowToAgentRun(runRow);
        if (!(["claimed", "working"] as AgentRunStatus[]).includes(agentRun.status)) {
          return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT", message: `AgentRun ${agentRun.id} cannot create jobs while ${agentRun.status}` } }, events: [] };
        }
        if (!agentRun.leaseExpiresAt || Date.parse(agentRun.leaseExpiresAt) <= Date.parse(now)) {
          return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_LEASE_EXPIRED", message: "AgentRun lease has expired" } }, events: [] };
        }
        if (agentRun.role !== "producer-editor") {
          return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_ROLE_DENIED", message: "Reviewer AgentRuns cannot create media jobs" } }, events: [] };
        }
        if ((agentRun.mode ?? "act") !== "act") {
          return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_MODE_DENIED", message: "Propose-mode AgentRuns cannot create media jobs" } }, events: [] };
        }
        const delegatedStages = new Set<AgentRunStage>(agentRun.stages ?? AGENT_RUN_STAGES);
        if (!AGENT_JOB_STAGES[request.jobType].some((stage) => delegatedStages.has(stage))) {
          return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_STAGE_DENIED", message: `AgentRun lacks a delegated stage for ${request.jobType}` } }, events: [] };
        }
        if (request.jobType === "image.generate" || request.jobType === "speech.generate") {
          const locked = lockedCanonicalEntityIds(project);
          const lockedTargets = request.targetEntityIds.filter((id) => locked.has(id));
          if (lockedTargets.length) {
            return {
              response: {
                ok: false,
                status: 423,
                error: {
                  code: "ENTITY_LOCKED",
                  message: "Run-owned media jobs cannot target director-locked entities",
                  lockedEntityIds: [...new Set(lockedTargets)],
                },
              },
              events: [],
            };
          }
        }
        if (actor.capabilityMaxSpendUsd === undefined || actor.capabilityMaxSpendUsd > agentRun.maxSpendUsd + 1e-9) {
          return { response: { ok: false, status: 403, error: { code: "AGENT_RUN_BUDGET_DENIED", message: "Capability budget does not match the durable AgentRun ceiling" } }, events: [] };
        }
      }
      const estimated = estimateJobCostUsd(request);
      const budget = this.budgetSync(project);
      if (budget.settledUsd + budget.reservedUsd + estimated > budget.maxSpendUsd + 1e-9) {
        return { response: { ok: false, status: 402, error: { code: "BUDGET_EXCEEDED", message: `Job requires $${estimated.toFixed(6)} but only $${Math.max(0, budget.availableUsd).toFixed(6)} remains` } }, events: [] };
      }
      const capabilityKey = actor.runId ? `${actor.id}:${actor.runId}` : actor.kind === "codex" ? actor.id : undefined;
      if (capabilityKey && actor.capabilityMaxSpendUsd !== undefined) {
        const spend = this.ctx.storage.sql
          .exec<CapabilitySpendRow>("SELECT reserved_usd, settled_usd FROM capability_spend WHERE capability_key = ?", capabilityKey)
          .toArray()[0] ?? { reserved_usd: 0, settled_usd: 0 };
        if (spend.reserved_usd + spend.settled_usd + estimated > actor.capabilityMaxSpendUsd + 1e-9) {
          return { response: { ok: false, status: 402, error: { code: "CAPABILITY_BUDGET_EXCEEDED", message: "Capability provider-spend ceiling would be exceeded" } }, events: [] };
        }
      }
      const jobId = request.jobId ?? `job_${crypto.randomUUID().replaceAll("-", "")}`;
      const enrichedRequest = { jobRequest: request, projectSnapshot: project, capabilityKey };
      this.ctx.storage.sql.exec(
        `INSERT INTO jobs(job_id, project_id, idempotency_key, request_hash, job_type, status, actor_json, base_revision,
         target_entity_ids_json, request_json, estimated_cost_usd, reserved_cost_usd, settled_cost_usd, cost_is_estimate,
         attempt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?)`,
        jobId,
        project.projectId,
        request.idempotencyKey,
        requestHash,
        request.jobType,
        stableJson(actor),
        request.baseRevision,
        stableJson(request.targetEntityIds),
        stableJson(enrichedRequest),
        estimated,
        estimated,
        now,
        now,
      );
      this.ctx.storage.sql.exec("UPDATE budget_state SET reserved_usd = reserved_usd + ?, updated_at = ? WHERE project_id = ?", estimated, now, project.projectId);
      if (capabilityKey) {
        this.ctx.storage.sql.exec(
          `INSERT INTO capability_spend(capability_key, reserved_usd, settled_usd, updated_at) VALUES (?, ?, 0, ?)
           ON CONFLICT(capability_key) DO UPDATE SET reserved_usd=reserved_usd + excluded.reserved_usd, updated_at=excluded.updated_at`,
          capabilityKey,
          estimated,
          now,
        );
      }
      const event = this.appendEvent(project.projectId, "job.updated", { jobId, status: "queued" }, now);
      const events = [event];
      if (agentRun?.status === "claimed") {
        this.ctx.storage.sql.exec(
          "UPDATE agent_runs SET status = 'working', last_heartbeat_at = ?, updated_at = ? WHERE run_id = ? AND status = 'claimed'",
          now,
          now,
          agentRun.id,
        );
        events.push(this.appendEvent(project.projectId, "agent_run.updated", { agentRunId: agentRun.id, agentRunStatus: "working" }, now));
      }
      const job = rowToJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId).one());
      return { response: { ok: true, value: { job, eventSequence: event.sequence, idempotentReplay: false } }, events };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  private latestEventSequenceSync() {
    return this.ctx.storage.sql.exec<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM events").one().sequence ?? 0;
  }

  private jobStatusEventSequenceSync(jobId: string, status: JobRecord["status"]) {
    return this.ctx.storage.sql
      .exec<{ sequence: number }>(
        `SELECT sequence FROM events
         WHERE event_type = 'job.updated'
           AND json_extract(payload_json, '$.jobId') = ?
           AND json_extract(payload_json, '$.status') = ?
         ORDER BY sequence DESC LIMIT 1`,
        jobId,
        status,
      )
      .toArray()[0]?.sequence ?? this.latestEventSequenceSync();
  }

  async listJobs(): Promise<RoomResult<JobRecord[]>> {
    if (!this.loadProject()) return { ok: false, status: 404, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } };
    return { ok: true, value: this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC").toArray().map(rowToJob) };
  }

  async getJob(jobId: string): Promise<RoomResult<JobRecord>> {
    const row = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId).toArray()[0];
    return row ? { ok: true, value: rowToJob(row) } : { ok: false, status: 404, error: { code: "JOB_NOT_FOUND", message: "Job does not exist" } };
  }

  async attachWorkflow(jobId: string, workflowId: string): Promise<RoomResult<JobRecord>> {
    const now = new Date().toISOString();
    const current = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId).toArray()[0];
    if (!current) return { ok: false, status: 404, error: { code: "JOB_NOT_FOUND", message: "Job does not exist" } };
    if (current.lease_or_workflow_id && current.lease_or_workflow_id !== workflowId) {
      return { ok: false, status: 409, error: { code: "WORKFLOW_ID_CONFLICT", message: "Job is already attached to a different workflow instance" } };
    }
    if (current.lease_or_workflow_id === workflowId) return { ok: true, value: rowToJob(current) };
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET lease_or_workflow_id = ?, updated_at = ? WHERE job_id = ? AND lease_or_workflow_id IS NULL",
      workflowId,
      now,
      jobId,
    );
    const result = await this.getJob(jobId);
    await this.scheduleReconciliation();
    return result;
  }

  async transitionJob(jobId: string, transitionInput: unknown): Promise<RoomResult<{ job: JobRecord; eventSequence: number }>> {
    const parsed = JobTransitionSchema.safeParse(transitionInput);
    if (!parsed.success) return { ok: false, status: 400, error: { code: "INVALID_JOB_TRANSITION", message: parsed.error.message } };
    const transition = parsed.data;
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<{ job: JobRecord; eventSequence: number }>; events: ProjectEvent[] } => {
      const project = this.requireProject();
      const row = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId).toArray()[0];
      if (!row) return { response: { ok: false, status: 404, error: { code: "JOB_NOT_FOUND", message: "Job does not exist" } }, events: [] };
      const current = rowToJob(row);
      if (current.status === transition.status) {
        const replayMatches =
          (transition.attempt === undefined || transition.attempt === current.attempt) &&
          (transition.workflowId === undefined || transition.workflowId === current.workflowId) &&
          (transition.output === undefined || stableJson(transition.output) === stableJson(current.output)) &&
          (transition.actualCostUsd === undefined || Math.abs(transition.actualCostUsd - current.settledCostUsd) <= 1e-9) &&
          (transition.costIsEstimate === undefined || transition.costIsEstimate === current.costIsEstimate) &&
          (transition.errorCode === undefined || transition.errorCode === current.errorCode) &&
          (transition.errorMessage === undefined || transition.errorMessage === current.errorMessage);
        if (!replayMatches) {
          return {
            response: {
              ok: false,
              status: 409,
              error: { code: "JOB_STATE_CONFLICT", message: `Repeated ${transition.status} transition does not match the durable job state` },
            },
            events: [],
          };
        }
        return {
          response: { ok: true, value: { job: current, eventSequence: this.jobStatusEventSequenceSync(jobId, current.status) } },
          events: [],
        };
      }
      if (terminalJobStatuses.has(current.status)) {
        return {
          response: {
            ok: false,
            status: 409,
            error: { code: "JOB_STATE_CONFLICT", message: `Terminal job ${jobId} cannot transition from ${current.status} to ${transition.status}` },
          },
          events: [],
        };
      }
      if (!transition.expectedStatuses.includes(current.status)) {
        return { response: { ok: false, status: 409, error: { code: "JOB_STATE_CONFLICT", message: `Job is ${current.status}, not ${transition.expectedStatuses.join(" or ")}` } }, events: [] };
      }
      let settled = current.settledCostUsd;
      let reserved = current.reservedCostUsd;
      const becomingTerminal = terminalJobStatuses.has(transition.status);
      if (becomingTerminal) {
        settled = Math.max(0, transition.actualCostUsd ?? (transition.status === "succeeded" ? current.estimatedCostUsd : 0));
        this.ctx.storage.sql.exec(
          "UPDATE budget_state SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE project_id = ?",
          reserved,
          settled,
          now,
          project.projectId,
        );
        const request = current.request as { capabilityKey?: string };
        if (request.capabilityKey) {
          this.ctx.storage.sql.exec(
            "UPDATE capability_spend SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE capability_key = ?",
            reserved,
            settled,
            now,
            request.capabilityKey,
          );
        }
        reserved = 0;
      }
      const nextAttempt = transition.attempt ?? (transition.status === "running" ? current.attempt + 1 : current.attempt);
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET status=?, attempt=?, lease_or_workflow_id=COALESCE(?, lease_or_workflow_id), result_json=COALESCE(?, result_json),
         reserved_cost_usd=?, settled_cost_usd=?, cost_is_estimate=?, error_code=?, error_message=?, updated_at=? WHERE job_id=?`,
        transition.status,
        nextAttempt,
        transition.workflowId ?? null,
        transition.output ? stableJson(transition.output) : null,
        reserved,
        settled,
        transition.costIsEstimate === false ? 0 : current.costIsEstimate ? 1 : 0,
        transition.errorCode ?? null,
        transition.errorMessage ?? null,
        now,
        jobId,
      );
      if (transition.status === "cancel_requested") {
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?), reconciliation_failures = 0 WHERE job_id = ?",
          now,
          jobId,
        );
      }
      const event = this.appendEvent(project.projectId, "job.updated", { jobId, status: transition.status }, now);
      const job = rowToJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", jobId).one());
      return { response: { ok: true, value: { job, eventSequence: event.sequence } }, events: [event] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async finalizeMediaJob(inputValue: unknown): Promise<RoomResult<FinalizeMediaJobResult>> {
    const parsed = FinalizeMediaJobInputSchema.safeParse(inputValue);
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "INVALID_MEDIA_FINALIZATION",
          message: parsed.error.message,
          issues: parsed.error.issues,
        },
      };
    }
    const input = parsed.data;
    let commandRequestHash: string | undefined;
    if (input.command) {
      const { createdAt: _createdAt, ...hashableCommand } = input.command;
      commandRequestHash = await sha256Json(hashableCommand);
    }
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<FinalizeMediaJobResult>; events: ProjectEvent[] } => {
      const project = this.loadProject();
      if (!project) {
        return { response: { ok: false, status: 404, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } }, events: [] };
      }
      const jobRow = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", input.jobId).toArray()[0];
      if (!jobRow) {
        return { response: { ok: false, status: 404, error: { code: "JOB_NOT_FOUND", message: "Job does not exist" } }, events: [] };
      }
      const current = rowToJob(jobRow);
      if (current.projectId !== project.projectId || input.asset.projectId !== project.projectId) {
        return {
          response: { ok: false, status: 409, error: { code: "FINALIZE_RECORD_MISMATCH", message: "Media finalization records do not belong to this project" } },
          events: [],
        };
      }
      if (current.jobType !== "image.generate" && current.jobType !== "speech.generate") {
        return {
          response: { ok: false, status: 409, error: { code: "JOB_TYPE_CONFLICT", message: `Job ${input.jobId} is not an image or speech job` } },
          events: [],
        };
      }
      const expectedKind = current.jobType === "image.generate" ? "image" : "audio";
      if (input.asset.kind !== expectedKind) {
        return {
          response: { ok: false, status: 409, error: { code: "FINALIZE_RECORD_MISMATCH", message: `${current.jobType} requires a ${expectedKind} asset record` } },
          events: [],
        };
      }
      const enrichedRequest = current.request as { jobRequest?: { request?: { assetId?: string } } };
      const requestedAssetId = enrichedRequest.jobRequest?.request?.assetId;
      if (requestedAssetId && requestedAssetId !== input.asset.assetId) {
        return {
          response: { ok: false, status: 409, error: { code: "FINALIZE_RECORD_MISMATCH", message: "Finalized asset does not match the job request" } },
          events: [],
        };
      }
      if (input.output.projectRevision !== current.baseRevision) {
        return {
          response: {
            ok: false,
            status: 409,
            error: {
              code: "FINALIZE_RECORD_MISMATCH",
              message: "Media output revision does not match the job base revision",
              expectedRevision: current.baseRevision,
              currentRevision: input.output.projectRevision,
            },
          },
          events: [],
        };
      }
      if (input.asset.createdAt !== current.createdAt || (input.command && input.command.createdAt !== current.createdAt)) {
        return {
          response: {
            ok: false,
            status: 409,
            error: { code: "NONDETERMINISTIC_FINALIZATION", message: "Asset, command, and job timestamps must use the job creation timestamp" },
          },
          events: [],
        };
      }
      const assetRow = this.ctx.storage.sql
        .exec<AssetRow>("SELECT * FROM asset_records WHERE asset_version_id = ?", input.asset.assetVersionId)
        .toArray()[0];
      const asset = assetRow ? rowToAsset(assetRow) : input.asset;
      if (assetRow && stableJson(asset) !== stableJson(input.asset)) {
        return {
          response: { ok: false, status: 409, error: { code: "ASSET_VERSION_IMMUTABLE", message: "Media asset version already exists with different immutable data" } },
          events: [],
        };
      }

      const cancelledOutput = JobOutputSchema.parse({ ...input.output, attached: false, stale: true });
      const settledCostUsd = Math.max(0, input.actualCostUsd ?? current.estimatedCostUsd);
      if (current.status === "cancelled") {
        const replayMatches =
          Boolean(assetRow) &&
          current.reservedCostUsd === 0 &&
          Math.abs(current.settledCostUsd - settledCostUsd) <= 1e-9 &&
          current.costIsEstimate === input.costIsEstimate &&
          current.output !== undefined &&
          stableJson(current.output) === stableJson(cancelledOutput);
        if (!replayMatches) {
          return {
            response: { ok: false, status: 409, error: { code: "JOB_STATE_CONFLICT", message: `Terminal job ${input.jobId} cannot finalize from cancelled` } },
            events: [],
          };
        }
        return {
          response: {
            ok: true,
            value: {
              job: current,
              asset,
              eventSequence: this.jobStatusEventSequenceSync(input.jobId, "cancelled"),
              idempotentReplay: true,
            },
          },
          events: [],
        };
      }
      if (current.status === "cancel_requested") {
        const events: ProjectEvent[] = [];
        if (!assetRow) {
          this.ctx.storage.sql.exec(
            `INSERT INTO asset_records(asset_id, asset_version_id, project_id, kind, object_key, sha256, mime_type, byte_length,
             width, height, duration_ms, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            input.asset.assetId,
            input.asset.assetVersionId,
            input.asset.projectId,
            input.asset.kind,
            input.asset.objectKey,
            input.asset.sha256,
            input.asset.mimeType,
            input.asset.byteLength,
            input.asset.width ?? null,
            input.asset.height ?? null,
            input.asset.durationMs ?? null,
            stableJson(input.asset.provenance),
            input.asset.createdAt,
          );
          events.push(this.appendEvent(project.projectId, "asset.created", { assetVersionId: input.asset.assetVersionId }, input.asset.createdAt));
        }
        this.ctx.storage.sql.exec(
          "UPDATE budget_state SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE project_id = ?",
          current.reservedCostUsd,
          settledCostUsd,
          now,
          project.projectId,
        );
        const request = current.request as { capabilityKey?: string };
        if (request.capabilityKey) {
          this.ctx.storage.sql.exec(
            "UPDATE capability_spend SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE capability_key = ?",
            current.reservedCostUsd,
            settledCostUsd,
            now,
            request.capabilityKey,
          );
        }
        this.ctx.storage.sql.exec(
          `UPDATE jobs SET status='cancelled', result_json=?, reserved_cost_usd=0, settled_cost_usd=?, cost_is_estimate=?,
           error_code='CANCELLED', error_message='Cancellation requested after provider output completed', updated_at=? WHERE job_id=?`,
          stableJson(cancelledOutput),
          settledCostUsd,
          input.costIsEstimate ? 1 : 0,
          now,
          input.jobId,
        );
        const jobEvent = this.appendEvent(project.projectId, "job.updated", { jobId: input.jobId, status: "cancelled" }, now);
        events.push(jobEvent);
        const job = rowToJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", input.jobId).one());
        return {
          response: {
            ok: true,
            value: { job, asset, eventSequence: jobEvent.sequence, idempotentReplay: false },
          },
          events,
        };
      }
      if (current.status === "failed") {
        return {
          response: { ok: false, status: 409, error: { code: "JOB_STATE_CONFLICT", message: `Terminal job ${input.jobId} cannot finalize from failed` } },
          events: [],
        };
      }
      if (
        current.status !== "succeeded" &&
        ((current.status !== "running" && current.status !== "waiting_external") || !input.expectedStatuses.includes(current.status))
      ) {
        return {
          response: {
            ok: false,
            status: 409,
            error: { code: "JOB_STATE_CONFLICT", message: `Job is ${current.status}, not ${input.expectedStatuses.join(" or ")}` },
          },
          events: [],
        };
      }

      let commandResult: MutationResponse | undefined;
      let preparedApplication: Extract<HistoryResult, { ok: true }> | undefined;
      let effectiveProject = project;
      if (input.command) {
        const replay = this.operationReplay(project.projectId, input.command.idempotencyKey, commandRequestHash!);
        if (replay) {
          if (!replay.ok) return { response: replay, events: [] };
          commandResult = replay.value;
        } else if (current.status === "succeeded") {
          return {
            response: {
              ok: false,
              status: 409,
              error: { code: "FINALIZE_REPLAY_MISMATCH", message: "Succeeded media job is missing its supplied command operation" },
            },
            events: [],
          };
        } else {
          const application = applyCommandWithHistory(project, this.loadHistory(project.projectId), input.command);
          if (!application.ok) return { response: commandError(application.error, project), events: [] };
          preparedApplication = application;
          effectiveProject = application.project;
        }
      }

      const graphAsset = effectiveProject.assets[input.asset.assetId];
      const graphVersion = graphAsset?.versions.find((version) => version.id === input.asset.assetVersionId);
      const attached = graphAsset?.currentVersionId === input.asset.assetVersionId && graphVersion !== undefined;
      const stale = !attached || graphVersion?.status === "stale" || graphAsset?.meta.status === "stale";
      if (attached && !input.command) {
        return {
          response: {
            ok: false,
            status: 409,
            error: { code: "FINALIZE_COMMAND_REQUIRED", message: "An attached media finalization must supply its exact system command" },
          },
          events: [],
        };
      }
      const output = JobOutputSchema.parse({ ...input.output, attached, stale });
      if (current.status === "succeeded") {
        const replayMatches =
          Boolean(assetRow) &&
          current.reservedCostUsd === 0 &&
          Math.abs(current.settledCostUsd - settledCostUsd) <= 1e-9 &&
          current.costIsEstimate === input.costIsEstimate &&
          current.output !== undefined &&
          stableJson(current.output) === stableJson(output);
        if (!replayMatches) {
          return {
            response: {
              ok: false,
              status: 409,
              error: { code: "FINALIZE_REPLAY_MISMATCH", message: "Succeeded media job is missing or conflicts with its immutable finalization records" },
            },
            events: [],
          };
        }
        return {
          response: {
            ok: true,
            value: {
              job: current,
              asset,
              command: commandResult,
              eventSequence: this.jobStatusEventSequenceSync(input.jobId, "succeeded"),
              idempotentReplay: true,
            },
          },
          events: [],
        };
      }

      const events: ProjectEvent[] = [];
      if (input.command && preparedApplication) {
        const application = this.applyCommandSync(input.command, commandRequestHash!, input.command.createdAt!, preparedApplication);
        if (!application.response.ok) return { response: application.response, events: [] };
        commandResult = application.response.value;
        events.push(...application.events);
      }
      if (!assetRow) {
        this.ctx.storage.sql.exec(
          `INSERT INTO asset_records(asset_id, asset_version_id, project_id, kind, object_key, sha256, mime_type, byte_length,
           width, height, duration_ms, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.asset.assetId,
          input.asset.assetVersionId,
          input.asset.projectId,
          input.asset.kind,
          input.asset.objectKey,
          input.asset.sha256,
          input.asset.mimeType,
          input.asset.byteLength,
          input.asset.width ?? null,
          input.asset.height ?? null,
          input.asset.durationMs ?? null,
          stableJson(input.asset.provenance),
          input.asset.createdAt,
        );
        events.push(this.appendEvent(project.projectId, "asset.created", { assetVersionId: input.asset.assetVersionId }, input.asset.createdAt));
      }
      this.ctx.storage.sql.exec(
        "UPDATE budget_state SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE project_id = ?",
        current.reservedCostUsd,
        settledCostUsd,
        now,
        project.projectId,
      );
      const request = current.request as { capabilityKey?: string };
      if (request.capabilityKey) {
        this.ctx.storage.sql.exec(
          "UPDATE capability_spend SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE capability_key = ?",
          current.reservedCostUsd,
          settledCostUsd,
          now,
          request.capabilityKey,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET status='succeeded', result_json=?, reserved_cost_usd=0, settled_cost_usd=?, cost_is_estimate=?,
         error_code=NULL, error_message=NULL, updated_at=? WHERE job_id=?`,
        stableJson(output),
        settledCostUsd,
        input.costIsEstimate ? 1 : 0,
        now,
        input.jobId,
      );
      const jobEvent = this.appendEvent(project.projectId, "job.updated", { jobId: input.jobId, status: "succeeded" }, now);
      events.push(jobEvent);
      const job = rowToJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", input.jobId).one());
      return {
        response: {
          ok: true,
          value: {
            job,
            asset,
            command: commandResult,
            eventSequence: jobEvent.sequence,
            idempotentReplay: false,
          },
        },
        events,
      };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async finalizeRenderJob(inputValue: unknown): Promise<RoomResult<FinalizeRenderJobResult>> {
    const parsed = FinalizeRenderJobInputSchema.safeParse(inputValue);
    if (!parsed.success) {
      return {
        ok: false,
        status: 400,
        error: {
          code: "INVALID_RENDER_FINALIZATION",
          message: parsed.error.message,
          issues: parsed.error.issues,
        },
      };
    }
    const input = parsed.data;
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<FinalizeRenderJobResult>; events: ProjectEvent[] } => {
      const project = this.loadProject();
      if (!project) {
        return { response: { ok: false, status: 404, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } }, events: [] };
      }
      const jobRow = this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", input.jobId).toArray()[0];
      if (!jobRow) {
        return { response: { ok: false, status: 404, error: { code: "JOB_NOT_FOUND", message: "Job does not exist" } }, events: [] };
      }
      const current = rowToJob(jobRow);
      if (current.projectId !== project.projectId || input.render.projectId !== project.projectId) {
        return {
          response: { ok: false, status: 409, error: { code: "FINALIZE_RECORD_MISMATCH", message: "Render finalization records do not belong to this project" } },
          events: [],
        };
      }
      if (current.jobType !== "render.preview" && current.jobType !== "render.final") {
        return {
          response: { ok: false, status: 409, error: { code: "JOB_TYPE_CONFLICT", message: `Job ${input.jobId} is not a render job` } },
          events: [],
        };
      }
      if (input.render.projectRevision !== current.baseRevision) {
        return {
          response: {
            ok: false,
            status: 409,
            error: {
              code: "FINALIZE_RECORD_MISMATCH",
              message: "Render revision does not match the job base revision",
              expectedRevision: current.baseRevision,
              currentRevision: input.render.projectRevision,
            },
          },
          events: [],
        };
      }
      if (current.status === "cancel_requested") {
        return {
          response: { ok: false, status: 409, error: { code: "JOB_CANCEL_REQUESTED", message: `Job ${input.jobId} cannot succeed after cancellation was requested` } },
          events: [],
        };
      }
      if (current.status === "failed" || current.status === "cancelled") {
        return {
          response: { ok: false, status: 409, error: { code: "JOB_STATE_CONFLICT", message: `Terminal job ${input.jobId} cannot finalize from ${current.status}` } },
          events: [],
        };
      }

      const render = RenderRecordSchema.parse({
        ...input.render,
        outdated: input.render.projectRevision < project.revision,
      });
      const output = JobOutputSchema.parse({ ...input.output, stale: render.outdated });
      const settledCostUsd = Math.max(0, input.actualCostUsd ?? current.estimatedCostUsd);

      const videoRow = this.ctx.storage.sql
        .exec<AssetRow>("SELECT * FROM asset_records WHERE asset_version_id = ?", input.videoAsset.assetVersionId)
        .toArray()[0];
      const posterRow = this.ctx.storage.sql
        .exec<AssetRow>("SELECT * FROM asset_records WHERE asset_version_id = ?", input.posterAsset.assetVersionId)
        .toArray()[0];
      const renderRows = this.ctx.storage.sql
        .exec<RenderRow>(
          "SELECT * FROM renders WHERE render_id = ? OR job_id = ? OR output_object_key = ? OR poster_object_key = ?",
          render.renderId,
          input.jobId,
          render.outputObjectKey,
          render.posterObjectKey ?? null,
        )
        .toArray();
      const videoAsset = videoRow ? rowToAsset(videoRow) : input.videoAsset;
      const posterAsset = posterRow ? rowToAsset(posterRow) : input.posterAsset;
      const persistedRender = renderRows.length === 1 ? rowToRender(renderRows[0]!) : undefined;

      if (videoRow && stableJson(videoAsset) !== stableJson(input.videoAsset)) {
        return {
          response: { ok: false, status: 409, error: { code: "ASSET_VERSION_IMMUTABLE", message: "Video asset version already exists with different immutable data" } },
          events: [],
        };
      }
      if (posterRow && stableJson(posterAsset) !== stableJson(input.posterAsset)) {
        return {
          response: { ok: false, status: 409, error: { code: "ASSET_VERSION_IMMUTABLE", message: "Poster asset version already exists with different immutable data" } },
          events: [],
        };
      }
      if (renderRows.length > 0 && (renderRows.length !== 1 || !persistedRender || stableJson(persistedRender) !== stableJson(render))) {
        return {
          response: { ok: false, status: 409, error: { code: "RENDER_IMMUTABLE", message: "Render identity already references different immutable data" } },
          events: [],
        };
      }

      if (current.status === "succeeded") {
        const replayMatches =
          Boolean(videoRow) &&
          Boolean(posterRow) &&
          Boolean(persistedRender) &&
          current.reservedCostUsd === 0 &&
          Math.abs(current.settledCostUsd - settledCostUsd) <= 1e-9 &&
          current.costIsEstimate === input.costIsEstimate &&
          current.output !== undefined &&
          stableJson(current.output) === stableJson(output);
        if (!replayMatches) {
          return {
            response: {
              ok: false,
              status: 409,
              error: { code: "FINALIZE_REPLAY_MISMATCH", message: "Succeeded job is missing or conflicts with its immutable render finalization records" },
            },
            events: [],
          };
        }
        return {
          response: {
            ok: true,
            value: {
              job: current,
              videoAsset,
              posterAsset,
              render: persistedRender!,
              eventSequence: this.jobStatusEventSequenceSync(input.jobId, "succeeded"),
              idempotentReplay: true,
            },
          },
          events: [],
        };
      }
      if (
        (current.status !== "running" && current.status !== "waiting_external") ||
        !input.expectedStatuses.includes(current.status)
      ) {
        return {
          response: {
            ok: false,
            status: 409,
            error: { code: "JOB_STATE_CONFLICT", message: `Job is ${current.status}, not ${input.expectedStatuses.join(" or ")}` },
          },
          events: [],
        };
      }

      const events: ProjectEvent[] = [];
      const insertAsset = (asset: PersistedAssetRecord) => {
        this.ctx.storage.sql.exec(
          `INSERT INTO asset_records(asset_id, asset_version_id, project_id, kind, object_key, sha256, mime_type, byte_length,
           width, height, duration_ms, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          asset.assetId,
          asset.assetVersionId,
          asset.projectId,
          asset.kind,
          asset.objectKey,
          asset.sha256,
          asset.mimeType,
          asset.byteLength,
          asset.width ?? null,
          asset.height ?? null,
          asset.durationMs ?? null,
          stableJson(asset.provenance),
          asset.createdAt,
        );
        events.push(this.appendEvent(project.projectId, "asset.created", { assetVersionId: asset.assetVersionId }, asset.createdAt));
      };
      if (!videoRow) insertAsset(input.videoAsset);
      if (!posterRow) insertAsset(input.posterAsset);
      if (!persistedRender) {
        this.ctx.storage.sql.exec(
          `INSERT INTO renders(render_id, project_id, job_id, project_revision, manifest_hash, manifest_object_key, output_object_key,
           poster_object_key, sha256, byte_length, width, height, duration_ms, video_codec, audio_codec, pixel_format, outdated, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          render.renderId,
          render.projectId,
          render.jobId,
          render.projectRevision,
          render.manifestHash,
          render.manifestObjectKey ?? null,
          render.outputObjectKey,
          render.posterObjectKey ?? null,
          render.sha256,
          render.byteLength,
          render.width,
          render.height,
          render.durationMs,
          render.videoCodec,
          render.audioCodec ?? null,
          render.pixelFormat,
          render.outdated ? 1 : 0,
          render.createdAt,
        );
        events.push(this.appendEvent(project.projectId, "render.ready", { renderId: render.renderId, revision: render.projectRevision }, render.createdAt));
        if (render.outdated) {
          events.push(this.appendEvent(project.projectId, "render.outdated", { renderId: render.renderId, currentRevision: project.revision }, render.createdAt));
        }
      }

      this.ctx.storage.sql.exec(
        "UPDATE budget_state SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE project_id = ?",
        current.reservedCostUsd,
        settledCostUsd,
        now,
        project.projectId,
      );
      const request = current.request as { capabilityKey?: string };
      if (request.capabilityKey) {
        this.ctx.storage.sql.exec(
          "UPDATE capability_spend SET reserved_usd = MAX(0, reserved_usd - ?), settled_usd = settled_usd + ?, updated_at = ? WHERE capability_key = ?",
          current.reservedCostUsd,
          settledCostUsd,
          now,
          request.capabilityKey,
        );
      }
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET status='succeeded', result_json=?, reserved_cost_usd=0, settled_cost_usd=?, cost_is_estimate=?,
         error_code=NULL, error_message=NULL, updated_at=? WHERE job_id=?`,
        stableJson(output),
        settledCostUsd,
        input.costIsEstimate ? 1 : 0,
        now,
        input.jobId,
      );
      const jobEvent = this.appendEvent(project.projectId, "job.updated", { jobId: input.jobId, status: "succeeded" }, now);
      events.push(jobEvent);
      const job = rowToJob(this.ctx.storage.sql.exec<JobRow>("SELECT * FROM jobs WHERE job_id = ?", input.jobId).one());
      return {
        response: {
          ok: true,
          value: {
            job,
            videoAsset,
            posterAsset,
            render,
            eventSequence: jobEvent.sequence,
            idempotentReplay: false,
          },
        },
        events,
      };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async cancelJob(jobId: string): Promise<RoomResult<{ job: JobRecord; eventSequence: number }>> {
    const current = await this.getJob(jobId);
    if (!current.ok) return current;
    if (current.value.status === "cancelled" || current.value.status === "cancel_requested" || terminalJobStatuses.has(current.value.status)) {
      return { ok: true, value: { job: current.value, eventSequence: this.latestEventSequenceSync() } };
    }
    return this.transitionJob(jobId, { expectedStatuses: ["queued", "running", "waiting_external"], status: "cancel_requested" });
  }

  private agentMutationReplaySync(
    runId: string,
    idempotencyKey: string,
    requestHash: string,
  ): RoomResult<AgentRunMutationResult> | undefined {
    const row = this.ctx.storage.sql
      .exec<AgentRunMutationRow>(
        "SELECT request_hash, response_json FROM agent_run_mutations WHERE run_id = ? AND idempotency_key = ?",
        runId,
        idempotencyKey,
      )
      .toArray()[0];
    if (!row) return undefined;
    if (row.request_hash !== requestHash) {
      return { ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "AgentRun idempotency key was reused with a different request" } };
    }
    const response = parseJson<AgentRunMutationResult>(row.response_json);
    return { ok: true, value: { ...response, idempotentReplay: true } };
  }

  private persistAgentMutationSync(
    runId: string,
    idempotencyKey: string,
    requestHash: string,
    response: AgentRunMutationResult,
    now: string,
  ) {
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_run_mutations(run_id, idempotency_key, request_hash, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      runId,
      idempotencyKey,
      requestHash,
      stableJson(response),
      now,
    );
  }

  async createAgentRun(inputValue: unknown, actor: ProjectCommand["actor"]): Promise<RoomResult<AgentRunMutationResult>> {
    const parsed = CreateAgentRunInputSchema.safeParse(inputValue);
    if (!parsed.success) {
      return { ok: false, status: 400, error: { code: "INVALID_AGENT_RUN", message: parsed.error.message, issues: parsed.error.issues } };
    }
    const input = parsed.data;
    if (!input.runId || !input.checkpointId) {
      return { ok: false, status: 400, error: { code: "INVALID_AGENT_RUN", message: "Normalized AgentRun creation requires runId and checkpointId" } };
    }
    if (input.scopes.includes("agent:dispatch") || input.scopes.includes("asset:read")) {
      return {
        ok: false,
        status: 403,
        error: { code: "AGENT_RUN_SCOPE_DENIED", message: "Cloud AgentRuns cannot receive dispatcher authority or direct source-media access" },
      };
    }
    const requestHash = await sha256Json({ input, actor });
    const now = new Date().toISOString();
    const claimExpiresAt = new Date(Date.parse(now) + input.claimTicketTtlSeconds * 1_000).toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<AgentRunMutationResult>; events: ProjectEvent[] } => {
      const project = this.requireProject();
      const existing = this.ctx.storage.sql
        .exec<AgentRunRow>("SELECT * FROM agent_runs WHERE project_id = ? AND idempotency_key = ?", project.projectId, input.idempotencyKey)
        .toArray()[0];
      if (existing) {
        if (existing.request_hash !== requestHash) {
          return { response: { ok: false, status: 409, error: { code: "IDEMPOTENCY_KEY_REUSED", message: "AgentRun idempotency key was reused with a different request" } }, events: [] };
        }
        return {
          response: { ok: true, value: { run: rowToAgentRun(existing), eventSequence: this.latestEventSequenceSync(), idempotentReplay: true } },
          events: [],
        };
      }
      if (project.revision !== input.baseRevision) {
        return {
          response: {
            ok: false,
            status: 409,
            error: { code: "REVISION_CONFLICT", message: "Project revision changed before AgentRun creation", expectedRevision: input.baseRevision, currentRevision: project.revision },
          },
          events: [],
        };
      }
      const checkpoint = this.ctx.storage.sql
        .exec<CheckpointRow>("SELECT * FROM checkpoints WHERE checkpoint_id = ?", input.checkpointId)
        .toArray()[0];
      if (!checkpoint) {
        return { response: { ok: false, status: 404, error: { code: "CHECKPOINT_NOT_FOUND", message: "AgentRun checkpoint does not exist" } }, events: [] };
      }
      const runIdCollision = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", input.runId).toArray()[0];
      if (runIdCollision) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_ID_CONFLICT", message: "AgentRun ID already exists" } }, events: [] };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_runs(run_id, project_id, checkpoint_id, base_revision, role, stages_json, mode, status, scopes_json,
         denied_entity_ids_json, max_spend_usd, claim_ticket_ttl_seconds, claim_expires_at, idempotency_key,
         request_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.runId,
        project.projectId,
        input.checkpointId,
        input.baseRevision,
        input.role,
        stableJson(input.stages),
        input.mode,
        stableJson(input.scopes),
        stableJson(input.deniedEntityIds),
        input.maxSpendUsd,
        input.claimTicketTtlSeconds,
        claimExpiresAt,
        input.idempotencyKey,
        requestHash,
        now,
        now,
      );
      const event = this.appendEvent(project.projectId, "agent_run.updated", { agentRunId: input.runId, agentRunStatus: "created" }, now);
      const run = rowToAgentRun(this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", input.runId).one());
      return { response: { ok: true, value: { run, eventSequence: event.sequence, idempotentReplay: false } }, events: [event] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async listAgentRuns(): Promise<RoomResult<AgentRun[]>> {
    if (!this.loadProject()) return { ok: false, status: 404, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } };
    return { ok: true, value: this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs ORDER BY created_at DESC").toArray().map(rowToAgentRun) };
  }

  async getAgentRun(runId: string): Promise<RoomResult<AgentRun>> {
    const row = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).toArray()[0];
    return row
      ? { ok: true, value: rowToAgentRun(row) }
      : { ok: false, status: 404, error: { code: "AGENT_RUN_NOT_FOUND", message: "AgentRun does not exist" } };
  }

  async getAgentRunContext(runId: string): Promise<RoomResult<AgentRunContext>> {
    const runResult = await this.getAgentRun(runId);
    if (!runResult.ok) return runResult;
    const hydration = this.hydrateSync();
    const checkpoint = hydration.checkpoints.find((candidate) => candidate.checkpointId === runResult.value.checkpointId);
    if (!checkpoint) return { ok: false, status: 409, error: { code: "AGENT_RUN_CHECKPOINT_MISSING", message: "AgentRun checkpoint is missing" } };
    return {
      ok: true,
      value: {
        run: runResult.value,
        project: hydration.project,
        checkpoint,
        history: { ...hydration.history, entries: hydration.history.entries.slice(-40) },
        jobs: hydration.jobs.filter((job) => job.actor.runId === runId),
        budget: hydration.budget,
      },
    };
  }

  async leaseNextAgentRun(dispatcherId: string, leaseSeconds: number): Promise<RoomResult<AgentRunDispatchLease | undefined>> {
    if (!/^[A-Za-z][A-Za-z0-9:_-]{2,127}$/u.test(dispatcherId)) {
      return { ok: false, status: 400, error: { code: "INVALID_DISPATCHER_ID", message: "Dispatcher ID is invalid" } };
    }
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 1_800) {
      return { ok: false, status: 400, error: { code: "INVALID_DISPATCH_LEASE", message: "Dispatch lease must be 60 to 1800 seconds" } };
    }
    const secret = this.bindings.PRAXIS_AGENT_CLAIM_SIGNING_SECRET;
    if (!secret) return { ok: false, status: 503, error: { code: "AGENT_CLAIM_NOT_CONFIGURED", message: "AgentRun claim signing is not configured" } };
    const candidate = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE status = 'created' ORDER BY created_at LIMIT 1").toArray()[0];
    if (!candidate) return { ok: true, value: undefined };

    const now = new Date().toISOString();
    const claimTtl = Math.min(candidate.claim_ticket_ttl_seconds, leaseSeconds);
    const expiresAt = new Date(Date.parse(now) + claimTtl * 1_000).toISOString();
    const ticketId = `ticket_${crypto.randomUUID().replaceAll("-", "")}`;
    const dispatchAttemptId = `dispatch_${crypto.randomUUID().replaceAll("-", "")}`;
    const claims: AgentClaimTicketClaims = {
      version: 1,
      ticketId,
      projectId: candidate.project_id,
      runId: candidate.run_id,
      expiresAt,
    };
    const claimTicket = await mintAgentClaimTicket(claims, secret);
    const digest = await claimTicketDigest(claimTicket);
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<AgentRunDispatchLease | undefined>; events: ProjectEvent[] } => {
      const currentRow = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", candidate.run_id).toArray()[0];
      if (!currentRow || currentRow.status !== "created") return { response: { ok: true, value: undefined }, events: [] };
      this.ctx.storage.sql.exec(
        "UPDATE agent_runs SET status = 'dispatching', claim_expires_at = ?, updated_at = ? WHERE run_id = ? AND status = 'created'",
        expiresAt,
        now,
        candidate.run_id,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_run_dispatch_attempts(attempt_id, run_id, dispatcher_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'leased', ?, ?)`,
        dispatchAttemptId,
        candidate.run_id,
        dispatcherId,
        now,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO agent_run_claim_tickets(ticket_id, run_id, dispatch_attempt_id, ticket_digest, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ticketId,
        candidate.run_id,
        dispatchAttemptId,
        digest,
        expiresAt,
        now,
      );
      const event = this.appendEvent(candidate.project_id, "agent_run.updated", { agentRunId: candidate.run_id, agentRunStatus: "dispatching" }, now);
      const run = rowToAgentRun(this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", candidate.run_id).one());
      return { response: { ok: true, value: { run, dispatchAttemptId, claimTicket } }, events: [event] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async listDispatchAgentRuns(statusValues: AgentRunStatus[]): Promise<RoomResult<AgentRunDispatchView[]>> {
    const statuses = [...new Set(statusValues)].map((status) => AgentRunStatusSchema.parse(status));
    if (!statuses.length || statuses.includes("created")) {
      return { ok: false, status: 400, error: { code: "INVALID_AGENT_RUN_STATUS", message: "Dispatcher reconciliation requires already-leased AgentRun statuses" } };
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.ctx.storage.sql.exec<AgentRunRow>(`SELECT * FROM agent_runs WHERE status IN (${placeholders}) ORDER BY created_at`, ...statuses).toArray();
    const views = rows.flatMap((row): AgentRunDispatchView[] => {
      const attempt = this.ctx.storage.sql
        .exec<AgentDispatchAttemptRow>("SELECT * FROM agent_run_dispatch_attempts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1", row.run_id)
        .toArray()[0];
      return attempt ? [{ run: rowToAgentRun(row), dispatchAttemptId: attempt.attempt_id }] : [];
    });
    return { ok: true, value: views };
  }

  async recordAgentDispatchResult(
    runId: string,
    dispatchAttemptId: string,
    inputValue: unknown,
  ): Promise<RoomResult<AgentRunMutationResult>> {
    const parsed = AgentRunDispatchInputSchema.safeParse(inputValue);
    if (!parsed.success || parsed.data.action === "begin") {
      return { ok: false, status: 400, error: { code: "INVALID_AGENT_DISPATCH_RESULT", message: parsed.success ? "Dispatch begin is performed by the lease endpoint" : parsed.error.message } };
    }
    const input = parsed.data;
    const requestHash = await sha256Json({ dispatchAttemptId, input });
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<AgentRunMutationResult>; events: ProjectEvent[] } => {
      const replay = this.agentMutationReplaySync(runId, input.idempotencyKey, requestHash);
      if (replay) return { response: replay, events: [] };
      const row = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).toArray()[0];
      const attempt = this.ctx.storage.sql.exec<AgentDispatchAttemptRow>("SELECT * FROM agent_run_dispatch_attempts WHERE attempt_id = ? AND run_id = ?", dispatchAttemptId, runId).toArray()[0];
      if (!row || !attempt) return { response: { ok: false, status: 404, error: { code: "AGENT_DISPATCH_NOT_FOUND", message: "AgentRun dispatch attempt does not exist" } }, events: [] };
      const current = rowToAgentRun(row);
      let nextStatus = current.status;
      let attemptStatus: AgentDispatchAttemptRow["status"] = attempt.status;
      if (input.action === "record_task") {
        if (current.codexTaskId && current.codexTaskId !== input.codexTaskId) {
          return { response: { ok: false, status: 409, error: { code: "CODEX_TASK_ID_CONFLICT", message: "AgentRun already records a different Codex task" } }, events: [] };
        }
        if (current.status === "dispatch_unknown") nextStatus = "dispatching";
        attemptStatus =
          attempt.status === "claimed" ||
          current.status === "claimed" ||
          current.status === "working" ||
          current.status === "waiting_on_jobs" ||
          current.status === "completed"
            ? "claimed"
            : "submitted";
        this.ctx.storage.sql.exec(
          `UPDATE agent_runs SET status = ?, codex_task_id = ?, codex_task_url = COALESCE(?, codex_task_url),
           error_code = CASE WHEN ? THEN NULL ELSE error_code END,
           error_message = CASE WHEN ? THEN NULL ELSE error_message END,
           updated_at = ? WHERE run_id = ?`,
          nextStatus,
          input.codexTaskId,
          input.codexTaskUrl ?? null,
          current.status === "dispatch_unknown" ? 1 : 0,
          current.status === "dispatch_unknown" ? 1 : 0,
          now,
          runId,
        );
        this.ctx.storage.sql.exec(
          "UPDATE agent_run_dispatch_attempts SET status = ?, codex_task_id = ?, codex_task_url = COALESCE(?, codex_task_url), updated_at = ? WHERE attempt_id = ?",
          attemptStatus,
          input.codexTaskId,
          input.codexTaskUrl ?? null,
          now,
          dispatchAttemptId,
        );
      } else if (input.action === "mark_unknown") {
        if (
          (current.status !== "dispatching" && current.status !== "dispatch_unknown") ||
          (attempt.status !== "leased" && attempt.status !== "unknown") ||
          (current.status === "dispatch_unknown" && attempt.status === "unknown")
        ) {
          // A negative task-list observation cannot downgrade a run that has
          // already claimed, completed, or positively recorded its task. It is
          // also a no-op for an already-unknown dispatch attempt.
          return {
            response: {
              ok: true,
              value: {
                run: current,
                eventSequence: this.latestEventSequenceSync(),
                idempotentReplay: true,
              },
            },
            events: [],
          };
        }
        if (current.status === "dispatching") {
          assertAgentRunTransition(current.status, "dispatch_unknown");
          nextStatus = "dispatch_unknown";
          this.ctx.storage.sql.exec(
            "UPDATE agent_runs SET status = 'dispatch_unknown', error_code = ?, error_message = ?, updated_at = ? WHERE run_id = ? AND status = 'dispatching'",
            input.errorCode ?? "CODEX_DISPATCH_UNKNOWN",
            input.errorMessage ?? "Codex task identity could not be determined",
            now,
            runId,
          );
        }
        this.ctx.storage.sql.exec("UPDATE agent_run_dispatch_attempts SET status = 'unknown', updated_at = ? WHERE attempt_id = ?", now, dispatchAttemptId);
      } else {
        if (current.status !== "dispatching" && current.status !== "dispatch_unknown") {
          return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT", message: `Dispatcher cannot fail AgentRun while ${current.status}` } }, events: [] };
        }
        assertAgentRunTransition(current.status, "failed");
        nextStatus = "failed";
        this.ctx.storage.sql.exec(
          "UPDATE agent_runs SET status = 'failed', error_code = ?, error_message = ?, lease_expires_at = NULL, updated_at = ? WHERE run_id = ?",
          input.errorCode,
          input.errorMessage,
          now,
          runId,
        );
        this.ctx.storage.sql.exec("UPDATE agent_run_dispatch_attempts SET status = 'failed', updated_at = ? WHERE attempt_id = ?", now, dispatchAttemptId);
      }
      const event = this.appendEvent(current.projectId, "agent_run.updated", { agentRunId: runId, agentRunStatus: nextStatus }, now);
      const run = rowToAgentRun(this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).one());
      const response = { run, eventSequence: event.sequence, idempotentReplay: false };
      this.persistAgentMutationSync(runId, input.idempotencyKey, requestHash, response, now);
      return { response: { ok: true, value: response }, events: [event] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async claimAgentRun(claims: AgentClaimTicketClaims, digest: string): Promise<RoomResult<AgentRunMutationResult>> {
    const now = new Date().toISOString();
    const leaseSecondsValue = Number(this.bindings.PRAXIS_AGENT_LEASE_SECONDS ?? 1_800);
    const leaseSeconds = Number.isSafeInteger(leaseSecondsValue) ? Math.min(3_600, Math.max(300, leaseSecondsValue)) : 1_800;
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<AgentRunMutationResult>; events: ProjectEvent[] } => {
      const row = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", claims.runId).toArray()[0];
      const ticket = this.ctx.storage.sql.exec<AgentClaimTicketRow>("SELECT * FROM agent_run_claim_tickets WHERE ticket_id = ?", claims.ticketId).toArray()[0];
      if (!row || row.project_id !== claims.projectId || !ticket || ticket.run_id !== claims.runId) {
        return { response: { ok: false, status: 404, error: { code: "AGENT_CLAIM_NOT_FOUND", message: "AgentRun claim ticket does not exist" } }, events: [] };
      }
      if (ticket.ticket_digest !== digest || ticket.consumed_at || ticket.expires_at !== claims.expiresAt || Date.parse(ticket.expires_at) <= Date.parse(now)) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_CLAIM_INVALID", message: "AgentRun claim ticket is invalid, expired, or already consumed" } }, events: [] };
      }
      const current = rowToAgentRun(row);
      if (current.status !== "dispatching" && current.status !== "dispatch_unknown") {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT", message: `AgentRun cannot be claimed while ${current.status}` } }, events: [] };
      }
      assertAgentRunTransition(current.status, "claimed");
      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = 'claimed', lease_expires_at = ?, last_heartbeat_at = ?,
         error_code = NULL, error_message = NULL, updated_at = ? WHERE run_id = ?`,
        leaseExpiresAt,
        now,
        now,
        claims.runId,
      );
      this.ctx.storage.sql.exec("UPDATE agent_run_claim_tickets SET consumed_at = ? WHERE ticket_id = ? AND consumed_at IS NULL", now, claims.ticketId);
      this.ctx.storage.sql.exec("UPDATE agent_run_dispatch_attempts SET status = 'claimed', updated_at = ? WHERE attempt_id = ?", now, ticket.dispatch_attempt_id);
      const event = this.appendEvent(claims.projectId, "agent_run.updated", { agentRunId: claims.runId, agentRunStatus: "claimed" }, now);
      const run = rowToAgentRun(this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", claims.runId).one());
      return { response: { ok: true, value: { run, eventSequence: event.sequence, idempotentReplay: false } }, events: [event] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async heartbeatAgentRun(runId: string, inputValue: unknown): Promise<RoomResult<AgentRunMutationResult>> {
    const parsed = AgentRunHeartbeatInputSchema.safeParse(inputValue);
    if (!parsed.success) return { ok: false, status: 400, error: { code: "INVALID_AGENT_HEARTBEAT", message: parsed.error.message } };
    const input = parsed.data;
    const requestHash = await sha256Json({ action: "heartbeat", input });
    const now = new Date().toISOString();
    const leaseSecondsValue = Number(this.bindings.PRAXIS_AGENT_LEASE_SECONDS ?? 1_800);
    const leaseSeconds = Number.isSafeInteger(leaseSecondsValue) ? Math.min(3_600, Math.max(300, leaseSecondsValue)) : 1_800;
    const leaseExpiresAt = new Date(Date.parse(now) + leaseSeconds * 1_000).toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<AgentRunMutationResult>; events: ProjectEvent[] } => {
      const replay = this.agentMutationReplaySync(runId, input.idempotencyKey, requestHash);
      if (replay) return { response: replay, events: [] };
      const row = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).toArray()[0];
      if (!row) return { response: { ok: false, status: 404, error: { code: "AGENT_RUN_NOT_FOUND", message: "AgentRun does not exist" } }, events: [] };
      const current = rowToAgentRun(row);
      if (current.status !== "claimed" && current.status !== "working") {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT", message: `AgentRun cannot heartbeat while ${current.status}` } }, events: [] };
      }
      if (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(now)) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_LEASE_EXPIRED", message: "AgentRun lease has expired" } }, events: [] };
      }
      this.ctx.storage.sql.exec(
        "UPDATE agent_runs SET status = 'working', lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE run_id = ?",
        leaseExpiresAt,
        now,
        now,
        runId,
      );
      const event = this.appendEvent(current.projectId, "agent_run.updated", { agentRunId: runId, agentRunStatus: "working" }, now);
      const run = rowToAgentRun(this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).one());
      const response = { run, eventSequence: event.sequence, idempotentReplay: false };
      this.persistAgentMutationSync(runId, input.idempotencyKey, requestHash, response, now);
      return { response: { ok: true, value: response }, events: [event] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async finishAgentRun(runId: string, inputValue: unknown): Promise<RoomResult<AgentRunMutationResult>> {
    const parsed = AgentRunFinishInputSchema.safeParse(inputValue);
    if (!parsed.success) return { ok: false, status: 400, error: { code: "INVALID_AGENT_FINISH", message: parsed.error.message, issues: parsed.error.issues } };
    const input: AgentRunFinishInput = parsed.data;
    const requestHash = await sha256Json({ action: "finish", input });
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<AgentRunMutationResult>; events: ProjectEvent[] } => {
      const replay = this.agentMutationReplaySync(runId, input.idempotencyKey, requestHash);
      if (replay) return { response: replay, events: [] };
      const row = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).toArray()[0];
      if (!row) return { response: { ok: false, status: 404, error: { code: "AGENT_RUN_NOT_FOUND", message: "AgentRun does not exist" } }, events: [] };
      const current = rowToAgentRun(row);
      if (current.status !== "claimed" && current.status !== "working" && current.status !== "waiting_on_jobs") {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT", message: `AgentRun cannot finish while ${current.status}` } }, events: [] };
      }
      if (current.status !== input.status) assertAgentRunTransition(current.status, input.status);
      const ownedJobs = this.ctx.storage.sql
        .exec<JobRow>("SELECT * FROM jobs WHERE json_extract(actor_json, '$.runId') = ? ORDER BY created_at", runId)
        .toArray()
        .map(rowToJob);
      const nonterminal = ownedJobs.filter((job) => !terminalJobStatuses.has(job.status));
      if (input.status === "waiting_on_jobs" && (!ownedJobs.length || !nonterminal.length)) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_JOB_STATE_CONFLICT", message: "waiting_on_jobs requires at least one nonterminal run-owned job" } }, events: [] };
      }
      if (input.status === "completed" && nonterminal.length) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_JOB_STATE_CONFLICT", message: "AgentRun cannot complete while run-owned jobs are nonterminal" } }, events: [] };
      }
      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = ?, lease_expires_at = NULL, completion_summary = ?, error_code = ?,
         error_message = ?, updated_at = ? WHERE run_id = ?`,
        input.status,
        input.completionSummary ?? null,
        input.status === "failed" ? input.errorCode ?? "AGENT_RUN_FAILED" : null,
        input.status === "failed" ? input.errorMessage ?? "AgentRun reported failure" : null,
        now,
        runId,
      );
      const event = this.appendEvent(current.projectId, "agent_run.updated", { agentRunId: runId, agentRunStatus: input.status }, now);
      const run = rowToAgentRun(this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).one());
      const response = { run, eventSequence: event.sequence, idempotentReplay: false };
      this.persistAgentMutationSync(runId, input.idempotencyKey, requestHash, response, now);
      return { response: { ok: true, value: response }, events: [event] };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  async cancelAgentRun(runId: string, idempotencyKey: string): Promise<RoomResult<AgentRunMutationResult>> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u.test(idempotencyKey)) {
      return { ok: false, status: 400, error: { code: "INVALID_AGENT_CANCEL", message: "AgentRun cancellation idempotency key is invalid" } };
    }
    const requestHash = await sha256Json({ action: "cancel", idempotencyKey });
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<AgentRunMutationResult>; events: ProjectEvent[] } => {
      const replay = this.agentMutationReplaySync(runId, idempotencyKey, requestHash);
      if (replay) return { response: replay, events: [] };
      const row = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).toArray()[0];
      if (!row) return { response: { ok: false, status: 404, error: { code: "AGENT_RUN_NOT_FOUND", message: "AgentRun does not exist" } }, events: [] };
      const current = rowToAgentRun(row);
      if (isTerminalAgentRunStatus(current.status)) {
        return { response: { ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT", message: `Terminal AgentRun cannot be cancelled from ${current.status}` } }, events: [] };
      }
      assertAgentRunTransition(current.status, "cancelled");
      this.ctx.storage.sql.exec(
        "UPDATE agent_runs SET status = 'cancelled', lease_expires_at = NULL, error_code = NULL, error_message = NULL, updated_at = ? WHERE run_id = ?",
        now,
        runId,
      );
      this.ctx.storage.sql.exec("UPDATE agent_run_claim_tickets SET consumed_at = COALESCE(consumed_at, ?) WHERE run_id = ?", now, runId);
      const events: ProjectEvent[] = [this.appendEvent(current.projectId, "agent_run.updated", { agentRunId: runId, agentRunStatus: "cancelled" }, now)];
      const cancellableJobs = this.ctx.storage.sql
        .exec<JobRow>(
          `SELECT * FROM jobs WHERE json_extract(actor_json, '$.runId') = ?
           AND status IN ('queued', 'running', 'waiting_external')`,
          runId,
        )
        .toArray();
      for (const job of cancellableJobs) {
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET status = 'cancel_requested', cancel_requested_at = COALESCE(cancel_requested_at, ?), reconciliation_failures = 0, updated_at = ? WHERE job_id = ?",
          now,
          now,
          job.job_id,
        );
        events.push(this.appendEvent(current.projectId, "job.updated", { jobId: job.job_id, status: "cancel_requested" }, now));
      }
      const run = rowToAgentRun(this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE run_id = ?", runId).one());
      const response = { run, eventSequence: events.at(-1)!.sequence, idempotentReplay: false };
      this.persistAgentMutationSync(runId, idempotencyKey, requestHash, response, now);
      return { response: { ok: true, value: response }, events };
    });
    this.publish(result.events);
    await this.scheduleReconciliation();
    return result.response;
  }

  private workflowBinding(job: JobRecord) {
    return job.jobType.startsWith("render.") ? this.bindings.RENDER_WORKFLOW : this.bindings.MEDIA_WORKFLOW;
  }

  private reconciliationIntervalMs() {
    const configured = Number(this.bindings.PRAXIS_RECONCILE_INTERVAL_SECONDS ?? 30);
    const seconds = Number.isSafeInteger(configured) ? Math.min(300, Math.max(5, configured)) : 30;
    return seconds * 1_000;
  }

  private cancellationGraceMs() {
    const configured = Number(this.bindings.PRAXIS_CANCEL_GRACE_SECONDS ?? 45);
    const seconds = Number.isSafeInteger(configured) ? Math.min(600, Math.max(5, configured)) : 45;
    return seconds * 1_000;
  }

  private async scheduleReconciliation() {
    const activeJobs = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status NOT IN ('succeeded', 'failed', 'cancelled')")
      .one().count;
    const activeRuns = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM agent_runs WHERE status IN ('dispatching', 'dispatch_unknown', 'claimed', 'working', 'waiting_on_jobs')")
      .one().count;
    if (activeJobs + activeRuns === 0) {
      if (await this.ctx.storage.getAlarm()) await this.ctx.storage.deleteAlarm();
      return;
    }
    const desired = Date.now() + this.reconciliationIntervalMs();
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > desired) await this.ctx.storage.setAlarm(desired);
  }

  private async attachMissingWorkflow(job: JobRecord) {
    const binding = this.workflowBinding(job);
    if (!binding) {
      if (job.status === "cancel_requested") {
        await this.terminalizeCancelledWorkflowJob(job);
      } else {
        await this.transitionJob(job.jobId, {
          expectedStatuses: [job.status],
          status: "failed",
          ...this.cancellationSettlementSync(job),
          errorCode: "WORKFLOW_BINDING_MISSING",
          errorMessage: `No Workflow binding is configured for ${job.jobType}`,
        });
      }
      return;
    }
    const instanceId = await workflowInstanceId(job.projectId, job.jobId, job.jobType);
    const attached = await this.attachWorkflow(job.jobId, instanceId);
    if (!attached.ok) return;
    if (job.status === "cancel_requested") return;
    let instance;
    try {
      instance = await binding.get(instanceId);
    } catch {
      try {
        instance = await binding.create({ id: instanceId, params: { projectId: job.projectId, jobId: job.jobId } });
      } catch {
        try {
          instance = await binding.get(instanceId);
        } catch {
          // The create outcome can be ambiguous. The deterministic ID is now
          // durable, so the next alarm can retry without creating a duplicate.
          return;
        }
      }
    }
    if (instance.id !== instanceId) {
      await this.transitionJob(job.jobId, {
        expectedStatuses: [job.status],
        status: "failed",
        ...this.cancellationSettlementSync(job),
        errorCode: "WORKFLOW_ID_MISMATCH",
        errorMessage: "Workflow binding returned a non-deterministic instance identity",
      });
    }
  }

  private mediaProviderDispatchRecordedSync(job: JobRecord) {
    if (job.jobType !== "image.generate" && job.jobType !== "speech.generate") return false;
    return this.ctx.storage.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM events
         WHERE event_type = 'job.updated'
           AND json_extract(payload_json, '$.jobId') = ?
           AND json_extract(payload_json, '$.status') = 'waiting_external'`,
        job.jobId,
      )
      .one().count > 0;
  }

  private cancellationSettlementSync(job: JobRecord) {
    const providerDispatched = this.mediaProviderDispatchRecordedSync(job);
    return {
      actualCostUsd: providerDispatched ? job.estimatedCostUsd : 0,
      costIsEstimate: providerDispatched,
    };
  }

  private async terminalizeCancelledWorkflowJob(
    job: JobRecord,
    instance?: { terminate(): Promise<unknown> },
  ) {
    const row = this.ctx.storage.sql
      .exec<Pick<JobRow, "cancel_requested_at">>("SELECT cancel_requested_at FROM jobs WHERE job_id = ?", job.jobId)
      .one();
    const requestedAt = Date.parse(row.cancel_requested_at ?? job.updatedAt);
    if (Date.now() - requestedAt < this.cancellationGraceMs()) return false;
    if (instance) {
      try {
        await instance.terminate();
      } catch {
        // After the bounded grace period the durable cancellation is
        // authoritative even when the Workflow is already terminal or its
        // status endpoint is unavailable.
      }
    }
    await this.transitionJob(job.jobId, {
      expectedStatuses: ["cancel_requested"],
      status: "cancelled",
      ...this.cancellationSettlementSync(job),
      errorCode: "CANCELLED",
      errorMessage: "Job cancellation completed after the bounded grace period",
    });
    return true;
  }

  private async reconcileWorkflowJob(job: JobRecord) {
    if (!job.workflowId) {
      await this.attachMissingWorkflow(job);
      return;
    }

    const binding = this.workflowBinding(job);
    if (!binding) {
      if (job.status === "cancel_requested") {
        await this.terminalizeCancelledWorkflowJob(job);
      } else {
        await this.transitionJob(job.jobId, {
          expectedStatuses: [job.status],
          status: "failed",
          ...this.cancellationSettlementSync(job),
          errorCode: "WORKFLOW_BINDING_MISSING",
          errorMessage: `No Workflow binding is configured for ${job.jobType}`,
        });
      }
      return;
    }

    let instance;
    let workflowStatus: string;
    try {
      try {
        instance = await binding.get(job.workflowId);
      } catch (getError) {
        if (job.status === "cancel_requested") throw getError;
        try {
          instance = await binding.create({ id: job.workflowId, params: { projectId: job.projectId, jobId: job.jobId } });
        } catch (creationError) {
          try {
            instance = await binding.get(job.workflowId);
          } catch {
            throw creationError;
          }
        }
      }
      workflowStatus = String((await instance.status()).status);
      if (workflowStatus !== "unknown") {
        this.ctx.storage.sql.exec("UPDATE jobs SET reconciliation_failures = 0 WHERE job_id = ?", job.jobId);
      }
    } catch {
      const failures = (this.ctx.storage.sql.exec<Pick<JobRow, "reconciliation_failures">>("SELECT reconciliation_failures FROM jobs WHERE job_id = ?", job.jobId).one().reconciliation_failures ?? 0) + 1;
      this.ctx.storage.sql.exec("UPDATE jobs SET reconciliation_failures = ? WHERE job_id = ?", failures, job.jobId);
      if (job.status === "cancel_requested") {
        await this.terminalizeCancelledWorkflowJob(job);
      }
      // A failed status probe is not evidence that an externally durable
      // Workflow stopped. Keep non-cancelled work active and retry on the next
      // alarm; a late authoritative finalizer must remain admissible.
      return;
    }

    if (job.status === "cancel_requested") {
      await this.terminalizeCancelledWorkflowJob(job, instance);
      return;
    }

    if (workflowStatus === "complete") {
      await this.transitionJob(job.jobId, {
        expectedStatuses: [job.status],
        status: "failed",
        ...this.cancellationSettlementSync(job),
        errorCode: "WORKFLOW_COMPLETED_WITHOUT_RESULT",
        errorMessage: "Workflow completed without atomically finalizing its durable job result",
      });
    } else if (workflowStatus === "errored") {
      await this.transitionJob(job.jobId, {
        expectedStatuses: [job.status],
        status: "failed",
        ...this.cancellationSettlementSync(job),
        errorCode: "WORKFLOW_ERRORED",
        errorMessage: "Workflow entered the errored state",
      });
    } else if (workflowStatus === "terminated") {
      await this.transitionJob(job.jobId, {
        expectedStatuses: [job.status],
        status: "failed",
        ...this.cancellationSettlementSync(job),
        errorCode: "WORKFLOW_TERMINATED_UNEXPECTEDLY",
        errorMessage: "Workflow terminated without a cancellation request",
      });
    } else if (workflowStatus === "unknown") {
      const failures = (this.ctx.storage.sql.exec<Pick<JobRow, "reconciliation_failures">>("SELECT reconciliation_failures FROM jobs WHERE job_id = ?", job.jobId).one().reconciliation_failures ?? 0) + 1;
      this.ctx.storage.sql.exec("UPDATE jobs SET reconciliation_failures = ? WHERE job_id = ?", failures, job.jobId);
      // `unknown` is an observability state, not a terminal Workflow state.
      // Preserve the durable job so a later status sample or finalizer can win.
    }
  }

  private reconcileAgentRunsSync(now: string): ProjectEvent[] {
    const events: ProjectEvent[] = [];
    const claimExpired = this.ctx.storage.sql
      .exec<AgentRunRow>("SELECT * FROM agent_runs WHERE status IN ('dispatching', 'dispatch_unknown') AND claim_expires_at <= ?", now)
      .toArray();
    for (const row of claimExpired) {
      this.ctx.storage.sql.exec(
        "UPDATE agent_runs SET status = 'failed', error_code = 'AGENT_CLAIM_EXPIRED', error_message = 'One-use AgentRun claim ticket expired before claim', updated_at = ? WHERE run_id = ?",
        now,
        row.run_id,
      );
      events.push(this.appendEvent(row.project_id, "agent_run.updated", { agentRunId: row.run_id, agentRunStatus: "failed" }, now));
    }
    const leaseExpired = this.ctx.storage.sql
      .exec<AgentRunRow>("SELECT * FROM agent_runs WHERE status IN ('claimed', 'working') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?", now)
      .toArray();
    for (const row of leaseExpired) {
      this.ctx.storage.sql.exec(
        "UPDATE agent_runs SET status = 'failed', lease_expires_at = NULL, error_code = 'AGENT_LEASE_EXPIRED', error_message = 'AgentRun heartbeat lease expired', updated_at = ? WHERE run_id = ?",
        now,
        row.run_id,
      );
      events.push(this.appendEvent(row.project_id, "agent_run.updated", { agentRunId: row.run_id, agentRunStatus: "failed" }, now));
    }
    const waiting = this.ctx.storage.sql.exec<AgentRunRow>("SELECT * FROM agent_runs WHERE status = 'waiting_on_jobs'").toArray();
    for (const row of waiting) {
      const jobs = this.ctx.storage.sql
        .exec<JobRow>("SELECT * FROM jobs WHERE json_extract(actor_json, '$.runId') = ?", row.run_id)
        .toArray()
        .map(rowToJob);
      if (!jobs.length || jobs.some((job) => !terminalJobStatuses.has(job.status))) continue;
      const status: AgentRunStatus = jobs.some((job) => job.status === "failed")
        ? "failed"
        : jobs.every((job) => job.status === "cancelled")
          ? "cancelled"
          : "completed";
      this.ctx.storage.sql.exec(
        `UPDATE agent_runs SET status = ?, completion_summary = COALESCE(completion_summary, ?),
         error_code = ?, error_message = ?, updated_at = ? WHERE run_id = ? AND status = 'waiting_on_jobs'`,
        status,
        status === "completed" ? "Run-owned media jobs completed after the cloud task exited" : null,
        status === "failed" ? "AGENT_RUN_JOB_FAILED" : null,
        status === "failed" ? "One or more run-owned media jobs failed" : null,
        now,
        row.run_id,
      );
      events.push(this.appendEvent(row.project_id, "agent_run.updated", { agentRunId: row.run_id, agentRunStatus: status }, now));
    }
    return events;
  }

  async alarm() {
    const jobs = this.ctx.storage.sql
      .exec<JobRow>("SELECT * FROM jobs WHERE status NOT IN ('succeeded', 'failed', 'cancelled') ORDER BY created_at")
      .toArray()
      .map(rowToJob);
    for (const job of jobs) {
      try {
        await this.reconcileWorkflowJob(job);
      } catch {
        // A single malformed or concurrently terminalized job must not prevent
        // reconciliation of the remaining durable work.
      }
    }
    const events = this.ctx.storage.transactionSync(() => this.reconcileAgentRunsSync(new Date().toISOString()));
    this.publish(events);
    await this.scheduleReconciliation();
  }

  async recordAsset(recordInput: unknown): Promise<RoomResult<PersistedAssetRecord>> {
    const parsed = PersistedAssetRecordSchema.safeParse(recordInput);
    if (!parsed.success) return { ok: false, status: 400, error: { code: "INVALID_ASSET_RECORD", message: parsed.error.message } };
    const record = parsed.data;
    const project = this.loadProject();
    if (!project || project.projectId !== record.projectId) return { ok: false, status: 404, error: { code: "PROJECT_NOT_FOUND", message: "Project does not exist" } };
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<PersistedAssetRecord>; events: ProjectEvent[] } => {
      const existing = this.ctx.storage.sql.exec<AssetRow>("SELECT * FROM asset_records WHERE asset_version_id = ?", record.assetVersionId).toArray()[0];
      if (existing) {
        const value = rowToAsset(existing);
        if (value.sha256 !== record.sha256 || value.objectKey !== record.objectKey) return { response: { ok: false, status: 409, error: { code: "ASSET_VERSION_IMMUTABLE", message: "Asset version already exists with different immutable content" } }, events: [] };
        return { response: { ok: true, value }, events: [] };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO asset_records(asset_id, asset_version_id, project_id, kind, object_key, sha256, mime_type, byte_length,
         width, height, duration_ms, provenance_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        record.assetId,
        record.assetVersionId,
        record.projectId,
        record.kind,
        record.objectKey,
        record.sha256,
        record.mimeType,
        record.byteLength,
        record.width ?? null,
        record.height ?? null,
        record.durationMs ?? null,
        stableJson(record.provenance),
        record.createdAt,
      );
      const event = this.appendEvent(record.projectId, "asset.created", { assetVersionId: record.assetVersionId }, record.createdAt);
      return { response: { ok: true, value: record }, events: [event] };
    });
    this.publish(result.events);
    return result.response;
  }

  async getAssetByVersion(assetVersionId: string): Promise<RoomResult<PersistedAssetRecord>> {
    const row = this.ctx.storage.sql.exec<AssetRow>("SELECT * FROM asset_records WHERE asset_version_id = ?", assetVersionId).toArray()[0];
    return row ? { ok: true, value: rowToAsset(row) } : { ok: false, status: 404, error: { code: "ASSET_NOT_FOUND", message: "Asset version does not exist" } };
  }

  async recordRender(recordInput: unknown): Promise<RoomResult<{ render: RenderRecord; eventSequence: number }>> {
    const parsed = RenderRecordSchema.safeParse(recordInput);
    if (!parsed.success) return { ok: false, status: 400, error: { code: "INVALID_RENDER_RECORD", message: parsed.error.message } };
    const incoming = parsed.data;
    const result = this.ctx.storage.transactionSync((): { response: RoomResult<{ render: RenderRecord; eventSequence: number }>; events: ProjectEvent[] } => {
      const project = this.requireProject();
      const existing = this.ctx.storage.sql.exec<RenderRow>("SELECT * FROM renders WHERE render_id = ?", incoming.renderId).toArray()[0];
      if (existing) {
        const render = rowToRender(existing);
        if (render.sha256 !== incoming.sha256) return { response: { ok: false, status: 409, error: { code: "RENDER_IMMUTABLE", message: "Render ID already references another output" } }, events: [] };
        return { response: { ok: true, value: { render, eventSequence: this.latestEventSequenceSync() } }, events: [] };
      }
      const render = RenderRecordSchema.parse({ ...incoming, outdated: incoming.projectRevision < project.revision });
      this.ctx.storage.sql.exec(
        `INSERT INTO renders(render_id, project_id, job_id, project_revision, manifest_hash, manifest_object_key, output_object_key,
         poster_object_key, sha256, byte_length, width, height, duration_ms, video_codec, audio_codec, pixel_format, outdated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        render.renderId,
        render.projectId,
        render.jobId,
        render.projectRevision,
        render.manifestHash,
        render.manifestObjectKey ?? null,
        render.outputObjectKey,
        render.posterObjectKey ?? null,
        render.sha256,
        render.byteLength,
        render.width,
        render.height,
        render.durationMs,
        render.videoCodec,
        render.audioCodec ?? null,
        render.pixelFormat,
        render.outdated ? 1 : 0,
        render.createdAt,
      );
      const events = [this.appendEvent(render.projectId, "render.ready", { renderId: render.renderId, revision: render.projectRevision }, render.createdAt)];
      if (render.outdated) events.push(this.appendEvent(render.projectId, "render.outdated", { renderId: render.renderId, currentRevision: project.revision }, render.createdAt));
      return { response: { ok: true, value: { render, eventSequence: events.at(-1)!.sequence } }, events };
    });
    this.publish(result.events);
    return result.response;
  }

  async getRender(renderId: string): Promise<RoomResult<RenderRecord>> {
    const row = this.ctx.storage.sql.exec<RenderRow>("SELECT * FROM renders WHERE render_id = ?", renderId).toArray()[0];
    return row ? { ok: true, value: rowToRender(row) } : { ok: false, status: 404, error: { code: "RENDER_NOT_FOUND", message: "Render does not exist" } };
  }

  getEvents(afterSequence: number, limit = 500): ProjectEvent[] {
    return this.ctx.storage.sql
      .exec<EventRow>("SELECT sequence, event_type, payload_json, created_at FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?", Math.max(0, afterSequence), Math.min(500, Math.max(1, limit)))
      .toArray()
      .map((row) => ProjectEventSchema.parse({ sequence: row.sequence, projectId: this.requireProject().projectId, type: row.event_type, createdAt: row.created_at, ...parseJson<Record<string, unknown>>(row.payload_json) }));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/events") return new Response("Not found", { status: 404 });
    const afterHeader = request.headers.get("last-event-id");
    const after = Number(url.searchParams.get("afterSequence") ?? afterHeader ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return Response.json({ code: "INVALID_EVENT_CURSOR", message: "Event cursor must be a nonnegative integer" }, { status: 400 });
    const backlog = this.getEvents(after);
    let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        activeController = controller;
        for (const event of backlog) controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        controller.enqueue(encoder.encode(": connected\n\n"));
        this.subscribers.add(controller);
      },
      cancel: () => {
        if (activeController) this.subscribers.delete(activeController);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }
}

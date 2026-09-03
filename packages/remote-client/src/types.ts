import type { ProjectCommandInput } from "@praxis/commands";
import type {
  AgentRun,
  AgentRunClaimRequest,
  AgentRunFinishInput,
  AgentRunHeartbeatInput,
  CreateAgentRunRequest as CanonicalCreateAgentRunRequest,
} from "@praxis/agent-runs";
import type {
  BudgetSummary,
  JobCreateRequest,
  JobRecord,
  JobStatus as DurableJobStatus,
  MediaJobType as DurableMediaJobType,
  PersistedAssetRecord,
  ProjectEvent as DurableProjectEvent,
  RenderRecord,
} from "@praxis/jobs";
import type {
  ActorKind,
  ProductionProject,
} from "@praxis/project-schema";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface PraxisRemoteClientOptions {
  /** Origin or API root. Both `https://host` and `https://host/api` are accepted. */
  readonly baseUrl: string;
  /** Owner or project-scoped capability token. It is used only in Authorization headers. */
  readonly token?: string;
  /** Injectable for tests and non-browser runtimes. Defaults to globalThis.fetch. */
  readonly fetch?: FetchLike;
  /** Retry unauthenticated cookie-backed requests once after exchanging an Access browser session. */
  readonly refreshBrowserSessionOnUnauthorized?: boolean;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export interface BrowserSessionResponse {
  readonly ok: true;
  readonly expiresAt: string;
}

export interface OperationHistorySummary {
  readonly sequence?: number;
  readonly entryId?: string;
  readonly commandId: string;
  readonly idempotencyKey?: string;
  readonly actorKind?: ActorKind;
  readonly actorId?: string;
  readonly baseRevision?: number;
  readonly resultRevision?: number;
  readonly revisionBefore?: number;
  readonly revisionAfter?: number;
  readonly reason?: string;
  readonly affectedEntityIds?: readonly string[];
  readonly staleEntityIds?: readonly string[];
  readonly createdAt?: string;
  readonly committedAt?: string;
  readonly [key: string]: unknown;
}

export interface HistorySummary {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly entries: readonly OperationHistorySummary[];
  readonly [key: string]: unknown;
}

export type ProjectBudgetSummary = BudgetSummary;
export type JobStatus = DurableJobStatus;
export type MediaJobType = DurableMediaJobType;
export type MediaJobRecord = JobRecord;
export type RenderSummary = RenderRecord;
export type AssetSummary = PersistedAssetRecord;

export interface CheckpointSummary {
  readonly checkpointId: string;
  readonly revision: number;
  readonly label: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly reason?: string;
}

export interface ProjectHydrationResponse {
  readonly project: ProductionProject;
  readonly history: HistorySummary;
  readonly checkpoints: readonly CheckpointSummary[];
  readonly jobs: readonly MediaJobRecord[];
  readonly budget: ProjectBudgetSummary;
  readonly renders: readonly RenderSummary[];
  readonly assets: readonly AssetSummary[];
  /** Present after the AgentRun storage migration; optional for rolling deploy compatibility. */
  readonly agentRuns?: readonly AgentRun[];
  readonly latestEventSequence: number;
  readonly [key: string]: unknown;
}

export type ApplyCommandRequest = ProjectCommandInput;

export interface CreateProjectRequest {
  readonly projectId: string;
  readonly snapshot: ProductionProject;
}

export interface CommandCommitResponse {
  readonly project: ProductionProject;
  readonly revision: number;
  readonly commandId: string;
  readonly affectedEntityIds: readonly string[];
  readonly staleEntityIds: readonly string[];
  readonly eventSequence?: number;
  readonly idempotentReplay: boolean;
  readonly checkpointId?: string;
  readonly [key: string]: unknown;
}

export interface RevisionMutationRequest {
  readonly commandId?: string;
  readonly baseRevision: number;
  readonly idempotencyKey: string;
}

export interface CreateCheckpointRequest extends RevisionMutationRequest {
  readonly checkpointId?: string;
  readonly label: string;
  readonly reason?: string;
  /** Requests a non-escalating attribution downgrade for a WebMCP-created checkpoint. */
  readonly actor?: { readonly kind: "codex" };
}

export interface CreateCheckpointResponse extends CommandCommitResponse {
  readonly checkpointId: string;
}

export interface RestoreCheckpointRequest extends RevisionMutationRequest {
  readonly reason?: string;
}
export type CreateJobRequest = JobCreateRequest;

export type CreateAgentRunRequest = CanonicalCreateAgentRunRequest;
export type ClaimAgentRunRequest = AgentRunClaimRequest;
export type HeartbeatAgentRunRequest = AgentRunHeartbeatInput;
export type FinishAgentRunRequest = AgentRunFinishInput;

export interface CancelAgentRunRequest {
  readonly idempotencyKey: string;
}

export interface AgentRunResponse {
  readonly run: AgentRun;
  readonly eventSequence?: number;
  readonly idempotentReplay?: boolean;
  readonly [key: string]: unknown;
}

export interface AgentRunListResponse {
  readonly runs: readonly AgentRun[];
  readonly latestEventSequence?: number;
  readonly [key: string]: unknown;
}

export interface ClaimAgentRunResponse extends AgentRunResponse {
  /** Short-lived run capability. Callers must persist it as a secret. */
  readonly capabilityToken: string;
  readonly expiresAt: string;
}

export interface HeartbeatAgentRunResponse extends AgentRunResponse {
  /** Rotated run capability whose expiry matches the renewed durable lease. */
  readonly capabilityToken: string;
  readonly expiresAt: string;
}

export interface AgentRunContextResponse {
  readonly run: AgentRun;
  readonly project: ProductionProject;
  readonly history: {
    readonly entries: readonly OperationHistorySummary[];
    readonly [key: string]: unknown;
  };
  readonly checkpoint: CheckpointSummary;
  readonly jobs: readonly MediaJobRecord[];
  readonly budget: ProjectBudgetSummary;
  readonly [key: string]: unknown;
}

export interface JobResponse {
  readonly job: MediaJobRecord;
  readonly eventSequence?: number;
  readonly idempotentReplay?: boolean;
  readonly [key: string]: unknown;
}

export interface JobListResponse {
  readonly jobs: readonly MediaJobRecord[];
  readonly latestEventSequence?: number;
  readonly [key: string]: unknown;
}

export interface ApiErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly summary?: string;
  readonly expectedRevision?: number;
  readonly currentRevision?: number;
  readonly changedEntityIds?: readonly string[];
  readonly lockedEntityIds?: readonly string[];
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly [key: string]: unknown;
}

export type ProjectEvent = DurableProjectEvent;

export interface ProjectEventGap {
  readonly lastSequence: number;
  readonly expectedSequence: number;
  readonly receivedSequence: number;
}

export interface SubscribeProjectEventsOptions {
  readonly afterSequence?: number;
  readonly signal?: AbortSignal;
  readonly reconnect?: boolean;
  readonly reconnectDelayMs?: number;
  readonly onEvent: (event: ProjectEvent) => void | Promise<void>;
  readonly onGap?: (gap: ProjectEventGap) => void | Promise<void>;
  readonly onError?: (error: Error) => void | Promise<void>;
}

export interface ProjectEventSubscription {
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  close(reason?: unknown): void;
  getLastSequence(): number;
}

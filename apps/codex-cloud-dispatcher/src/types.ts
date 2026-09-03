export const CAPABILITY_SCOPES = [
  "project:read",
  "command:write",
  "job:create",
  "job:read",
  "job:cancel",
  "asset:read",
  "agent:read",
  "agent:write",
  "agent:dispatch",
] as const;

export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

export type AgentRunStatus =
  | "created"
  | "dispatching"
  | "claimed"
  | "working"
  | "waiting_on_jobs"
  | "completed"
  | "failed"
  | "cancelled"
  | "dispatch_unknown";

export const AGENT_RUN_STAGES = [
  "treatment",
  "script",
  "previz",
  "assets",
  "edit",
  "finish",
] as const;

export type AgentRunStage = (typeof AGENT_RUN_STAGES)[number];

export const AGENT_RUN_MODES = ["propose", "act"] as const;

export type AgentRunMode = (typeof AGENT_RUN_MODES)[number];

/** The dispatcher-visible projection of the durable AgentRun. */
export interface DispatchableAgentRun {
  readonly id: string;
  readonly projectId: string;
  readonly baseRevision: number;
  readonly role: "producer-editor" | "reviewer";
  readonly stages: readonly AgentRunStage[];
  readonly mode: AgentRunMode;
  readonly status: AgentRunStatus;
  readonly scopes: readonly CapabilityScope[];
  readonly deniedEntityIds: readonly string[];
  readonly maxSpendUsd: number;
  readonly claimExpiresAt: string;
  readonly leaseExpiresAt?: string;
  readonly codexTaskId?: string;
  readonly codexTaskUrl?: string;
  readonly lastHeartbeatAt?: string;
  readonly completionSummary?: string;
}

export type DispatchLeaseMode = "submit" | "reconcile";

/**
 * Returned atomically by the control plane. A submit lease includes the only
 * plaintext copy of the one-use claim ticket. A reconcile lease never does.
 */
export interface DispatchLease {
  readonly attemptId: string;
  readonly mode: DispatchLeaseMode;
  readonly run: DispatchableAgentRun;
  readonly claimTicket?: string;
}

export interface ReconciliationCandidate {
  readonly attemptId: string;
  readonly run: DispatchableAgentRun;
}

export interface CloudTask {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly environmentId: string;
  readonly environmentLabel?: string;
  readonly summary?: string;
  readonly isReview?: boolean;
  readonly attemptTotal?: number;
}

export interface CloudTaskPage {
  readonly tasks: readonly CloudTask[];
  readonly cursor?: string;
}

export type DispatchAttemptOutcome = "dispatched" | "dispatch_unknown" | "not_submitted";

export interface DispatchAttemptResult {
  readonly dispatcherId: string;
  readonly outcome: DispatchAttemptOutcome;
  readonly observedAt: string;
  readonly reasonCode: string;
  readonly codexTaskId?: string;
  readonly codexTaskUrl?: string;
  readonly candidateTaskIds?: readonly string[];
}

export type DispatchIterationResult =
  | { readonly kind: "idle" }
  | {
      readonly kind: "processed";
      readonly runId: string;
      readonly attemptId: string;
      readonly result: DispatchAttemptResult;
    };

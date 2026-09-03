import type { AgentRunStatus } from "./schema";

export const TERMINAL_AGENT_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly AgentRunStatus[];

export type TerminalAgentRunStatus = (typeof TERMINAL_AGENT_RUN_STATUSES)[number];

export const AGENT_RUN_TRANSITIONS = {
  created: ["dispatching", "cancelled"],
  dispatching: ["claimed", "failed", "cancelled", "dispatch_unknown"],
  dispatch_unknown: ["dispatching", "claimed", "failed", "cancelled"],
  claimed: ["working", "waiting_on_jobs", "completed", "failed", "cancelled"],
  working: ["waiting_on_jobs", "completed", "failed", "cancelled"],
  waiting_on_jobs: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<AgentRunStatus, readonly AgentRunStatus[]>;

const terminalStatuses = new Set<AgentRunStatus>(TERMINAL_AGENT_RUN_STATUSES);

export const isTerminalAgentRunStatus = (
  status: AgentRunStatus,
): status is TerminalAgentRunStatus => terminalStatuses.has(status);

export const canTransitionAgentRun = (
  from: AgentRunStatus,
  to: AgentRunStatus,
): boolean => (AGENT_RUN_TRANSITIONS[from] as readonly AgentRunStatus[]).includes(to);

export class AgentRunTransitionError extends Error {
  readonly code = "AGENT_RUN_STATE_CONFLICT" as const;

  constructor(
    readonly from: AgentRunStatus,
    readonly to: AgentRunStatus,
  ) {
    super(`AgentRun cannot transition from ${from} to ${to}`);
    this.name = "AgentRunTransitionError";
  }
}

export const assertAgentRunTransition = <Target extends AgentRunStatus>(
  from: AgentRunStatus,
  to: Target,
): Target => {
  if (!canTransitionAgentRun(from, to)) {
    throw new AgentRunTransitionError(from, to);
  }
  return to;
};

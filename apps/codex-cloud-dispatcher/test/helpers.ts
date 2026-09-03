import type { DispatchLease, DispatchableAgentRun } from "../src/types";

export const CLAIM_TICKET = "claim-ticket-praxis-one-use-0123456789abcdef";

export const agentRun = (overrides: Partial<DispatchableAgentRun> = {}): DispatchableAgentRun => ({
  id: "run_fax_01",
  projectId: "project_fax_01",
  baseRevision: 15,
  role: "producer-editor",
  stages: ["treatment", "script", "previz", "assets", "edit", "finish"],
  mode: "act",
  status: "dispatching",
  scopes: ["project:read", "command:write", "job:create", "job:read", "agent:read", "agent:write"],
  deniedEntityIds: ["scene_locked_01"],
  maxSpendUsd: 1,
  claimExpiresAt: "2026-08-26T13:00:00.000Z",
  leaseExpiresAt: "2026-08-26T12:05:00.000Z",
  ...overrides,
});

export const dispatchLease = (overrides: Partial<DispatchLease> = {}): DispatchLease => ({
  mode: "submit",
  attemptId: "attempt_fax_01",
  run: agentRun(),
  claimTicket: CLAIM_TICKET,
  ...overrides,
});

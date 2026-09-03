import { describe, expect, it } from "vitest";
import {
  AgentClaimTicketClaimsSchema,
  AgentRunClaimRequestSchema,
  AgentRunDispatchInputSchema,
  AgentRunFinishInputSchema,
  AgentRunHeartbeatInputSchema,
  AgentRunSchema,
  AgentRunTransitionInputSchema,
  CreateAgentRunInputSchema,
} from "./index";

const createdRun = {
  id: "run_fax_oracle_01",
  projectId: "project_fax_oracle",
  checkpointId: "checkpoint_before_run_01",
  baseRevision: 17,
  role: "producer-editor" as const,
  stages: ["script", "previz", "edit"] as const,
  mode: "act" as const,
  status: "created" as const,
  scopes: ["project:read", "command:write", "job:create", "job:read", "agent:read", "agent:write"] as const,
  deniedEntityIds: ["scene_03"],
  maxSpendUsd: 1,
  claimExpiresAt: "2026-08-26T18:10:00.000Z",
  createdAt: "2026-08-26T18:00:00.000Z",
  updatedAt: "2026-08-26T18:00:00.000Z",
};

describe("AgentRun schemas", () => {
  it("parses the durable AgentRun contract and applies safe create defaults", () => {
    expect(AgentRunSchema.parse(createdRun)).toEqual(createdRun);

    expect(AgentRunSchema.parse({
      ...createdRun,
      stages: undefined,
      mode: undefined,
    })).toMatchObject({
      stages: ["treatment", "script", "previz", "assets", "edit", "finish"],
      mode: "act",
    });

    const create = CreateAgentRunInputSchema.parse({
      idempotencyKey: "take-the-stack-01",
      baseRevision: 16,
      role: "producer-editor",
      stages: ["script", "previz", "edit"],
      mode: "act",
      scopes: ["project:read", "command:write", "agent:read", "agent:write"],
      maxSpendUsd: 1,
    });

    expect(create).toMatchObject({
      deniedEntityIds: [],
      claimTicketTtlSeconds: 600,
      checkpointLabel: "Before delegated production",
      stages: ["script", "previz", "edit"],
      mode: "act",
    });
  });

  it("requires an active lease for claimed and working runs", () => {
    expect(AgentRunSchema.safeParse({ ...createdRun, status: "claimed" }).success).toBe(false);
    expect(AgentRunSchema.safeParse({
      ...createdRun,
      status: "working",
      leaseExpiresAt: "2026-08-26T18:15:00.000Z",
      lastHeartbeatAt: "2026-08-26T18:02:00.000Z",
      updatedAt: "2026-08-26T18:02:00.000Z",
    }).success).toBe(true);
  });

  it("rejects duplicate authority and denial entries", () => {
    expect(CreateAgentRunInputSchema.safeParse({
      idempotencyKey: "duplicate-scopes-01",
      baseRevision: 1,
      role: "producer-editor",
      scopes: ["project:read", "project:read"],
      maxSpendUsd: 1,
    }).success).toBe(false);

    expect(AgentRunSchema.safeParse({
      ...createdRun,
      deniedEntityIds: ["scene_03", "scene_03"],
    }).success).toBe(false);

    expect(CreateAgentRunInputSchema.safeParse({
      idempotencyKey: "duplicate-stages-01",
      baseRevision: 1,
      role: "producer-editor",
      stages: ["script", "script"],
      mode: "act",
      scopes: ["project:read", "command:write"],
      maxSpendUsd: 1,
    }).success).toBe(false);
  });

  it("keeps reviewer runs proposal-only", () => {
    const reviewer = {
      idempotencyKey: "reviewer-proposal-01",
      baseRevision: 1,
      role: "reviewer" as const,
      stages: ["script", "previz", "edit"] as const,
      scopes: ["project:read", "agent:read", "agent:write"] as const,
      maxSpendUsd: 0,
    };
    expect(CreateAgentRunInputSchema.safeParse({ ...reviewer, mode: "act" }).success).toBe(false);
    expect(CreateAgentRunInputSchema.safeParse({ ...reviewer, mode: "propose" }).success).toBe(true);
  });

  it("rejects timestamps that precede creation or heartbeat", () => {
    expect(AgentRunSchema.safeParse({
      ...createdRun,
      updatedAt: "2026-08-26T17:59:59.000Z",
    }).success).toBe(false);

    expect(AgentRunSchema.safeParse({
      ...createdRun,
      status: "working",
      lastHeartbeatAt: "2026-08-26T18:05:00.000Z",
      leaseExpiresAt: "2026-08-26T18:04:59.000Z",
      updatedAt: "2026-08-26T18:05:00.000Z",
    }).success).toBe(false);
  });

  it("validates claim tickets and all dispatcher actions", () => {
    expect(AgentRunClaimRequestSchema.parse({ ticket: "x".repeat(32) })).toEqual({ ticket: "x".repeat(32) });
    expect(AgentClaimTicketClaimsSchema.parse({
      version: 1,
      ticketId: "ticket_run_01",
      projectId: "project_fax_oracle",
      runId: "run_fax_oracle_01",
      expiresAt: "2026-08-26T18:10:00.000Z",
    })).toMatchObject({ version: 1, runId: "run_fax_oracle_01" });

    expect(AgentRunDispatchInputSchema.parse({
      action: "begin",
      idempotencyKey: "dispatch-begin-01",
    }).action).toBe("begin");
    expect(AgentRunDispatchInputSchema.parse({
      action: "record_task",
      idempotencyKey: "dispatch-record-01",
      codexTaskId: "task_codex_01",
      codexTaskUrl: "https://chatgpt.com/codex/tasks/task_codex_01",
    }).action).toBe("record_task");
    expect(AgentRunDispatchInputSchema.parse({
      action: "mark_unknown",
      idempotencyKey: "dispatch-unknown-01",
      errorCode: "CLI_OUTPUT_UNKNOWN",
    }).action).toBe("mark_unknown");
    expect(AgentRunDispatchInputSchema.safeParse({
      action: "mark_failed",
      idempotencyKey: "dispatch-failed-01",
      errorCode: "DISPATCH_FAILED",
    }).success).toBe(false);
  });

  it("keeps heartbeat and finish inputs narrow and bounded", () => {
    expect(AgentRunHeartbeatInputSchema.parse({ idempotencyKey: "heartbeat-run-01" })).toEqual({
      idempotencyKey: "heartbeat-run-01",
    });
    expect(AgentRunHeartbeatInputSchema.safeParse({
      idempotencyKey: "heartbeat-run-01",
      leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    }).success).toBe(false);

    expect(AgentRunFinishInputSchema.parse({
      idempotencyKey: "finish-waiting-01",
      status: "waiting_on_jobs",
      completionSummary: "Queued preview render and left the sandbox.",
    }).status).toBe("waiting_on_jobs");
    expect(AgentRunFinishInputSchema.safeParse({
      idempotencyKey: "finish-complete-01",
      status: "completed",
      errorCode: "SHOULD_NOT_APPEAR",
    }).success).toBe(false);
    expect(AgentRunFinishInputSchema.parse({
      idempotencyKey: "finish-failed-01",
      status: "failed",
      errorCode: "AGENT_FAILED",
      errorMessage: "The bounded task could not be completed.",
    }).status).toBe("failed");
  });

  it("rejects duplicate expected statuses in internal transitions", () => {
    expect(AgentRunTransitionInputSchema.safeParse({
      idempotencyKey: "transition-run-01",
      expectedStatuses: ["claimed", "claimed"],
      status: "working",
    }).success).toBe(false);
  });

  it("bounds task identity, completion, and error diagnostics", () => {
    expect(AgentRunSchema.safeParse({
      ...createdRun,
      codexTaskId: "t".repeat(257),
    }).success).toBe(false);
    expect(AgentRunFinishInputSchema.safeParse({
      idempotencyKey: "finish-summary-bound",
      status: "completed",
      completionSummary: "s".repeat(4_001),
    }).success).toBe(false);
    expect(AgentRunFinishInputSchema.safeParse({
      idempotencyKey: "finish-error-bound",
      status: "failed",
      errorCode: "AGENT_FAILED",
      errorMessage: "e".repeat(2_001),
    }).success).toBe(false);
  });
});

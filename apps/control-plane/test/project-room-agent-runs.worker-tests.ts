/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createSeedProject } from "@praxis/project-schema";
import { ProjectCommandSchema } from "@praxis/commands";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { claimTicketDigest, verifyAgentClaimTicket } from "../src/agent-claim-ticket";
import { ProjectRoom, type ProjectRoomRpc, type RoomResult } from "../src/project-room";

const claimSecret = "test-agent-claim-secret-with-at-least-thirty-two-characters";
const director = { kind: "director" as const, sessionId: "session_agent_director" };
let roomName: string;

beforeEach(() => {
  roomName = `project-room-agent-runs-${crypto.randomUUID()}`;
});

const valueOf = <T>(result: RoomResult<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const initializeRun = async (overrides: Record<string, unknown> = {}) => {
  const stub = env.PROJECT_ROOMS.getByName(roomName);
  const room = stub as unknown as ProjectRoomRpc;
  valueOf(await room.initialize(createSeedProject()));
  const checkpoint = valueOf(await room.createCheckpoint({
    checkpointId: "checkpoint_agent_test",
    commandId: "command_checkpoint_agent_test",
    idempotencyKey: "idempotency_checkpoint_agent_test",
    baseRevision: 1,
    label: "Before delegated test",
    actor: director,
  }));
  const created = valueOf(await room.createAgentRun({
    runId: "run_agent_test",
    checkpointId: "checkpoint_agent_test",
    checkpointCommandId: "command_checkpoint_agent_test",
    idempotencyKey: "idempotency_agent_test",
    baseRevision: checkpoint.revision,
    role: "producer-editor",
    scopes: ["project:read", "command:write", "job:create", "job:read", "job:cancel", "agent:read", "agent:write"],
    deniedEntityIds: ["scene_02"],
    maxSpendUsd: 1,
    claimTicketTtlSeconds: 600,
    checkpointLabel: "Before delegated test",
    ...overrides,
  }, director));
  return { stub, room, created };
};

describe("ProjectRoom durable AgentRuns", () => {
  it("persists idempotent creation and atomically leases a one-use claim ticket", async () => {
    const { stub, room, created } = await initializeRun();
    expect(created.run.status).toBe("created");

    const replay = valueOf(await room.createAgentRun({
      runId: "run_agent_test",
      checkpointId: "checkpoint_agent_test",
      checkpointCommandId: "command_checkpoint_agent_test",
      idempotencyKey: "idempotency_agent_test",
      baseRevision: 2,
      role: "producer-editor",
      scopes: ["project:read", "command:write", "job:create", "job:read", "job:cancel", "agent:read", "agent:write"],
      deniedEntityIds: ["scene_02"],
      maxSpendUsd: 1,
      claimTicketTtlSeconds: 600,
      checkpointLabel: "Before delegated test",
    }, director));
    expect(replay.idempotentReplay).toBe(true);

    const lease = valueOf(await room.leaseNextAgentRun("dispatcher_test", 600));
    expect(lease?.run.status).toBe("dispatching");
    expect(valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))).toBeUndefined();
    const claims = await verifyAgentClaimTicket(lease!.claimTicket, claimSecret);
    expect(claims).toMatchObject({ projectId: "project_fax_oracle", runId: "run_agent_test" });

    const claimed = valueOf(await room.claimAgentRun(claims, await claimTicketDigest(lease!.claimTicket)));
    expect(claimed.run.status).toBe("claimed");
    const reused = await room.claimAgentRun(claims, await claimTicketDigest(lease!.claimTicket));
    expect(reused).toMatchObject({ ok: false, status: 409, error: { code: "AGENT_CLAIM_INVALID" } });

    await evictDurableObject(stub);
    const hydration = valueOf(await (env.PROJECT_ROOMS.getByName(roomName) as unknown as ProjectRoomRpc).getHydration());
    expect(hydration.agentRuns).toHaveLength(1);
    expect(hydration.agentRuns[0]).toMatchObject({ id: "run_agent_test", status: "claimed", checkpointId: "checkpoint_agent_test" });
  });

  it("enforces run-bound command authority and completes waiting runs after owned jobs settle", async () => {
    const { stub, room } = await initializeRun();
    const lease = valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))!;
    const claims = await verifyAgentClaimTicket(lease.claimTicket, claimSecret);
    valueOf(await room.claimAgentRun(claims, await claimTicketDigest(lease.claimTicket)));

    const revised = valueOf(await room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_agent_script",
      idempotencyKey: "idempotency_agent_script",
      projectId: "project_fax_oracle",
      baseRevision: 2,
      actor: { kind: "codex", sessionId: "agent_run_agent_test" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "script.updateBeat", beatId: "beat_01", patch: { title: "Cloud-rebased premise" } }],
    }), { runId: "run_agent_test", deniedEntityIds: ["scene_02"] }));
    expect(revised.revision).toBe(3);
    expect(valueOf(await room.getAgentRun("run_agent_test")).status).toBe("working");

    const forbidden = await room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_agent_forbidden",
      idempotencyKey: "idempotency_agent_forbidden",
      projectId: "project_fax_oracle",
      baseRevision: 3,
      actor: { kind: "codex", sessionId: "agent_run_agent_test" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "scene.setLocked", sceneId: "scene_01", locked: false }],
    }), { runId: "run_agent_test", deniedEntityIds: ["scene_02"] });
    expect(forbidden).toMatchObject({ ok: false, status: 403, error: { code: "AGENT_RUN_OPERATION_DENIED" } });

    const job = valueOf(await room.createJob({
      jobId: "job_agent_image",
      jobType: "image.generate",
      idempotencyKey: "idempotency_agent_image",
      baseRevision: 3,
      targetEntityIds: ["scene_01", "asset_scene_01"],
      request: {
        assetId: "asset_scene_01",
        sceneId: "scene_01",
        prompt: "Generate an acceptance proxy",
        provider: "fake",
        quality: "low",
      },
    }, {
      kind: "codex",
      id: "agent:run_agent_test",
      runId: "run_agent_test",
      capabilityMaxSpendUsd: 1,
    })).job;
    expect(job.status).toBe("queued");

    const waiting = valueOf(await room.finishAgentRun("run_agent_test", {
      idempotencyKey: "idempotency_agent_waiting",
      status: "waiting_on_jobs",
      completionSummary: "Proxy job is durable; leaving the sandbox",
    }));
    expect(waiting.run.status).toBe("waiting_on_jobs");

    const blocked = await room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_agent_after_exit",
      idempotencyKey: "idempotency_agent_after_exit",
      projectId: "project_fax_oracle",
      baseRevision: 3,
      actor: { kind: "codex", sessionId: "agent_run_agent_test" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "script.updateBeat", beatId: "beat_01", patch: { title: "Too late" } }],
    }), { runId: "run_agent_test" });
    expect(blocked).toMatchObject({ ok: false, status: 409, error: { code: "AGENT_RUN_STATE_CONFLICT" } });

    valueOf(await room.transitionJob("job_agent_image", { expectedStatuses: ["queued"], status: "succeeded", actualCostUsd: 0, costIsEstimate: false }));
    await runInDurableObject(stub, async (instance: ProjectRoom) => instance.alarm());
    expect(valueOf(await room.getAgentRun("run_agent_test"))).toMatchObject({ status: "completed" });
  });

  it("rejects run-owned media targets locked after claim without reserving budget", async () => {
    const { room } = await initializeRun();
    const lease = valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))!;
    const claims = await verifyAgentClaimTicket(lease.claimTicket, claimSecret);
    valueOf(await room.claimAgentRun(claims, await claimTicketDigest(lease.claimTicket)));

    valueOf(await room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_director_locks_scene_after_claim",
      idempotencyKey: "idempotency_director_locks_scene_after_claim",
      projectId: "project_fax_oracle",
      baseRevision: 2,
      actor: { kind: "director", sessionId: "session_agent_director" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "scene.setLocked", sceneId: "scene_01", locked: true }],
    })));

    const denied = await room.createJob({
      jobId: "job_agent_locked_scene",
      jobType: "image.generate",
      idempotencyKey: "idempotency_agent_locked_scene",
      baseRevision: 3,
      targetEntityIds: ["scene_01", "asset_scene_01"],
      request: {
        assetId: "asset_scene_01",
        sceneId: "scene_01",
        prompt: "Must preserve the director lock",
        provider: "fake",
        quality: "low",
      },
    }, {
      kind: "codex",
      id: "agent:run_agent_test",
      runId: "run_agent_test",
      capabilityMaxSpendUsd: 1,
    });
    expect(denied).toMatchObject({
      ok: false,
      status: 423,
      error: { code: "ENTITY_LOCKED", lockedEntityIds: ["scene_01"] },
    });
    expect(valueOf(await room.getHydration())).toMatchObject({
      jobs: [],
      budget: { reservedUsd: 0, settledUsd: 0 },
    });

    valueOf(await room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_director_unlocks_scene_after_claim",
      idempotencyKey: "idempotency_director_unlocks_scene_after_claim",
      projectId: "project_fax_oracle",
      baseRevision: 3,
      actor: { kind: "director", sessionId: "session_agent_director" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "scene.setLocked", sceneId: "scene_01", locked: false }],
    })));
    const permitted = valueOf(await room.createJob({
      jobId: "job_agent_unlocked_scene",
      jobType: "image.generate",
      idempotencyKey: "idempotency_agent_unlocked_scene",
      baseRevision: 4,
      targetEntityIds: ["scene_01", "asset_scene_01"],
      request: {
        assetId: "asset_scene_01",
        sceneId: "scene_01",
        prompt: "The director explicitly unlocked this target",
        provider: "fake",
        quality: "low",
      },
    }, {
      kind: "codex",
      id: "agent:run_agent_test",
      runId: "run_agent_test",
      capabilityMaxSpendUsd: 1,
    }));
    expect(permitted.job.status).toBe("queued");
  });

  it("enforces delegated stages and propose mode as durable server authority", async () => {
    const scriptHandle = await initializeRun({ stages: ["script"], mode: "act" });
    const scriptLease = valueOf(await scriptHandle.room.leaseNextAgentRun("dispatcher_test", 600))!;
    const scriptClaims = await verifyAgentClaimTicket(scriptLease.claimTicket, claimSecret);
    valueOf(await scriptHandle.room.claimAgentRun(scriptClaims, await claimTicketDigest(scriptLease.claimTicket)));

    valueOf(await scriptHandle.room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_agent_script_only",
      idempotencyKey: "idempotency_agent_script_only",
      projectId: "project_fax_oracle",
      baseRevision: 2,
      actor: { kind: "codex", sessionId: "agent_run_agent_test" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "script.updateBeat", beatId: "beat_01", patch: { title: "Delegated script edit" } }],
    }), { runId: "run_agent_test" }));

    expect(await scriptHandle.room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_agent_scene_not_delegated",
      idempotencyKey: "idempotency_agent_scene_not_delegated",
      projectId: "project_fax_oracle",
      baseRevision: 3,
      actor: { kind: "codex", sessionId: "agent_run_agent_test" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "scene.setStatus", sceneId: "scene_01", status: "draft" }],
    }), { runId: "run_agent_test" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "AGENT_RUN_STAGE_DENIED" },
    });
    expect(await scriptHandle.room.createJob({
      jobId: "job_agent_undelegated_media",
      jobType: "image.generate",
      idempotencyKey: "idempotency_agent_undelegated_media",
      baseRevision: 3,
      targetEntityIds: ["scene_01", "asset_scene_01"],
      request: { assetId: "asset_scene_01", sceneId: "scene_01", prompt: "Not delegated", provider: "fake", quality: "low" },
    }, {
      kind: "codex",
      id: "agent:run_agent_test",
      runId: "run_agent_test",
      capabilityMaxSpendUsd: 1,
    })).toMatchObject({ ok: false, status: 403, error: { code: "AGENT_RUN_STAGE_DENIED" } });

    roomName = `project-room-agent-runs-${crypto.randomUUID()}`;
    const proposeHandle = await initializeRun({ stages: ["script", "previz", "edit"], mode: "propose" });
    const proposeLease = valueOf(await proposeHandle.room.leaseNextAgentRun("dispatcher_test", 600))!;
    const proposeClaims = await verifyAgentClaimTicket(proposeLease.claimTicket, claimSecret);
    valueOf(await proposeHandle.room.claimAgentRun(proposeClaims, await claimTicketDigest(proposeLease.claimTicket)));
    expect(await proposeHandle.room.applyCommand(ProjectCommandSchema.parse({
      commandId: "command_agent_propose_cannot_commit",
      idempotencyKey: "idempotency_agent_propose_cannot_commit",
      projectId: "project_fax_oracle",
      baseRevision: 2,
      actor: { kind: "codex", sessionId: "agent_run_agent_test" },
      createdAt: new Date().toISOString(),
      operations: [{ type: "script.updateBeat", beatId: "beat_01", patch: { title: "Proposal only" } }],
    }), { runId: "run_agent_test" })).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "AGENT_RUN_MODE_DENIED" },
    });
  });

  it("records dispatch ambiguity without duplicate leasing and can later attach the task identity", async () => {
    const { room } = await initializeRun();
    const lease = valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))!;
    const unknown = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "mark_unknown",
      idempotencyKey: "idempotency_dispatch_unknown",
      errorCode: "CODEX_DISPATCH_UNKNOWN",
      errorMessage: "CLI output and task-list diff were ambiguous",
    }));
    expect(unknown.run.status).toBe("dispatch_unknown");
    expect(unknown.run).toMatchObject({
      errorCode: "CODEX_DISPATCH_UNKNOWN",
      errorMessage: "CLI output and task-list diff were ambiguous",
    });
    expect(valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))).toBeUndefined();

    const repeated = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "mark_unknown",
      idempotencyKey: "idempotency_dispatch_unknown_repoll",
      errorCode: "CODEX_DISPATCH_UNKNOWN",
      errorMessage: "The task is still not visible",
    }));
    expect(repeated).toMatchObject({ run: { status: "dispatch_unknown" }, idempotentReplay: true });

    const recorded = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "record_task",
      idempotencyKey: "idempotency_dispatch_reconciled",
      codexTaskId: "task_cloud_123",
      codexTaskUrl: "https://chatgpt.com/codex/tasks/task_cloud_123",
    }));
    expect(recorded.run).toMatchObject({ status: "dispatching", codexTaskId: "task_cloud_123" });
    expect(recorded.run.errorCode).toBeUndefined();
    expect(recorded.run.errorMessage).toBeUndefined();
  });

  it("records late task evidence as submitted after a pre-claim cancellation", async () => {
    const { stub, room } = await initializeRun();
    const lease = valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))!;
    expect(valueOf(await room.cancelAgentRun("run_agent_test", "idempotency_cancel_before_claim")).run.status).toBe("cancelled");

    const recorded = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "record_task",
      idempotencyKey: "idempotency_dispatch_after_cancel",
      codexTaskId: "task_cloud_cancelled_123",
      codexTaskUrl: "https://chatgpt.com/codex/tasks/task_cloud_cancelled_123",
    }));
    expect(recorded.run).toMatchObject({ status: "cancelled", codexTaskId: "task_cloud_cancelled_123" });

    const attempt = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ status: string }>("SELECT status FROM agent_run_dispatch_attempts WHERE attempt_id = ?", lease.dispatchAttemptId)
        .one(),
    );
    expect(attempt.status).toBe("submitted");
  });

  it("records late task evidence as submitted after a pre-claim dispatch failure", async () => {
    const { stub, room } = await initializeRun();
    const lease = valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))!;
    const failed = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "mark_failed",
      idempotencyKey: "idempotency_dispatch_failed_before_claim",
      errorCode: "CODEX_DISPATCH_FAILED",
      errorMessage: "The CLI rejected the dispatch before the task could claim",
    }));
    expect(failed.run.status).toBe("failed");

    const recorded = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "record_task",
      idempotencyKey: "idempotency_dispatch_after_failure",
      codexTaskId: "task_cloud_failed_123",
      codexTaskUrl: "https://chatgpt.com/codex/tasks/task_cloud_failed_123",
    }));
    expect(recorded.run).toMatchObject({ status: "failed", codexTaskId: "task_cloud_failed_123" });

    const attempt = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ status: string }>("SELECT status FROM agent_run_dispatch_attempts WHERE attempt_id = ?", lease.dispatchAttemptId)
        .one(),
    );
    expect(attempt.status).toBe("submitted");
  });

  it("attaches a late Codex task identity after the claimed run has already completed", async () => {
    const { room } = await initializeRun();
    const lease = valueOf(await room.leaseNextAgentRun("dispatcher_test", 600))!;
    const claims = await verifyAgentClaimTicket(lease.claimTicket, claimSecret);
    valueOf(await room.claimAgentRun(claims, await claimTicketDigest(lease.claimTicket)));
    const ignoredMiss = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "mark_unknown",
      idempotencyKey: "idempotency_dispatch_miss_after_claim",
      errorCode: "RECONCILE_TASK_NOT_VISIBLE",
      errorMessage: "Task-list visibility lagged behind the successful claim",
    }));
    expect(ignoredMiss).toMatchObject({ run: { status: "claimed" }, idempotentReplay: true });
    valueOf(await room.finishAgentRun("run_agent_test", {
      idempotencyKey: "idempotency_agent_completed_before_task_correlation",
      status: "completed",
      completionSummary: "The cloud task completed before the dispatcher persisted its identity",
    }));

    const visible = valueOf(await room.listDispatchAgentRuns(["completed"]));
    expect(visible).toMatchObject([{ dispatchAttemptId: lease.dispatchAttemptId, run: { status: "completed" } }]);

    const recorded = valueOf(await room.recordAgentDispatchResult("run_agent_test", lease.dispatchAttemptId, {
      action: "record_task",
      idempotencyKey: "idempotency_dispatch_late_correlation",
      codexTaskId: "task_cloud_late_123",
      codexTaskUrl: "https://chatgpt.com/codex/tasks/task_cloud_late_123",
    }));
    expect(recorded.run).toMatchObject({ status: "completed", codexTaskId: "task_cloud_late_123" });
  });
});

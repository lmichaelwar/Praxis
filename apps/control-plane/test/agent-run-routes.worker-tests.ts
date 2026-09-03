/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createSeedProject } from "@praxis/project-schema";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { ProjectRoomRpc, RoomResult } from "../src/project-room";

const ownerToken = "owner-token-for-agent-run-route-tests";
const capabilitySecret = "agent-route-capability-secret-with-more-than-32-characters";
const claimSecret = "test-agent-claim-secret-with-at-least-thirty-two-characters";
const dispatcherToken = "agent-route-dispatcher-token-with-more-than-32-characters";
let projectId: string;
let room: ProjectRoomRpc;
let workerEnv: Env;

const valueOf = <T>(result: RoomResult<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const request = (path: string, init: RequestInit = {}) => worker.fetch(
  new Request(`https://praxis.test${path}`, init),
  workerEnv,
);

const postJson = (path: string, body: unknown, token?: string) => request(path, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

beforeEach(async () => {
  projectId = `project_agent_route_${crypto.randomUUID()}`;
  const project = createSeedProject();
  project.projectId = projectId;
  room = env.PROJECT_ROOMS.getByName(projectId) as ProjectRoomRpc;
  valueOf(await room.initialize(project));
  workerEnv = {
    PROJECT_ROOMS: env.PROJECT_ROOMS,
    MEDIA: {} as R2Bucket,
    PRAXIS_OWNER_TOKEN: ownerToken,
    PRAXIS_CAPABILITY_SIGNING_SECRET: capabilitySecret,
    PRAXIS_AGENT_CLAIM_SIGNING_SECRET: claimSecret,
    PRAXIS_DISPATCHER_TOKEN: dispatcherToken,
    PRAXIS_AGENT_LEASE_SECONDS: "1800",
  };
});

describe("AgentRun HTTP membrane", () => {
  it("keeps claim tickets dispatcher-only and exchanges one ticket for one scoped capability", async () => {
    const createdResponse = await postJson(`/api/projects/${projectId}/agent-runs`, {
      idempotencyKey: "idempotency_agent_route_create",
      baseRevision: 1,
      role: "producer-editor",
      scopes: ["project:read", "command:write", "job:create", "job:read", "job:cancel", "agent:read", "agent:write"],
      deniedEntityIds: ["scene_03"],
      maxSpendUsd: 1,
      checkpointLabel: "Before route acceptance",
    }, ownerToken);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { run: { id: string; status: string; baseRevision: number }; claimTicket?: unknown };
    expect(created).not.toHaveProperty("claimTicket");
    expect(created.run).toMatchObject({ status: "created", baseRevision: 2 });

    const leaseResponse = await postJson("/internal/agent-dispatch/lease", {
      projectId,
      dispatcherId: "dispatcher_route_test",
      leaseSeconds: 600,
    }, dispatcherToken);
    expect(leaseResponse.status).toBe(201);
    const lease = await leaseResponse.json() as { run: { id: string }; dispatchAttemptId: string; claimTicket: string };
    expect(lease.run.id).toBe(created.run.id);
    expect(lease.claimTicket).toBeTruthy();

    const claimResponse = await postJson("/api/agent-runs/claim", { ticket: lease.claimTicket });
    expect(claimResponse.status).toBe(201);
    const claimed = await claimResponse.json() as { run: { id: string; status: string }; capabilityToken: string; expiresAt: string };
    expect(claimed.run).toMatchObject({ id: created.run.id, status: "claimed" });
    expect(claimed.capabilityToken).toBeTruthy();
    expect(Date.parse(claimed.expiresAt)).toBeGreaterThan(Date.now());

    const heartbeatResponse = await postJson(`/api/projects/${projectId}/agent-runs/${created.run.id}/heartbeat`, {
      idempotencyKey: "idempotency_agent_route_heartbeat",
    }, claimed.capabilityToken);
    expect(heartbeatResponse.status).toBe(200);
    const heartbeat = await heartbeatResponse.json() as {
      run: { id: string; status: string; leaseExpiresAt: string };
      capabilityToken: string;
      expiresAt: string;
    };
    expect(heartbeat.run).toMatchObject({ id: created.run.id, status: "working", leaseExpiresAt: heartbeat.expiresAt });
    expect(heartbeat.capabilityToken).toBeTruthy();

    const replayedClaim = await postJson("/api/agent-runs/claim", { ticket: lease.claimTicket });
    expect(replayedClaim.status).toBe(409);
    await expect(replayedClaim.json()).resolves.toMatchObject({ code: "AGENT_CLAIM_INVALID" });

    const context = await request(`/api/projects/${projectId}/agent-runs/${created.run.id}/context`, {
      headers: { authorization: `Bearer ${heartbeat.capabilityToken}` },
    });
    expect(context.status).toBe(200);
    await expect(context.json()).resolves.toMatchObject({
      run: { id: created.run.id, checkpointId: expect.any(String) },
      project: { projectId, revision: 2 },
      checkpoint: { label: "Before route acceptance" },
    });
  });

  it("returns a structured stale conflict, preserves a new director lock, and accepts the rebased remainder", async () => {
    const created = await (await postJson(`/api/projects/${projectId}/agent-runs`, {
      idempotencyKey: "idempotency_agent_stale_create",
      baseRevision: 1,
      role: "producer-editor",
      scopes: ["project:read", "command:write", "agent:read", "agent:write"],
      deniedEntityIds: ["scene_03"],
      maxSpendUsd: 1,
      checkpointLabel: "Before stale route test",
    }, ownerToken)).json() as { run: { id: string } };
    const lease = await (await postJson("/internal/agent-dispatch/lease", {
      projectId,
      dispatcherId: "dispatcher_route_test",
      leaseSeconds: 600,
    }, dispatcherToken)).json() as { claimTicket: string; dispatchAttemptId: string };
    const claimed = await (await postJson("/api/agent-runs/claim", { ticket: lease.claimTicket })).json() as { capabilityToken: string };

    const directorLock = await postJson(`/api/projects/${projectId}/commands`, {
      commandId: "command_director_new_lock",
      idempotencyKey: "idempotency_director_new_lock",
      baseRevision: 2,
      operations: [{ type: "scene.setLocked", sceneId: "scene_02", locked: true }],
    }, ownerToken);
    expect(directorLock.status).toBe(200);

    const stale = await postJson(`/api/projects/${projectId}/commands`, {
      commandId: "command_agent_stale_batch",
      idempotencyKey: "idempotency_agent_stale_batch",
      baseRevision: 2,
      operations: [{ type: "script.updateBeat", beatId: "beat_01", patch: { title: "Stale cloud title" } }],
    }, claimed.capabilityToken);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      code: "REVISION_CONFLICT",
      expectedRevision: 2,
      currentRevision: 3,
      lockedEntityIds: expect.arrayContaining(["scene_02"]),
    });

    const rebased = await postJson(`/api/projects/${projectId}/commands`, {
      commandId: "command_agent_rebased_batch",
      idempotencyKey: "idempotency_agent_rebased_batch",
      baseRevision: 3,
      operations: [{ type: "script.updateBeat", beatId: "beat_01", patch: { title: "Rebased cloud title" } }],
    }, claimed.capabilityToken);
    expect(rebased.status).toBe(200);
    const hydrated = valueOf(await room.getHydration());
    expect(hydrated.project.scenes.find((scene) => scene.meta.id === "scene_02")?.meta.locked).toBe(true);
    expect(hydrated.project.script.beats.find((beat) => beat.meta.id === "beat_01")?.title).toBe("Rebased cloud title");

    const finished = await postJson(`/api/projects/${projectId}/agent-runs/${created.run.id}/finish`, {
      idempotencyKey: "idempotency_agent_route_finish",
      status: "completed",
      completionSummary: "Rebased without changing director locks",
    }, claimed.capabilityToken);
    expect(finished.status).toBe(200);
    await expect(finished.json()).resolves.toMatchObject({ run: { status: "completed" } });
  });
});

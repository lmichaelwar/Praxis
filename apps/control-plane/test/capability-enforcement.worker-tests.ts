/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createSeedProject, type ProductionProject } from "@praxis/project-schema";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { mintCapability } from "../src/capabilities";
import type { Env } from "../src/env";
import worker from "../src/index";
import type { ProjectRoomRpc, RoomResult } from "../src/project-room";

const ownerToken = "owner-token-for-capability-enforcement-tests";
const signingSecret = "capability-enforcement-test-secret-more-than-32-characters";
let projectId: string;
let room: ProjectRoomRpc;
let workerEnv: Env;

const valueOf = <T>(result: RoomResult<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const post = (path: string, token: string, body: unknown) =>
  worker.fetch(new Request(`https://praxis.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }), workerEnv);

const commandBody = (name: string, baseRevision: number, operations: unknown[]) => ({
  commandId: `command_${name}`,
  idempotencyKey: `idempotency_${name}`,
  baseRevision,
  reason: `Capability enforcement test ${name}`,
  operations,
});

const capability = (deniedEntityIds: string[]) =>
  mintCapability({
    subject: "codex-capability-test",
    projectId,
    scopes: ["command:write"],
    deniedEntityIds,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, signingSecret);

const expectDenied = async (response: Response, deniedEntityId: string) => {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    code: "CAPABILITY_ENTITY_DENIED",
    deniedEntityIds: expect.arrayContaining([deniedEntityId]),
  });
};

beforeEach(async () => {
  projectId = `project_auth_${crypto.randomUUID()}`;
  const project = createSeedProject();
  project.projectId = projectId;
  room = env.PROJECT_ROOMS.getByName(projectId) as ProjectRoomRpc;
  valueOf(await room.initialize(project));
  workerEnv = {
    PROJECT_ROOMS: env.PROJECT_ROOMS,
    MEDIA: {} as R2Bucket,
    PRAXIS_OWNER_TOKEN: ownerToken,
    PRAXIS_CAPABILITY_SIGNING_SECRET: signingSecret,
  };
});

describe("capability denied-entity mutation enforcement", () => {
  it("atomically rejects undo, redo, checkpoint restore, nested restore, and implicit parent mutations", async () => {
    const beatCapability = await capability(["beat_02"]);

    const unlock = await post(`/api/projects/${projectId}/commands`, ownerToken, commandBody("unlock", 1, [
      { type: "scene.setLocked", sceneId: "scene_03", locked: false },
    ]));
    expect(unlock.status).toBe(200);

    const edit = await post(`/api/projects/${projectId}/commands`, ownerToken, commandBody("history_edit", 2, [
      { type: "script.updateBeat", beatId: "beat_02", patch: { narration: "Protected narration." } },
    ]));
    expect(edit.status).toBe(200);

    await expectDenied(await post(`/api/projects/${projectId}/undo`, beatCapability, {
      idempotencyKey: "idempotency_denied_undo",
      baseRevision: 3,
    }), "beat_02");
    expect(valueOf(await room.getHydration()).project.revision).toBe(3);

    expect((await post(`/api/projects/${projectId}/undo`, ownerToken, {
      idempotencyKey: "idempotency_owner_undo",
      baseRevision: 3,
    })).status).toBe(200);

    await expectDenied(await post(`/api/projects/${projectId}/redo`, beatCapability, {
      idempotencyKey: "idempotency_denied_redo",
      baseRevision: 4,
    }), "beat_02");
    expect(valueOf(await room.getHydration()).project.revision).toBe(4);

    expect((await post(`/api/projects/${projectId}/redo`, ownerToken, {
      idempotencyKey: "idempotency_owner_redo",
      baseRevision: 4,
    })).status).toBe(200);

    expect((await post(`/api/projects/${projectId}/checkpoints`, ownerToken, {
      checkpointId: "checkpoint_capability_test",
      idempotencyKey: "idempotency_checkpoint_create",
      baseRevision: 5,
      label: "Protected narration",
    })).status).toBe(201);

    expect((await post(`/api/projects/${projectId}/commands`, ownerToken, commandBody("temporary_edit", 6, [
      { type: "script.updateBeat", beatId: "beat_02", patch: { narration: "Temporary narration." } },
    ]))).status).toBe(200);

    await expectDenied(await post(
      `/api/projects/${projectId}/checkpoints/checkpoint_capability_test/restore`,
      beatCapability,
      { idempotencyKey: "idempotency_denied_restore", baseRevision: 7 },
    ), "beat_02");
    expect(valueOf(await room.getHydration()).project.revision).toBe(7);

    expect((await post(
      `/api/projects/${projectId}/checkpoints/checkpoint_capability_test/restore`,
      ownerToken,
      { idempotencyKey: "idempotency_owner_restore", baseRevision: 7 },
    )).status).toBe(200);

    const current = valueOf(await room.getHydration()).project;
    const restoreSnapshot: ProductionProject = structuredClone(current);
    restoreSnapshot.metadata.tagline = "Nested restore must still be authorized";
    const stageCapability = await capability(["stage:script"]);
    await expectDenied(await post(`/api/projects/${projectId}/commands`, stageCapability, commandBody("nested_restore", 8, [
      { type: "project.restore", snapshot: restoreSnapshot },
    ])), "stage:script");
    expect(valueOf(await room.getHydration()).project.revision).toBe(8);

    const timelineCapability = await capability(["timeline_main"]);
    await expectDenied(await post(`/api/projects/${projectId}/commands`, timelineCapability, commandBody("implicit_timeline", 8, [
      { type: "script.updateBeat", beatId: "beat_01", patch: { title: "This also touches timeline metadata" } },
    ])), "timeline_main");
    expect(valueOf(await room.getHydration()).project.revision).toBe(8);

    const ownerMutation = await post(`/api/projects/${projectId}/commands`, ownerToken, commandBody("owner_allowed", 8, [
      { type: "script.updateBeat", beatId: "beat_01", patch: { title: "Owner remains authoritative" } },
    ]));
    expect(ownerMutation.status).toBe(200);
    expect(valueOf(await room.getHydration()).project.revision).toBe(9);
  });
});

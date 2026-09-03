/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createSeedProject } from "@praxis/project-schema";
import { ProjectCommandSchema, type ProjectActor, type ProjectOperation } from "@praxis/commands";
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type ProjectRoomRpc, type RoomResult, ProjectRoom } from "../src/project-room";

const director = { kind: "director" as const, sessionId: "session_test_director" };
const codex = { kind: "codex" as const, sessionId: "session_test_codex" };
let roomName: string;

beforeEach(() => {
  roomName = `project-room-${crypto.randomUUID()}`;
});

const roomHandle = () => {
  const stub = env.PROJECT_ROOMS.getByName(roomName);
  return { stub, room: stub as unknown as ProjectRoomRpc };
};

const valueOf = <T>(result: RoomResult<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const command = (
  name: string,
  baseRevision: number,
  operations: ProjectOperation[],
  actor: ProjectActor = director,
  idempotencyKey = `idempotency_${name}`,
) =>
  ProjectCommandSchema.parse({
    commandId: `command_${name}`,
    idempotencyKey,
    projectId: "project_fax_oracle",
    baseRevision,
    actor,
    reason: `Worker-pool test ${name}`,
    createdAt: "2026-08-26T18:00:00.000Z",
    operations,
  });

const initialize = async () => {
  const handle = roomHandle();
  return { ...handle, hydration: valueOf(await handle.room.initialize(createSeedProject())) };
};

describe("ProjectRoom persistence and command semantics", () => {
  it("initializes migrations idempotently and survives Durable Object eviction", async () => {
    const { stub, room, hydration } = await initialize();
    expect(hydration.project.revision).toBe(1);
    expect(hydration.checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual(["checkpoint_seed"]);

    const secondInitialize = valueOf(await room.initialize(createSeedProject()));
    expect(secondInitialize.project.revision).toBe(1);
    expect(secondInitialize.checkpoints).toHaveLength(1);

    const applied = valueOf(
      await room.applyCommand(
        command("persisted_status", 1, [
          { type: "scene.setStatus", sceneId: "scene_01", status: "draft" },
        ]),
      ),
    );
    expect(applied.revision).toBe(2);

    await evictDurableObject(stub);
    const reloaded = valueOf(await roomHandle().room.getHydration());
    expect(reloaded.project.revision).toBe(2);
    expect(reloaded.project.scenes.find((scene) => scene.meta.id === "scene_01")?.meta.status).toBe("draft");
    expect(reloaded.history.entries).toHaveLength(1);
    expect(reloaded.checkpoints).toHaveLength(1);

    const counts = await runInDurableObject(roomHandle().stub, (_instance: ProjectRoom, state) => ({
      migrations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _sql_schema_migrations").one().count,
      projects: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM project_state").one().count,
      budgets: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM budget_state").one().count,
      checkpoints: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM checkpoints").one().count,
    }));
    expect(counts).toEqual({ migrations: 3, projects: 1, budgets: 1, checkpoints: 1 });
  });

  it("commits a command exactly once, replays its idempotent result, and reports stale conflicts", async () => {
    const { room } = await initialize();
    const original = command("idempotent_edit", 1, [
      { type: "script.updateBeat", beatId: "beat_01", patch: { title: "A revised premise" } },
    ]);

    const first = valueOf(await room.applyCommand(original));
    const replay = valueOf(await room.applyCommand(original));
    expect(first.revision).toBe(2);
    expect(replay).toMatchObject({
      revision: 2,
      eventSequence: first.eventSequence,
      idempotentReplay: true,
    });
    expect(replay.project).toEqual(first.project);

    const reusedKey = await room.applyCommand(
      command(
        "different_request",
        2,
        [{ type: "scene.setStatus", sceneId: "scene_02", status: "draft" }],
        director,
        original.idempotencyKey,
      ),
    );
    expect(reusedKey).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "IDEMPOTENCY_KEY_REUSED" },
    });

    const stale = await room.applyCommand(
      command("stale_edit", 1, [
        { type: "scene.setStatus", sceneId: "scene_02", status: "draft" },
      ]),
    );
    expect(stale).toMatchObject({
      ok: false,
      status: 409,
      error: {
        code: "REVISION_CONFLICT",
        expectedRevision: 1,
        currentRevision: 2,
        lockedEntityIds: [],
      },
    });
    if (stale.ok) throw new Error("Expected a revision conflict");
    expect(stale.error.changedEntityIds).toContain("beat_01");

    const hydration = valueOf(await room.getHydration());
    expect(hydration.project.revision).toBe(2);
    expect(hydration.history.entries).toHaveLength(1);
    expect(hydration.latestEventSequence).toBe(first.eventSequence);
  });

  it("rolls back the whole batch when a later operation hits a director lock", async () => {
    const { stub, room } = await initialize();
    const failed = await room.applyCommand(
      command(
        "atomic_locked_batch",
        1,
        [
          { type: "script.updateBeat", beatId: "beat_01", patch: { title: "Must not persist" } },
          { type: "scene.setStatus", sceneId: "scene_03", status: "draft" },
        ],
        codex,
      ),
    );
    expect(failed).toMatchObject({
      ok: false,
      status: 423,
      error: { code: "ENTITY_LOCKED", entityId: "scene_03", lockedEntityIds: ["scene_03"] },
    });

    const hydration = valueOf(await room.getHydration());
    expect(hydration.project.revision).toBe(1);
    expect(hydration.project.script.beats[0]?.title).toBe("The premise");
    expect(hydration.history.entries).toHaveLength(0);
    expect(hydration.latestEventSequence).toBe(0);

    const counts = await runInDurableObject(stub, (_instance: ProjectRoom, state) => ({
      operations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one().count,
      events: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count,
    }));
    expect(counts).toEqual({ operations: 0, events: 0 });
  });

  it("persists undo and redo stacks across evictions without double-applying", async () => {
    const { stub, room } = await initialize();
    const originalNarration = createSeedProject().script.beats[1]!.narration;
    const editedNarration = "The relay answers eleven minutes early.";
    valueOf(
      await room.applyCommand(
        command("history_edit", 1, [
          { type: "script.updateBeat", beatId: "beat_02", patch: { narration: editedNarration } },
        ]),
      ),
    );

    await evictDurableObject(stub);
    const afterUndo = valueOf(
      await roomHandle().room.undo({
        commandId: "command_history_undo",
        idempotencyKey: "idempotency_history_undo",
        baseRevision: 2,
        actor: director,
      }),
    );
    expect(afterUndo.revision).toBe(3);
    expect(afterUndo.project.script.beats[1]?.narration).toBe(originalNarration);

    const undoReplay = valueOf(
      await roomHandle().room.undo({
        commandId: "command_history_undo",
        idempotencyKey: "idempotency_history_undo",
        baseRevision: 2,
        actor: director,
      }),
    );
    expect(undoReplay).toMatchObject({ revision: 3, idempotentReplay: true });

    await evictDurableObject(roomHandle().stub);
    const beforeRedo = valueOf(await roomHandle().room.getHydration());
    expect(beforeRedo.history).toMatchObject({ canUndo: false, canRedo: true });
    const afterRedo = valueOf(
      await roomHandle().room.redo({
        commandId: "command_history_redo",
        idempotencyKey: "idempotency_history_redo",
        baseRevision: 3,
        actor: director,
      }),
    );
    expect(afterRedo.revision).toBe(4);
    expect(afterRedo.project.script.beats[1]?.narration).toBe(editedNarration);
    const finalHydration = valueOf(await roomHandle().room.getHydration());
    expect(finalHydration.history).toMatchObject({ canUndo: true, canRedo: false });
    expect(finalHydration.history.entries).toHaveLength(1);
  });

  it("honors checkpoint base revisions and restores both persisted and seeded checkpoints after eviction", async () => {
    const { stub, room } = await initialize();
    const originalNarration = createSeedProject().script.beats[1]!.narration;

    const staleCreate = await room.createCheckpoint({
      checkpointId: "checkpoint_stale",
      commandId: "command_checkpoint_stale",
      idempotencyKey: "idempotency_checkpoint_stale",
      baseRevision: 0,
      label: "Must not exist",
      actor: director,
    });
    expect(staleCreate).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "REVISION_CONFLICT", expectedRevision: 0, currentRevision: 1 },
    });
    expect(valueOf(await room.getHydration()).checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual(["checkpoint_seed"]);

    valueOf(
      await room.applyCommand(
        command("checkpoint_first_edit", 1, [
          { type: "script.updateBeat", beatId: "beat_02", patch: { narration: "First checkpointed narration." } },
        ]),
      ),
    );
    const createInput = {
      checkpointId: "checkpoint_custom",
      commandId: "command_checkpoint_custom",
      idempotencyKey: "idempotency_checkpoint_custom",
      baseRevision: 2,
      label: "First narration",
      reason: "Persist a known edit",
      actor: director,
    };
    const created = valueOf(await room.createCheckpoint(createInput));
    expect(created).toMatchObject({ revision: 3, checkpointId: "checkpoint_custom", idempotentReplay: false });
    expect(valueOf(await room.createCheckpoint(createInput))).toMatchObject({ revision: 3, idempotentReplay: true });

    valueOf(
      await room.applyCommand(
        command("checkpoint_second_edit", 3, [
          { type: "script.updateBeat", beatId: "beat_02", patch: { narration: "Second, temporary narration." } },
        ]),
      ),
    );
    await evictDurableObject(stub);

    const restoredCustom = valueOf(
      await roomHandle().room.restoreCheckpoint({
        checkpointId: "checkpoint_custom",
        commandId: "command_restore_custom",
        idempotencyKey: "idempotency_restore_custom",
        baseRevision: 4,
        actor: director,
      }),
    );
    expect(restoredCustom.revision).toBe(5);
    expect(restoredCustom.project.script.beats[1]?.narration).toBe("First checkpointed narration.");

    await evictDurableObject(roomHandle().stub);
    const restoredSeed = valueOf(
      await roomHandle().room.restoreCheckpoint({
        checkpointId: "checkpoint_seed",
        commandId: "command_restore_seed",
        idempotencyKey: "idempotency_restore_seed",
        baseRevision: 5,
        actor: director,
      }),
    );
    expect(restoredSeed.revision).toBe(6);
    expect(restoredSeed.project.script.beats[1]?.narration).toBe(originalNarration);

    const finalHydration = valueOf(await roomHandle().room.getHydration());
    expect(finalHydration.checkpoints.map((checkpoint) => checkpoint.checkpointId).sort()).toEqual([
      "checkpoint_custom",
      "checkpoint_seed",
    ]);
    const events = await runInDurableObject(roomHandle().stub, (instance: ProjectRoom) => instance.getEvents(0));
    expect(events.at(-1)).toMatchObject({ type: "project.restored", checkpointId: "checkpoint_seed", revision: 6 });
  });

  it("retrieves an immutable render record by ID after eviction", async () => {
    const { stub, room } = await initialize();
    expect(await room.getRender("render_missing")).toMatchObject({
      ok: false,
      status: 404,
      error: { code: "RENDER_NOT_FOUND" },
    });
    const record = {
      renderId: "render_lookup",
      projectId: "project_fax_oracle",
      jobId: "job_render_lookup",
      projectRevision: 1,
      manifestHash: "a".repeat(64),
      manifestObjectKey: "projects/project_fax_oracle/renders/1/render_lookup.manifest.json",
      outputObjectKey: "projects/project_fax_oracle/renders/1/render_lookup.mp4",
      posterObjectKey: "projects/project_fax_oracle/renders/1/render_lookup.jpg",
      sha256: "b".repeat(64),
      byteLength: 1024,
      width: 1920,
      height: 1080,
      durationMs: 25_000,
      videoCodec: "h264" as const,
      audioCodec: "aac" as const,
      pixelFormat: "yuv420p" as const,
      outdated: false,
      createdAt: "2026-08-26T18:30:00.000Z",
    };
    valueOf(await room.recordRender(record));

    await evictDurableObject(stub);
    expect(valueOf(await roomHandle().room.getRender(record.renderId))).toEqual(record);
  });
});

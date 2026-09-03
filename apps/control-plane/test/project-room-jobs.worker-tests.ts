/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { ProductionProjectSchema, createSeedProject } from "@praxis/project-schema";
import type { JobRecord } from "@praxis/jobs";
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ProjectRoom,
  type FinalizeMediaJobInput,
  type FinalizeRenderJobInput,
  type ProjectRoomRpc,
  type RoomResult,
} from "../src/project-room";
import { mediaCancellationSettlement } from "../src/workflow";

const actor = {
  kind: "codex" as const,
  id: "codex_media_test",
};
let roomName: string;

beforeEach(() => {
  roomName = `project-room-jobs-${crypto.randomUUID()}`;
});

const valueOf = <T>(result: RoomResult<T>): T => {
  if (!result.ok) throw new Error(`${result.status} ${result.error.code}: ${result.error.message}`);
  return result.value;
};

const roomHandle = () => {
  const stub = env.PROJECT_ROOMS.getByName(roomName);
  return { stub, room: stub as unknown as ProjectRoomRpc };
};

const initialize = async (maxSpendUsd = 1) => {
  const project = createSeedProject();
  project.delegation.assets.maxSpendUsd = maxSpendUsd;
  const handle = roomHandle();
  valueOf(await handle.room.initialize(ProductionProjectSchema.parse(project)));
  return handle;
};

const imageJob = (name: string, overrides: Record<string, unknown> = {}) => ({
  jobId: `job_${name}`,
  jobType: "image.generate" as const,
  idempotencyKey: `idempotency_job_${name}`,
  baseRevision: 1,
  targetEntityIds: ["scene_01", "asset_scene_01"],
  request: {
    assetId: "asset_scene_01",
    sceneId: "scene_01",
    prompt: `Generate image ${name}`,
    provider: "openai" as const,
    quality: "low" as const,
  },
  ...overrides,
});

const renderJob = (name: string) => ({
  jobId: `job_${name}`,
  jobType: "render.preview" as const,
  idempotencyKey: `idempotency_job_${name}`,
  baseRevision: 1,
  targetEntityIds: [],
  request: { rendererVersion: "praxis-test-renderer-1" },
});

const mediaFinalization = (
  job: JobRecord,
  options: { command?: boolean; select?: boolean } = {},
): FinalizeMediaJobInput => {
  const includeCommand = options.command ?? true;
  const select = options.select ?? true;
  const assetVersionId = `version_${job.jobId}`;
  const sha256 = "e".repeat(64);
  const objectKey = `projects/project_fax_oracle/assets/sha256/${sha256}.png`;
  const asset = {
    assetId: "asset_scene_01",
    assetVersionId,
    projectId: "project_fax_oracle",
    kind: "image" as const,
    objectKey,
    sha256,
    mimeType: "image/png",
    byteLength: 4_096,
    width: 1_536,
    height: 1_024,
    provenance: {
      projectRevision: job.baseRevision,
      jobId: job.jobId,
      provider: "openai",
      model: "gpt-image-test",
      sourceHash: "f".repeat(64),
    },
    createdAt: job.createdAt,
  };
  const input: FinalizeMediaJobInput = {
    jobId: job.jobId,
    expectedStatuses: ["running", "waiting_external"],
    output: {
      assetId: asset.assetId,
      assetVersionId,
      objectKey,
      sha256,
      mimeType: asset.mimeType,
      byteLength: asset.byteLength,
      width: asset.width,
      height: asset.height,
      attached: false,
      stale: true,
      projectRevision: job.baseRevision,
      metadata: { provider: "openai", model: "gpt-image-test", sourceHash: "f".repeat(64) },
    },
    asset,
    actualCostUsd: 0.009,
    costIsEstimate: false,
  };
  if (includeCommand) {
    input.command = {
      commandId: `command_${job.jobId}`,
      idempotencyKey: `asset-commit:${job.jobId}`,
      projectId: "project_fax_oracle",
      baseRevision: 1,
      actor: { kind: "system", sessionId: "system_media_workflow" },
      reason: `Attach media output from ${job.jobId}`,
      createdAt: job.createdAt,
      dryRun: false,
      operations: [
        {
          type: "asset.addVersion",
          assetId: asset.assetId,
          version: {
            id: assetVersionId,
            version: 2,
            status: select ? "ready" : "stale",
            uri: `/api/projects/project_fax_oracle/assets/${assetVersionId}/access`,
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            createdAt: job.createdAt,
            provider: "openai",
            model: "gpt-image-test",
            checksum: sha256,
            objectKey,
            sha256,
            byteLength: asset.byteLength,
            provenance: { projectRevision: job.baseRevision, jobId: job.jobId, sourceAssetVersionIds: [] },
          },
        },
        ...(select ? [{ type: "asset.selectVersion" as const, assetId: asset.assetId, versionId: assetVersionId }] : []),
      ],
    };
  }
  return input;
};

const renderFinalization = (jobId: string): FinalizeRenderJobInput => {
  const renderId = `render_${jobId}`;
  const manifestHash = "c".repeat(64);
  const videoSha256 = "a".repeat(64);
  const posterSha256 = "b".repeat(64);
  const videoObjectKey = `projects/project_fax_oracle/renders/1/${renderId}.mp4`;
  const posterObjectKey = `projects/project_fax_oracle/renders/1/${renderId}.jpg`;
  const createdAt = "2026-08-26T20:00:00.000Z";
  const provenance = {
    projectRevision: 1,
    jobId,
    renderer: "praxis-test-renderer-1",
    manifestSha256: manifestHash,
  };
  return {
    jobId,
    expectedStatuses: ["running", "waiting_external"],
    output: {
      assetId: renderId,
      assetVersionId: `version_${renderId}`,
      renderId,
      objectKey: videoObjectKey,
      posterObjectKey,
      sha256: videoSha256,
      posterSha256,
      mimeType: "video/mp4",
      byteLength: 12_345,
      width: 1_920,
      height: 1_080,
      durationMs: 10_000,
      attached: true,
      stale: false,
      projectRevision: 1,
      metadata: {
        manifestSha256: manifestHash,
        videoCodec: "h264",
        audioCodec: "aac",
        pixelFormat: "yuv420p",
      },
    },
    videoAsset: {
      assetId: renderId,
      assetVersionId: `version_${renderId}`,
      projectId: "project_fax_oracle",
      kind: "render",
      objectKey: videoObjectKey,
      sha256: videoSha256,
      mimeType: "video/mp4",
      byteLength: 12_345,
      width: 1_920,
      height: 1_080,
      durationMs: 10_000,
      provenance,
      createdAt,
    },
    posterAsset: {
      assetId: `${renderId}_poster`,
      assetVersionId: `version_${renderId}_poster`,
      projectId: "project_fax_oracle",
      kind: "poster",
      objectKey: posterObjectKey,
      sha256: posterSha256,
      mimeType: "image/jpeg",
      byteLength: 2_345,
      width: 1_920,
      height: 1_080,
      provenance,
      createdAt,
    },
    render: {
      renderId,
      projectId: "project_fax_oracle",
      jobId,
      projectRevision: 1,
      manifestHash,
      manifestObjectKey: `projects/project_fax_oracle/render-manifests/sha256/${manifestHash}.json`,
      outputObjectKey: videoObjectKey,
      posterObjectKey,
      sha256: videoSha256,
      byteLength: 12_345,
      width: 1_920,
      height: 1_080,
      durationMs: 10_000,
      videoCodec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
      outdated: false,
      createdAt,
    },
    actualCostUsd: 0.004,
    costIsEstimate: false,
  };
};

describe("ProjectRoom durable job accounting", () => {
  it("charges no cancellation cost before dispatch and conservatively estimates after dispatch", () => {
    expect(mediaCancellationSettlement(false, 0.013)).toEqual({
      actualCostUsd: 0,
      costIsEstimate: false,
    });
    expect(mediaCancellationSettlement(true, 0.013)).toEqual({
      actualCostUsd: 0.013,
      costIsEstimate: true,
    });
  });

  it("reserves budget atomically, replays duplicate requests, and rejects over-budget work", async () => {
    const { stub, room } = await initialize(0.015);
    const request = imageJob("reserve_once");
    const first = valueOf(await room.createJob(request, actor));
    expect(first).toMatchObject({
      idempotentReplay: false,
      job: { status: "queued", estimatedCostUsd: 0.013, reservedCostUsd: 0.013, settledCostUsd: 0 },
    });

    const replay = valueOf(await room.createJob(request, actor));
    expect(replay).toMatchObject({
      idempotentReplay: true,
      eventSequence: first.eventSequence,
      job: { jobId: first.job.jobId, reservedCostUsd: 0.013 },
    });

    const overBudget = await room.createJob(imageJob("over_budget"), actor);
    expect(overBudget).toMatchObject({
      ok: false,
      status: 402,
      error: { code: "BUDGET_EXCEEDED" },
    });

    const hydration = valueOf(await room.getHydration());
    expect(hydration.jobs).toHaveLength(1);
    expect(hydration.budget).toEqual({
      maxSpendUsd: 0.015,
      reservedUsd: 0.013,
      settledUsd: 0,
      availableUsd: 0.002,
    });
    const counts = await runInDurableObject(stub, (_instance: ProjectRoom, state) => ({
      jobs: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM jobs").one().count,
      events: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count,
    }));
    expect(counts).toEqual({ jobs: 1, events: 1 });
  });

  it("settles successful work once, releases the reservation, and keeps terminal jobs terminal", async () => {
    const { room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("settle_success"), actor)).job;
    const running = valueOf(
      await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }),
    );
    expect(running.job).toMatchObject({ status: "running", attempt: 1, reservedCostUsd: 0.013 });

    const transition = {
      expectedStatuses: ["running"],
      status: "succeeded" as const,
      actualCostUsd: 0.009,
      costIsEstimate: false,
    };
    const succeeded = valueOf(await room.transitionJob(created.jobId, transition));
    expect(succeeded.job).toMatchObject({
      status: "succeeded",
      reservedCostUsd: 0,
      settledCostUsd: 0.009,
      costIsEstimate: false,
    });

    const replay = valueOf(await room.transitionJob(created.jobId, transition));
    expect(replay.job).toEqual(succeeded.job);
    expect(replay.eventSequence).toBe(succeeded.eventSequence);
    const hydration = valueOf(await room.getHydration());
    expect(hydration.budget).toMatchObject({ reservedUsd: 0, settledUsd: 0.009, availableUsd: 0.991 });
    expect(hydration.latestEventSequence).toBe(3);

    const reopened = await room.transitionJob(created.jobId, {
      expectedStatuses: ["succeeded"],
      status: "running",
    });
    expect(reopened).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "JOB_STATE_CONFLICT" },
    });
  });

  it("replays a committed nonterminal claim without incrementing its attempt or emitting twice", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("claim_replay"), actor)).job;
    const claim = { expectedStatuses: ["queued" as const], status: "running" as const };

    const first = valueOf(await room.transitionJob(created.jobId, claim));
    const replay = valueOf(await room.transitionJob(created.jobId, claim));
    expect(replay.job).toEqual(first.job);
    expect(replay.job.attempt).toBe(1);
    expect(replay.eventSequence).toBe(first.eventSequence);

    expect(await room.transitionJob(created.jobId, { ...claim, attempt: 2 })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "JOB_STATE_CONFLICT" },
    });
    const events = await runInDurableObject(stub, (_instance: ProjectRoom, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count,
    );
    expect(events).toBe(2);
  });

  it("releases unused reservation on failure while retaining a known incurred cost", async () => {
    const { room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("settle_failure"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const failed = valueOf(
      await room.transitionJob(created.jobId, {
        expectedStatuses: ["running"],
        status: "failed",
        actualCostUsd: 0.003,
        costIsEstimate: false,
        errorCode: "PROVIDER_FAILED",
        errorMessage: "Provider charged before returning an error",
      }),
    );
    expect(failed.job).toMatchObject({
      status: "failed",
      reservedCostUsd: 0,
      settledCostUsd: 0.003,
      errorCode: "PROVIDER_FAILED",
    });
    expect(valueOf(await room.getHydration()).budget).toMatchObject({
      reservedUsd: 0,
      settledUsd: 0.003,
      availableUsd: 0.997,
    });
  });

  it("makes cancellation requests idempotent and settles cancellation exactly once", async () => {
    const { room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("cancel_once"), actor)).job;

    const requested = valueOf(await room.cancelJob(created.jobId));
    expect(requested.job).toMatchObject({ status: "cancel_requested", reservedCostUsd: 0.013 });
    const requestReplay = valueOf(await room.cancelJob(created.jobId));
    expect(requestReplay.job).toEqual(requested.job);
    expect(requestReplay.eventSequence).toBe(requested.eventSequence);

    const cancelled = valueOf(
      await room.transitionJob(created.jobId, {
        expectedStatuses: ["cancel_requested"],
        status: "cancelled",
        actualCostUsd: 0.002,
        costIsEstimate: false,
        errorCode: "CANCELLED",
      }),
    );
    expect(cancelled.job).toMatchObject({
      status: "cancelled",
      reservedCostUsd: 0,
      settledCostUsd: 0.002,
    });

    const terminalReplay = valueOf(await room.cancelJob(created.jobId));
    expect(terminalReplay.job).toEqual(cancelled.job);
    expect(terminalReplay.eventSequence).toBe(cancelled.eventSequence);
    const hydration = valueOf(await room.getHydration());
    expect(hydration.budget).toMatchObject({ reservedUsd: 0, settledUsd: 0.002, availableUsd: 0.998 });
    expect(hydration.latestEventSequence).toBe(3);
  });

  it("reconciliation honors cancellation grace and preserves estimated media cost after provider dispatch", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("cancel_reconcile_dispatched"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["running"], status: "waiting_external" }));
    valueOf(await room.cancelJob(created.jobId));

    await runInDurableObject(stub, async (instance: ProjectRoom) => instance.alarm());
    expect(valueOf(await room.getJob(created.jobId))).toMatchObject({
      status: "cancel_requested",
      reservedCostUsd: 0.013,
      settledCostUsd: 0,
    });

    await runInDurableObject(stub, async (instance: ProjectRoom, state) => {
      state.storage.sql.exec(
        "UPDATE jobs SET cancel_requested_at = ? WHERE job_id = ?",
        "2020-01-01T00:00:00.000Z",
        created.jobId,
      );
      await instance.alarm();
    });
    expect(valueOf(await room.getJob(created.jobId))).toMatchObject({
      status: "cancelled",
      reservedCostUsd: 0,
      settledCostUsd: 0.013,
      costIsEstimate: true,
    });
    expect(valueOf(await room.getHydration()).budget).toMatchObject({
      reservedUsd: 0,
      settledUsd: 0.013,
      availableUsd: 0.987,
    });
  });

  it("persists a deterministic Workflow ID across ambiguous creation and never infers failure from lookup errors", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("workflow_create_ambiguous"), actor)).job;
    await runInDurableObject(stub, async (instance: ProjectRoom) => {
      const exposed = instance as unknown as { bindings: Record<string, unknown> };
      exposed.bindings = {
        ...exposed.bindings,
        MEDIA_WORKFLOW: {
          get: async () => { throw new Error("status temporarily unavailable"); },
          create: async () => { throw new Error("create response was lost"); },
        },
      };
      await instance.alarm();
      await instance.alarm();
      await instance.alarm();
      await instance.alarm();
    });

    expect(valueOf(await room.getJob(created.jobId))).toMatchObject({
      status: "queued",
      workflowId: expect.stringMatching(/^praxis_/),
    });
  });

  it("settles definitive Workflow failure conservatively but keeps unknown work finalizable", async () => {
    const failedHandle = await initialize();
    const failed = valueOf(await failedHandle.room.createJob(imageJob("workflow_definitive_error"), actor)).job;
    valueOf(await failedHandle.room.transitionJob(failed.jobId, { expectedStatuses: ["queued"], status: "running" }));
    valueOf(await failedHandle.room.transitionJob(failed.jobId, { expectedStatuses: ["running"], status: "waiting_external" }));
    valueOf(await failedHandle.room.attachWorkflow(failed.jobId, "workflow_definitive_error"));
    await runInDurableObject(failedHandle.stub, async (instance: ProjectRoom) => {
      const exposed = instance as unknown as { bindings: Record<string, unknown> };
      exposed.bindings = {
        ...exposed.bindings,
        MEDIA_WORKFLOW: {
          get: async (id: string) => ({
            id,
            status: async () => ({ status: "errored" }),
            terminate: async () => undefined,
          }),
        },
      };
      await instance.alarm();
    });
    expect(valueOf(await failedHandle.room.getJob(failed.jobId))).toMatchObject({
      status: "failed",
      settledCostUsd: 0.013,
      costIsEstimate: true,
      errorCode: "WORKFLOW_ERRORED",
    });

    roomName = `project-room-jobs-${crypto.randomUUID()}`;
    const unknownHandle = await initialize();
    const unknown = valueOf(await unknownHandle.room.createJob(imageJob("workflow_unknown_then_finalize"), actor)).job;
    valueOf(await unknownHandle.room.transitionJob(unknown.jobId, { expectedStatuses: ["queued"], status: "running" }));
    valueOf(await unknownHandle.room.transitionJob(unknown.jobId, { expectedStatuses: ["running"], status: "waiting_external" }));
    valueOf(await unknownHandle.room.attachWorkflow(unknown.jobId, "workflow_unknown_then_finalize"));
    await runInDurableObject(unknownHandle.stub, async (instance: ProjectRoom) => {
      const exposed = instance as unknown as { bindings: Record<string, unknown> };
      exposed.bindings = {
        ...exposed.bindings,
        MEDIA_WORKFLOW: {
          get: async (id: string) => ({
            id,
            status: async () => ({ status: "unknown" }),
            terminate: async () => undefined,
          }),
        },
      };
      await instance.alarm();
      await instance.alarm();
      await instance.alarm();
      await instance.alarm();
    });
    expect(valueOf(await unknownHandle.room.getJob(unknown.jobId)).status).toBe("waiting_external");
    expect(valueOf(await unknownHandle.room.finalizeMediaJob(mediaFinalization(unknown)))).toMatchObject({
      job: { status: "succeeded" },
    });
  });
});

describe("ProjectRoom atomic media finalization", () => {
  it("commits the system attachment command, asset record, settlement, and job success atomically", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("media_finalize_success"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const input = mediaFinalization(created);

    const finalized = valueOf(await room.finalizeMediaJob(input));
    expect(finalized).toMatchObject({
      idempotentReplay: false,
      eventSequence: 5,
      job: {
        status: "succeeded",
        reservedCostUsd: 0,
        settledCostUsd: 0.009,
        costIsEstimate: false,
        output: { assetVersionId: input.asset.assetVersionId, attached: true, stale: false },
      },
      asset: input.asset,
      command: { revision: 2, idempotentReplay: false },
    });
    const hydration = valueOf(await room.getHydration());
    expect(hydration.project.assets.asset_scene_01.currentVersionId).toBe(input.asset.assetVersionId);
    expect(hydration.project.assets.asset_scene_01.versions).toHaveLength(2);
    expect(hydration.history.entries).toHaveLength(1);
    expect(hydration.assets).toEqual([input.asset]);
    expect(hydration.budget).toMatchObject({ reservedUsd: 0, settledUsd: 0.009, availableUsd: 0.991 });
    const durable = await runInDurableObject(stub, (instance: ProjectRoom, state) => ({
      operations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one().count,
      assets: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM asset_records").one().count,
      events: instance.getEvents(0).map((event) => event.type),
    }));
    expect(durable).toEqual({
      operations: 1,
      assets: 1,
      events: ["job.updated", "job.updated", "project.committed", "asset.created", "job.updated"],
    });
  });

  it("replays the whole finalization without duplicating history, records, events, or settlement", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("media_finalize_replay"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const input = mediaFinalization(created);
    const first = valueOf(await room.finalizeMediaJob(input));
    const replay = valueOf(await room.finalizeMediaJob(input));

    expect(replay).toMatchObject({
      idempotentReplay: true,
      eventSequence: first.eventSequence,
      job: { status: "succeeded", settledCostUsd: 0.009, output: { attached: true, stale: false } },
      asset: input.asset,
      command: { revision: 2, idempotentReplay: true },
    });
    valueOf(await room.applyCommand({
      commandId: "command_select_previous_media_version",
      idempotencyKey: "idempotency_select_previous_media_version",
      projectId: "project_fax_oracle",
      baseRevision: 2,
      actor: { kind: "director", sessionId: "session_media_replay" },
      reason: "Select the previous media version",
      createdAt: "2026-08-26T20:03:00.000Z",
      operations: [{ type: "asset.selectVersion", assetId: "asset_scene_01", versionId: "asset_scene_01_v1" }],
    }));
    const staleReplay = valueOf(await room.finalizeMediaJob(input));
    expect(staleReplay).toMatchObject({
      idempotentReplay: true,
      eventSequence: first.eventSequence,
      job: { status: "succeeded", settledCostUsd: 0.009, output: { attached: false, stale: true } },
      command: { revision: 2, idempotentReplay: true },
    });
    const durable = await runInDurableObject(stub, (_instance: ProjectRoom, state) => ({
      finalizationOperations: state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations WHERE command_id = ?", input.command!.commandId)
        .one().count,
      assets: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM asset_records").one().count,
      events: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count,
    }));
    expect(durable).toEqual({ finalizationOperations: 1, assets: 1, events: 6 });
    expect(valueOf(await room.getHydration()).budget).toMatchObject({ reservedUsd: 0, settledUsd: 0.009 });
  });

  it("retains a completed provider output without attaching it when cancellation wins the race", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("media_finalize_cancelled"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    valueOf(await room.cancelJob(created.jobId));
    const input = mediaFinalization(created);

    const finalized = valueOf(await room.finalizeMediaJob(input));
    expect(finalized).toMatchObject({
      idempotentReplay: false,
      job: {
        status: "cancelled",
        reservedCostUsd: 0,
        settledCostUsd: 0.009,
        output: { assetVersionId: input.asset.assetVersionId, attached: false, stale: true },
      },
      asset: input.asset,
    });
    expect(finalized.command).toBeUndefined();
    expect(valueOf(await room.finalizeMediaJob(input))).toMatchObject({
      idempotentReplay: true,
      eventSequence: finalized.eventSequence,
      job: { status: "cancelled", settledCostUsd: 0.009 },
    });
    const hydration = valueOf(await room.getHydration());
    expect(hydration.project.revision).toBe(1);
    expect(hydration.history.entries).toEqual([]);
    expect(hydration.assets).toEqual([input.asset]);
    expect(hydration.jobs[0]).toMatchObject({ status: "cancelled", reservedCostUsd: 0, settledCostUsd: 0.009 });
    expect(hydration.budget).toMatchObject({ reservedUsd: 0, settledUsd: 0.009 });
    const durable = await runInDurableObject(stub, (_instance: ProjectRoom, state) => ({
      operations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one().count,
      assets: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM asset_records").one().count,
      events: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count,
    }));
    expect(durable).toEqual({ operations: 0, assets: 1, events: 5 });
  });

  it("can succeed with an immutable but unattached stale output when no command is supplied", async () => {
    const { room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("media_finalize_unattached"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const input = mediaFinalization(created, { command: false });

    const finalized = valueOf(await room.finalizeMediaJob(input));
    expect(finalized).toMatchObject({
      idempotentReplay: false,
      job: { status: "succeeded", output: { attached: false, stale: true } },
      asset: input.asset,
    });
    expect(finalized.command).toBeUndefined();
    const hydration = valueOf(await room.getHydration());
    expect(hydration.project.revision).toBe(1);
    expect(hydration.project.assets.asset_scene_01.currentVersionId).toBe("asset_scene_01_v1");
    expect(hydration.assets).toEqual([input.asset]);
  });

  it("rejects a project revision race without committing the preflighted command or asset", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(imageJob("media_finalize_revision_race"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const input = mediaFinalization(created);
    valueOf(await room.applyCommand({
      commandId: "command_advance_before_media_finalize",
      idempotencyKey: "idempotency_advance_before_media_finalize",
      projectId: "project_fax_oracle",
      baseRevision: 1,
      actor: { kind: "director", sessionId: "session_media_race" },
      reason: "Advance project before media attach",
      createdAt: "2026-08-26T20:02:00.000Z",
      operations: [{ type: "scene.setStatus", sceneId: "scene_01", status: "draft" }],
    }));

    expect(await room.finalizeMediaJob(input)).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "REVISION_CONFLICT", expectedRevision: 1, currentRevision: 2 },
    });
    const hydration = valueOf(await room.getHydration());
    expect(hydration.project.revision).toBe(2);
    expect(hydration.assets).toEqual([]);
    expect(hydration.jobs[0]).toMatchObject({ status: "running", reservedCostUsd: 0.013, settledCostUsd: 0 });
    const durable = await runInDurableObject(stub, (_instance: ProjectRoom, state) => ({
      operations: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM operations").one().count,
      assets: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM asset_records").one().count,
    }));
    expect(durable).toEqual({ operations: 1, assets: 0 });
  });
});

describe("ProjectRoom atomic render finalization", () => {
  it("commits both assets, the render, job success, settlement, and events atomically", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(renderJob("finalize_success"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const input = renderFinalization(created.jobId);

    const finalized = valueOf(await room.finalizeRenderJob(input));
    expect(finalized).toMatchObject({
      idempotentReplay: false,
      eventSequence: 6,
      job: {
        status: "succeeded",
        reservedCostUsd: 0,
        settledCostUsd: 0.004,
        costIsEstimate: false,
        output: { renderId: input.render.renderId, stale: false },
      },
      videoAsset: input.videoAsset,
      posterAsset: input.posterAsset,
      render: { ...input.render, outdated: false },
    });

    const hydration = valueOf(await room.getHydration());
    expect(hydration.assets).toEqual([input.videoAsset, input.posterAsset]);
    expect(hydration.renders).toEqual([input.render]);
    expect(hydration.budget).toMatchObject({ reservedUsd: 0, settledUsd: 0.004, availableUsd: 0.996 });
    const durable = await runInDurableObject(stub, (instance: ProjectRoom, state) => ({
      assetCount: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM asset_records").one().count,
      renderCount: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM renders").one().count,
      events: instance.getEvents(0).map((event) => event.type),
    }));
    expect(durable).toEqual({
      assetCount: 2,
      renderCount: 1,
      events: ["job.updated", "job.updated", "asset.created", "asset.created", "render.ready", "job.updated"],
    });
  });

  it("replays exactly once and keeps job output stale synchronized when the render becomes outdated", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(renderJob("finalize_replay"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const input = renderFinalization(created.jobId);
    const first = valueOf(await room.finalizeRenderJob(input));

    valueOf(await room.applyCommand({
      commandId: "command_outdate_finalized_render",
      idempotencyKey: "idempotency_outdate_finalized_render",
      projectId: "project_fax_oracle",
      baseRevision: 1,
      actor: { kind: "director", sessionId: "session_render_test" },
      reason: "Advance project revision after render",
      createdAt: "2026-08-26T20:01:00.000Z",
      operations: [{ type: "scene.setStatus", sceneId: "scene_01", status: "draft" }],
    }));

    const replay = valueOf(await room.finalizeRenderJob(input));
    expect(replay).toMatchObject({
      idempotentReplay: true,
      eventSequence: first.eventSequence,
      job: { status: "succeeded", settledCostUsd: 0.004, output: { stale: true } },
      render: { renderId: input.render.renderId, outdated: true },
    });
    const durable = await runInDurableObject(stub, (_instance: ProjectRoom, state) => ({
      assets: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM asset_records").one().count,
      renders: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM renders").one().count,
      events: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count,
    }));
    expect(durable).toEqual({ assets: 2, renders: 1, events: 8 });
    expect(valueOf(await room.getHydration()).budget).toMatchObject({ reservedUsd: 0, settledUsd: 0.004 });
  });

  it("rejects a cancellation race without inserting or settling render records", async () => {
    const { stub, room } = await initialize();
    const created = valueOf(await room.createJob(renderJob("finalize_cancelled"), actor)).job;
    valueOf(await room.transitionJob(created.jobId, { expectedStatuses: ["queued"], status: "running" }));
    valueOf(await room.cancelJob(created.jobId));

    const rejected = await room.finalizeRenderJob(renderFinalization(created.jobId));
    expect(rejected).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "JOB_CANCEL_REQUESTED" },
    });
    const hydration = valueOf(await room.getHydration());
    expect(hydration.jobs[0]).toMatchObject({ status: "cancel_requested", settledCostUsd: 0 });
    expect(hydration.assets).toEqual([]);
    expect(hydration.renders).toEqual([]);
    const counts = await runInDurableObject(stub, (_instance: ProjectRoom, state) => ({
      assets: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM asset_records").one().count,
      renders: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM renders").one().count,
      events: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM events").one().count,
    }));
    expect(counts).toEqual({ assets: 0, renders: 0, events: 3 });
  });

  it("rejects conflicting immutable asset or render records before any new finalization write", async () => {
    const assetConflictHandle = await initialize();
    const assetJob = valueOf(await assetConflictHandle.room.createJob(renderJob("asset_conflict"), actor)).job;
    valueOf(await assetConflictHandle.room.transitionJob(assetJob.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const assetInput = renderFinalization(assetJob.jobId);
    valueOf(await assetConflictHandle.room.recordAsset({ ...assetInput.videoAsset, byteLength: assetInput.videoAsset.byteLength + 1 }));

    expect(await assetConflictHandle.room.finalizeRenderJob(assetInput)).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "ASSET_VERSION_IMMUTABLE" },
    });
    let hydration = valueOf(await assetConflictHandle.room.getHydration());
    expect(hydration.jobs[0]?.status).toBe("running");
    expect(hydration.assets).toHaveLength(1);
    expect(hydration.renders).toEqual([]);

    roomName = `project-room-jobs-${crypto.randomUUID()}`;
    const renderConflictHandle = await initialize();
    const renderJobRecord = valueOf(await renderConflictHandle.room.createJob(renderJob("render_conflict"), actor)).job;
    valueOf(await renderConflictHandle.room.transitionJob(renderJobRecord.jobId, { expectedStatuses: ["queued"], status: "running" }));
    const renderInput = renderFinalization(renderJobRecord.jobId);
    valueOf(await renderConflictHandle.room.recordRender({ ...renderInput.render, sha256: "d".repeat(64) }));

    expect(await renderConflictHandle.room.finalizeRenderJob(renderInput)).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "RENDER_IMMUTABLE" },
    });
    hydration = valueOf(await renderConflictHandle.room.getHydration());
    expect(hydration.jobs[0]?.status).toBe("running");
    expect(hydration.assets).toEqual([]);
    expect(hydration.renders).toHaveLength(1);
  });
});

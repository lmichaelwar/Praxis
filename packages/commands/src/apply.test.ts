import { describe, expect, it } from "vitest";
import { createEntityMeta, createSeedProject, type AssetVersion } from "@praxis/project-schema";
import { applyProjectCommand, createProjectCommand } from "./index";

const actor = { kind: "director" as const, sessionId: "session_test_director" };
const codex = { kind: "codex" as const, sessionId: "session_test_codex" };
const system = { kind: "system" as const, sessionId: "session_media_worker" };

const generatedVersion = (id: string, version: number, revision: number): AssetVersion => ({
  id,
  version,
  status: "approved",
  uri: `r2://praxis-media/projects/project_fax_oracle/${id}.png`,
  mimeType: "image/png",
  width: 1920,
  height: 1080,
  createdAt: "2026-08-26T18:00:00.000Z",
  provider: "openai",
  model: "gpt-image-1",
  prompt: "A content-addressed institutional corridor plate.",
  costUsd: 0.04,
  objectKey: `projects/project_fax_oracle/assets/${id}.png`,
  sha256: "b".repeat(64),
  byteLength: 128_000,
  provenance: {
    projectRevision: revision,
    jobId: "job_image_worker_01",
    sourceAssetVersionIds: [],
  },
});

describe("applyProjectCommand", () => {
  it("rejects stale base revisions with a structured conflict", () => {
    const project = createSeedProject();
    const command = createProjectCommand(
      project.projectId,
      project.revision - 1,
      [{ type: "script.updateBeat", beatId: "beat_01", patch: { narration: "Too late." } }],
      { actor, commandId: "command_stale_revision", idempotencyKey: "stale-revision-key" },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REVISION_CONFLICT");
      if (result.error.code === "REVISION_CONFLICT") {
        expect(result.error.currentRevision).toBe(project.revision);
        expect(result.error.changedEntities).toContain("scene_03");
      }
    }
  });

  it("preserves a locked scene and rolls the whole batch back", () => {
    const project = createSeedProject();
    const before = structuredClone(project);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        { type: "script.updateBeat", beatId: "beat_01", patch: { narration: "This must roll back." } },
        { type: "timeline.moveClip", clipId: "clip_scene_03", startFrame: 500 },
      ],
      { actor: codex, commandId: "command_locked_scene", idempotencyKey: "locked-scene-key" },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: "ENTITY_LOCKED", entityId: "scene_03" });
      expect(result.project).toEqual(before);
    }
    expect(project).toEqual(before);
  });

  it("treats a scene lock as protection for its linked script beat", () => {
    const project = createSeedProject();
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "script.updateBeat", beatId: "beat_03", patch: { narration: "Do not replace me." } }],
      { actor: codex, commandId: "command_locked_beat", idempotencyKey: "locked-beat-key" },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: "ENTITY_LOCKED", entityId: "scene_03" });
    }
  });

  it("rolls back earlier operations when a later operation violates an invariant", () => {
    const project = createSeedProject();
    const beforeNarration = project.script.beats[0]!.narration;
    const duplicate = structuredClone(project.timeline.tracks[0]!.clips[0]!);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        { type: "script.updateBeat", beatId: "beat_01", patch: { narration: "Uncommitted edit" } },
        { type: "timeline.insertClip", trackId: "track_video_01", clip: duplicate },
      ],
      { actor, commandId: "command_atomic_rollback", idempotencyKey: "atomic-rollback-key" },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(false);
    expect(project.script.beats[0]!.narration).toBe(beforeNarration);
    expect(project.timeline.tracks[0]!.clips).toHaveLength(5);
  });

  it("marks downstream derivatives stale without deleting or moving clips", () => {
    const project = createSeedProject();
    const beforeClip = structuredClone(project.timeline.tracks[0]!.clips[0]!);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "script.updateBeat", beatId: "beat_01", patch: { narration: "A revised question." } }],
      { actor, commandId: "command_invalidate", idempotencyKey: "downstream-invalidation-key" },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const clip = result.project.timeline.tracks[0]!.clips.find(
        (candidate) => candidate.meta.id === "clip_scene_01",
      )!;
      expect(clip.startFrame).toBe(beforeClip.startFrame);
      expect(clip.durationFrames).toBe(beforeClip.durationFrames);
      expect(clip.meta.status).toBe("stale");
      expect(result.project.timeline.tracks[0]!.clips).toHaveLength(5);
      expect(result.project.scenes[0]!.meta.status).toBe("stale");
      expect(result.project.assets.asset_scene_01!.meta.status).toBe("stale");
      expect(result.project.stages.finish.status).toBe("stale");
      expect(result.result.invalidatedEntityIds).toContain("clip_scene_01");
    }
  });

  it("authoritatively updates an unlocked scene plan and invalidates derivatives without changing placement", () => {
    const project = createSeedProject();
    const originalScene = structuredClone(project.scenes[0]!);
    const originalClip = structuredClone(project.timeline.tracks[0]!.clips[0]!);
    project.timeline.tracks[0]!.clips[0]!.meta.locked = true;
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{
        type: "scene.update",
        sceneId: "scene_01",
        patch: {
          title: "The corridor answers",
          narrativeRole: "Turn ordinary infrastructure into a quiet antagonist.",
          visualDescription: "A severe municipal corridor converges on the waiting fax machine.",
          shotIntent: "Hold long enough for the empty frame to feel expectant.",
          cameraLanguage: "Locked wide with a nearly invisible optical push.",
          estimatedDurationFrames: 165,
          heroMoment: true,
        },
      }],
      {
        actor: codex,
        commandId: "command_update_scene_plan",
        idempotencyKey: "update-scene-plan-key",
      },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const scene = result.project.scenes[0]!;
      const clip = result.project.timeline.tracks[0]!.clips[0]!;
      expect(scene).toMatchObject({
        title: "The corridor answers",
        estimatedDurationFrames: 165,
        heroMoment: true,
        meta: {
          locked: false,
          lastEditedBy: "codex",
          revisionUpdated: project.revision + 1,
        },
      });
      expect(scene.beatId).toBe(originalScene.beatId);
      expect(scene.order).toBe(originalScene.order);
      expect(result.project.stages.previz.status).toBe("active");
      expect(result.project.assets.asset_scene_01!.meta.status).toBe("stale");
      expect(clip).toMatchObject({
        startFrame: originalClip.startFrame,
        durationFrames: originalClip.durationFrames,
        sceneId: originalClip.sceneId,
        assetId: originalClip.assetId,
        meta: { locked: true, status: "stale" },
      });
      expect(result.result.affectedEntityIds).toContain("scene_01");
      expect(result.result.invalidatedEntityIds).toEqual(expect.arrayContaining([
        "asset_scene_01",
        "clip_scene_01",
        "stage:assets",
        "stage:edit",
        "stage:finish",
      ]));

      const restored = applyProjectCommand(result.project, result.inverseCommand);
      expect(restored.ok).toBe(true);
      if (restored.ok) {
        expect(restored.project.scenes[0]).toMatchObject({
          beatId: originalScene.beatId,
          order: originalScene.order,
          title: originalScene.title,
          narrativeRole: originalScene.narrativeRole,
          informationRole: originalScene.informationRole,
          visualDescription: originalScene.visualDescription,
          shotIntent: originalScene.shotIntent,
          cameraLanguage: originalScene.cameraLanguage,
          estimatedDurationFrames: originalScene.estimatedDurationFrames,
          requiredAssetIds: originalScene.requiredAssetIds,
          heroMoment: originalScene.heroMoment,
        });
      }
    }
    expect(project.scenes[0]).toEqual(originalScene);
  });

  it("rejects empty scene patches and duplicate required assets at the command boundary", () => {
    const project = createSeedProject();

    expect(() => createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "scene.update", sceneId: "scene_01", patch: {} }],
      {
        actor: codex,
        commandId: "command_empty_scene_patch",
        idempotencyKey: "empty-scene-patch-key",
      },
    )).toThrow(/Scene patch cannot be empty/);

    expect(() => createProjectCommand(
      project.projectId,
      project.revision,
      [{
        type: "scene.update",
        sceneId: "scene_01",
        patch: { requiredAssetIds: ["asset_scene_01", "asset_scene_01"] },
      }],
      {
        actor: codex,
        commandId: "command_duplicate_scene_assets",
        idempotencyKey: "duplicate-scene-assets-key",
      },
    )).toThrow(/required asset IDs must be unique/);
  });

  it("preserves a director-locked scene from scene-plan updates", () => {
    const project = createSeedProject();
    const before = structuredClone(project);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{
        type: "scene.update",
        sceneId: "scene_03",
        patch: { shotIntent: "Codex must not replace the locked hero shot." },
      }],
      {
        actor: codex,
        commandId: "command_update_locked_scene_plan",
        idempotencyKey: "update-locked-scene-key",
      },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "ENTITY_LOCKED",
        entityId: "scene_03",
        operationType: "scene.update",
      });
      expect(result.project).toEqual(before);
    }
    expect(project).toEqual(before);
  });

  it("rolls back a scene-plan patch that references an unknown required asset", () => {
    const project = createSeedProject();
    const before = structuredClone(project);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{
        type: "scene.update",
        sceneId: "scene_01",
        patch: { requiredAssetIds: ["asset_does_not_exist"] },
      }],
      {
        actor: codex,
        commandId: "command_invalid_scene_assets",
        idempotencyKey: "invalid-scene-assets-key",
      },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVARIANT_VIOLATION");
      expect(result.project).toEqual(before);
    }
    expect(project).toEqual(before);
  });

  it("supports insert, update, and move as one atomic timeline batch", () => {
    const project = createSeedProject();
    const clip = {
      meta: createEntityMeta("clip_inserted_card", project.revision, "director"),
      kind: "text" as const,
      name: "Inserted card",
      startFrame: 30,
      durationFrames: 45,
      sourceStartFrame: 0,
      versionPolicy: "pinned" as const,
      opacity: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    };
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        { type: "timeline.insertClip", trackId: "track_overlay_01", clip },
        { type: "timeline.updateClip", clipId: "clip_inserted_card", patch: { opacity: 0.8 } },
        { type: "timeline.moveClip", clipId: "clip_inserted_card", startFrame: 60 },
      ],
      { actor, commandId: "command_timeline_batch", idempotencyKey: "timeline-batch-key" },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const inserted = result.project.timeline.tracks[1]!.clips.find(
        (candidate) => candidate.meta.id === "clip_inserted_card",
      );
      expect(inserted).toMatchObject({ startFrame: 60, opacity: 0.8 });
      expect(result.project.revision).toBe(project.revision + 1);
    }
  });

  it("updates bounded text style and audio gain through timeline commands", () => {
    const project = createSeedProject();
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        {
          type: "timeline.updateClip",
          clipId: "clip_title_01",
          patch: { text: "ASK A BETTER QUESTION", textStyle: { color: "#E34832", fontSizePx: 92 } },
        },
        {
          type: "timeline.updateClip",
          clipId: "clip_music_01",
          patch: { gainDb: -14 },
        },
      ],
      { actor, commandId: "command_render_fields", idempotencyKey: "render-fields-key" },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const title = result.project.timeline.tracks[1]!.clips[0]!;
      const music = result.project.timeline.tracks[3]!.clips[0]!;
      expect(title.text).toBe("ASK A BETTER QUESTION");
      expect(title.textStyle).toMatchObject({
        color: "#E34832",
        fontSizePx: 92,
        fontFamily: "Roboto Condensed Variable",
      });
      expect(music.gainDb).toBe(-14);
    }
  });

  it("accepts a proposal by validating and applying its stored operations", () => {
    const project = createSeedProject();
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "proposal.accept", decisionId: "decision_tighten_ending" }],
      { actor, commandId: "command_accept_proposal", idempotencyKey: "accept-proposal-key" },
    );

    const result = applyProjectCommand(project, command);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.project.script.beats[4]!.narration).toBe("Ask a better question.");
      expect(result.project.decisions[0]!.status).toBe("accepted");
    }
  });

  it("creates an asset and commits then selects an immutable version atomically", () => {
    const project = createSeedProject();
    const version = generatedVersion("asset_generated_card_v1", 1, project.revision);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        {
          type: "asset.create",
          asset: {
            id: "asset_generated_card",
            kind: "image",
            name: "Generated answer card",
            derivedFrom: ["scene_05"],
            tags: ["generated", "end-card"],
          },
        },
        { type: "asset.addVersion", assetId: "asset_generated_card", version },
        {
          type: "asset.selectVersion",
          assetId: "asset_generated_card",
          versionId: version.id,
        },
      ],
      {
        actor: system,
        commandId: "command_commit_generated_asset",
        idempotencyKey: "commit-generated-asset-key",
      },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const asset = result.project.assets.asset_generated_card!;
      expect(asset.currentVersionId).toBe(version.id);
      expect(asset.meta).toMatchObject({
        authoredBy: "system",
        lastEditedBy: "system",
        generationJobId: "job_image_worker_01",
        status: "approved",
      });
      expect(asset.versions).toEqual([version]);
      expect(result.result.affectedEntityIds).toEqual(expect.arrayContaining([
        "asset_generated_card",
        version.id,
      ]));
      expect(project.assets.asset_generated_card).toBeUndefined();
    }
  });

  it("selects a new version only for unlocked follow-latest consumers and marks them stale", () => {
    const project = createSeedProject();
    const asset = project.assets.asset_scene_01!;
    const clip = project.timeline.tracks[0]!.clips[0]!;
    clip.versionPolicy = "follow-latest";
    const version = generatedVersion("asset_scene_01_v2", 2, project.revision);
    const originalVersion = structuredClone(asset.versions[0]!);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        { type: "asset.addVersion", assetId: asset.meta.id, version },
        { type: "asset.selectVersion", assetId: asset.meta.id, versionId: version.id },
      ],
      {
        actor: system,
        commandId: "command_select_follow_latest",
        idempotencyKey: "select-follow-latest-key",
      },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const updatedAsset = result.project.assets.asset_scene_01!;
      const updatedClip = result.project.timeline.tracks[0]!.clips[0]!;
      expect(updatedAsset.versions[0]).toEqual(originalVersion);
      expect(updatedAsset.currentVersionId).toBe(version.id);
      expect(updatedClip.assetVersionId).toBe(version.id);
      expect(updatedClip.meta.status).toBe("stale");
      expect(result.project.stages.finish.status).toBe("stale");
      expect(result.result.invalidatedEntityIds).toContain(updatedClip.meta.id);
    }
  });

  it("rejects direct Codex asset commits and preserves the entire batch", () => {
    const project = createSeedProject();
    const before = structuredClone(project);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        { type: "script.updateBeat", beatId: "beat_01", patch: { narration: "Must roll back." } },
        {
          type: "asset.addVersion",
          assetId: "asset_scene_01",
          version: generatedVersion("asset_scene_01_v2", 2, project.revision),
        },
      ],
      {
        actor: codex,
        commandId: "command_codex_asset_commit",
        idempotencyKey: "codex-asset-commit-key",
      },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "ACTOR_NOT_AUTHORIZED",
        actorKind: "codex",
        operationType: "asset.addVersion",
      });
      expect(result.project).toEqual(before);
    }
    expect(project).toEqual(before);
  });

  it("requires content-addressed provenance for every newly committed version", () => {
    const project = createSeedProject();
    const version = generatedVersion("asset_scene_01_v2", 2, project.revision);
    delete version.objectKey;

    expect(() => createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "asset.addVersion", assetId: "asset_scene_01", version }],
      {
        actor: system,
        commandId: "command_unaddressed_asset_version",
        idempotencyKey: "unaddressed-asset-version-key",
      },
    )).toThrow(/objectKey/);
  });

  it("rejects adding a version to a locked asset", () => {
    const project = createSeedProject();
    project.assets.asset_scene_01!.meta.locked = true;
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{
        type: "asset.addVersion",
        assetId: "asset_scene_01",
        version: generatedVersion("asset_scene_01_v2", 2, project.revision),
      }],
      {
        actor,
        commandId: "command_locked_asset_version",
        idempotencyKey: "locked-asset-version-key",
      },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "ENTITY_LOCKED",
        entityId: "asset_scene_01",
        operationType: "asset.addVersion",
      });
    }
  });

  it("can store a candidate for a locked scene but cannot select it behind the lock", () => {
    const project = createSeedProject();
    const version = generatedVersion("asset_scene_03_v2", 2, project.revision);
    const add = createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "asset.addVersion", assetId: "asset_scene_03", version }],
      {
        actor: system,
        commandId: "command_add_locked_scene_candidate",
        idempotencyKey: "add-locked-scene-candidate-key",
      },
    );
    const added = applyProjectCommand(project, add);
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const select = createProjectCommand(
      added.project.projectId,
      added.project.revision,
      [{ type: "asset.selectVersion", assetId: "asset_scene_03", versionId: version.id }],
      {
        actor: system,
        commandId: "command_select_locked_scene_candidate",
        idempotencyKey: "select-locked-scene-candidate-key",
      },
    );
    const selected = applyProjectCommand(added.project, select);
    expect(selected.ok).toBe(false);
    if (!selected.ok) {
      expect(selected.error).toMatchObject({
        code: "ENTITY_LOCKED",
        entityId: "scene_03",
        operationType: "asset.selectVersion",
      });
      expect(selected.project.assets.asset_scene_03!.currentVersionId).toBe("asset_scene_03_v1");
    }
  });

  it("rejects duplicate immutable version numbers without partial state", () => {
    const project = createSeedProject();
    const before = structuredClone(project);
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [
        {
          type: "asset.addVersion",
          assetId: "asset_scene_01",
          version: generatedVersion("asset_scene_01_v2", 2, project.revision),
        },
        {
          type: "asset.addVersion",
          assetId: "asset_scene_01",
          version: generatedVersion("asset_scene_01_alternate_v2", 2, project.revision),
        },
      ],
      {
        actor: system,
        commandId: "command_duplicate_asset_version",
        idempotencyKey: "duplicate-asset-version-key",
      },
    );

    const result = applyProjectCommand(project, command);
    expect(result.ok).toBe(false);
    expect(result.project).toEqual(before);
  });
});

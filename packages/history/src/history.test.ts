import { describe, expect, it } from "vitest";
import { createProjectCommand } from "@praxis/commands";
import { applyProjectCommand } from "@praxis/commands";
import { createSeedProject } from "@praxis/project-schema";
import {
  applyCommandWithHistory,
  createCheckpoint,
  createProjectHistory,
  redoLastCommand,
  restoreCheckpoint,
  undoLastCommand,
} from "./index";

const actor = { kind: "director" as const, sessionId: "session_history_test" };

describe("operation history", () => {
  it("restores all direct and computed changes with the stored inverse", () => {
    const project = createSeedProject();
    const originalNarration = project.script.beats[0]!.narration;
    const originalSceneStatus = project.scenes[0]!.meta.status;
    const command = createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "script.updateBeat", beatId: "beat_01", patch: { narration: "A different question." } }],
      { actor, commandId: "command_history_edit", idempotencyKey: "history-edit-key" },
    );

    const committed = applyCommandWithHistory(project, createProjectHistory(project.projectId), command);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.project.scenes[0]!.meta.status).toBe("stale");
    expect(committed.history.entries).toHaveLength(1);

    const undone = undoLastCommand(committed.project, committed.history, actor);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.project.script.beats[0]!.narration).toBe(originalNarration);
    expect(undone.project.scenes[0]!.meta.status).toBe(originalSceneStatus);
    expect(undone.project.revision).toBe(project.revision + 2);
    expect(undone.history.entries).toHaveLength(0);
    expect(undone.history.redoStack).toHaveLength(1);

    const redone = redoLastCommand(undone.project, undone.history, actor);
    expect(redone.ok).toBe(true);
    if (redone.ok) {
      expect(redone.project.script.beats[0]!.narration).toBe("A different question.");
      expect(redone.history.entries).toHaveLength(1);
    }
  });

  it("restores a checkpoint as a new revision while preserving its locked entities", () => {
    const project = createSeedProject();
    const checkpoint = createCheckpoint(project, {
      id: "checkpoint_before_move",
      label: "Before moving scene one",
      actor,
      createdAt: "2026-08-26T17:00:00.000Z",
    });
    const move = createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "timeline.moveClip", clipId: "clip_scene_01", startFrame: 90 }],
      { actor, commandId: "command_move_before_restore", idempotencyKey: "move-before-restore" },
    );
    const moved = applyCommandWithHistory(project, createProjectHistory(project.projectId), move);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const restored = restoreCheckpoint(moved.project, checkpoint, {
      actor,
      commandId: "command_restore_checkpoint",
      idempotencyKey: "restore-checkpoint-key",
      createdAt: "2026-08-26T17:01:00.000Z",
    });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      const clip = restored.project.timeline.tracks[0]!.clips.find(
        (candidate) => candidate.meta.id === "clip_scene_01",
      );
      expect(clip?.startFrame).toBe(0);
      expect(restored.project.scenes[2]!.meta.locked).toBe(true);
      expect(restored.project.revision).toBe(moved.project.revision + 1);
      expect(restored.result.checkpointId).toBe(checkpoint.id);
    }
  });

  it("refuses to undo across an unrecorded intervening revision", () => {
    const project = createSeedProject();
    const edit = createProjectCommand(
      project.projectId,
      project.revision,
      [{ type: "script.updateBeat", beatId: "beat_01", patch: { narration: "Recorded change." } }],
      { actor, commandId: "command_recorded_change", idempotencyKey: "recorded-change-key" },
    );
    const committed = applyCommandWithHistory(project, createProjectHistory(project.projectId), edit);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;

    const intervening = createProjectCommand(
      project.projectId,
      committed.project.revision,
      [{ type: "timeline.moveClip", clipId: "clip_scene_01", startFrame: 15 }],
      { actor, commandId: "command_intervening_change", idempotencyKey: "intervening-change-key" },
    );
    const outsideHistory = applyProjectCommand(committed.project, intervening);
    expect(outsideHistory.ok).toBe(true);
    if (!outsideHistory.ok) return;

    const undoResult = undoLastCommand(outsideHistory.project, committed.history, actor);
    expect(undoResult.ok).toBe(false);
    if (!undoResult.ok) expect(undoResult.error.code).toBe("REVISION_CONFLICT");
  });
});

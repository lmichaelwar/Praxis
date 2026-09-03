import type { ProductionProject, StageName } from "@praxis/project-schema";
import {
  STAGE_ORDER,
  type LedgerView,
  type SceneView,
  type StageView,
  type TimelineClipView,
  type TrackView,
} from "./ui-types";

const stageLabels: Record<StageName, string> = {
  treatment: "Treatment",
  script: "Script",
  previz: "Previz",
  assets: "Assets",
  edit: "Edit",
  finish: "Finish",
};

const thumbnailPositions = ["50% 45%", "68% 40%", "50% 66%", "34% 56%", "53% 44%"];

export function projectStages(project: ProductionProject): StageView[] {
  return STAGE_ORDER.map((stage) => {
    const status = project.stages[stage].status;
    return {
      id: stage,
      label: stageLabels[stage],
      mode: project.delegation[stage].mode,
      status:
        status === "stale" || status === "failed"
          ? "stale"
          : status === "active"
            ? "working"
            : status === "ready" || status === "approved"
              ? "approved"
              : "draft",
    };
  });
}

export function projectScenes(project: ProductionProject): SceneView[] {
  const beats = new Map(project.script.beats.map((beat) => [beat.meta.id, beat]));
  return [...project.scenes]
    .sort((left, right) => left.order - right.order)
    .map((scene, index) => {
      const beat = beats.get(scene.beatId);
      return {
        id: scene.meta.id,
        beatId: scene.beatId,
        index: index + 1,
        title: beat?.title ?? scene.title,
        narration: beat?.narration ?? "",
        visualIntent: beat?.visualIntent ?? scene.visualDescription,
        shotLabel: scene.cameraLanguage,
        startFrame: beat?.startFrame ?? 0,
        durationFrames: beat?.durationFrames ?? scene.estimatedDurationFrames,
        status:
          scene.meta.status === "rejected"
            ? "failed"
            : scene.meta.status,
        locked: scene.meta.locked,
        authoredBy: scene.meta.lastEditedBy ?? scene.meta.authoredBy,
        thumbnailPosition: thumbnailPositions[index % thumbnailPositions.length]!,
      };
    });
}

const trackLabel = (projectTrackIndex: number, kind: string) => {
  if (kind === "video") return `V${projectTrackIndex + 1}`;
  if (kind === "overlay") return "V2";
  return `A${Math.max(1, projectTrackIndex - 1)}`;
};

export function projectTracks(project: ProductionProject): TrackView[] {
  const sceneLocks = new Map(project.scenes.map((scene) => [scene.meta.id, scene.meta.locked]));
  const tracks = [...project.timeline.tracks]
    .sort((left, right) => left.order - right.order)
    .map((track, index): TrackView => ({
      id: track.meta.id,
      label: trackLabel(index, track.kind),
      role: track.name.toLowerCase(),
      clips: track.clips.map((clip): TimelineClipView => ({
        id: clip.meta.id,
        sceneId: clip.sceneId,
        label: clip.name,
        trackId: track.meta.id,
        startFrame: clip.startFrame,
        durationFrames: clip.durationFrames,
        kind: track.kind === "overlay" ? "title" : track.kind === "audio" ? "audio" : "video",
        status: clip.meta.status === "rejected" ? "draft" : clip.meta.status,
        locked: clip.meta.locked || (clip.sceneId ? sceneLocks.get(clip.sceneId) : false),
      })),
    }));

  const overlay = tracks.find((track) => track.role.includes("title"));
  const proposal = project.decisions.find((decision) => decision.kind === "proposal" && decision.status === "pending");
  if (overlay && proposal) {
    overlay.clips.push({
      id: `proposal:${proposal.meta.id}`,
      sceneId: "scene_05",
      label: "Ending alt B",
      trackId: overlay.id,
      startFrame: Math.max(0, project.timeline.durationFrames - 250),
      durationFrames: 105,
      kind: "proposal",
      status: "proposed",
    });
  }

  return tracks;
}

export function initialLedger(project: ProductionProject): LedgerView[] {
  const proposal = project.decisions.find((decision) => decision.status === "pending");
  return [
    ...(proposal
      ? [
          {
            id: `ledger_${proposal.meta.id}`,
            revision: project.revision,
            actor: "codex" as const,
            action: "Proposed ending revision",
            detail: proposal.summary,
            timestamp: "10:21:34",
          },
        ]
      : []),
    {
      id: "ledger_director_lock",
      revision: project.revision,
      actor: "director",
      action: "Locked hero scene",
      detail: "Scene 03 is protected from delegated edits.",
      timestamp: "10:18:07",
      tone: "success",
    },
    {
      id: "ledger_conflict_seed",
      revision: project.revision,
      actor: "system",
      action: "Rebase boundary armed",
      detail: "Stale agent commands will be rejected before commit.",
      timestamp: "10:15:42",
      tone: "warning",
    },
    {
      id: "ledger_checkpoint_seed",
      revision: project.revision,
      actor: "system",
      action: "Checkpoint created",
      detail: "Seeded rough cut can be restored without losing project identity.",
      timestamp: "10:05:10",
      tone: "success",
      checkpointId: "checkpoint_seed",
    },
  ];
}

import {
  type ActorKind,
  type AssetRecord,
  type AssetVersion,
  createEntityMeta,
  type DecisionRecord,
  type EntityMeta,
  type EntityStatus,
  type ProductionProject,
  ProductionProjectSchema,
  type Scene,
  type ScriptBeat,
  type StageName,
  type TimelineClip,
  TimelineTextStyleSchema,
  type TimelineTrack,
} from "@praxis/project-schema";
import { z } from "zod";
import {
  type ProjectCommand,
  type ProjectCommandInput,
  ProjectCommandSchema,
  type ProjectOperation,
  ProjectOperationSchema,
  type ScenePatch,
  type ScriptBeatPatch,
  type TimelineClipPatch,
} from "./operations";

export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface RevisionConflictError {
  code: "REVISION_CONFLICT";
  expectedRevision: number;
  currentRevision: number;
  changedEntities: string[];
  summary: string;
}

export interface EntityLockedError {
  code: "ENTITY_LOCKED";
  entityId: string;
  entityType: "beat" | "scene" | "asset" | "track" | "clip" | "decision" | "stage" | "project";
  operationType: ProjectOperation["type"];
  lockedBy: "director";
  summary: string;
}

export interface EntityNotFoundError {
  code: "ENTITY_NOT_FOUND";
  entityId: string;
  entityType: string;
  operationType: ProjectOperation["type"];
  summary: string;
}

export interface InvalidOperationError {
  code: "INVALID_OPERATION";
  operationType?: string;
  summary: string;
  issues?: ValidationIssue[];
}

export interface InvariantViolationError {
  code: "INVARIANT_VIOLATION";
  summary: string;
  issues: ValidationIssue[];
}

export interface ActorNotAuthorizedError {
  code: "ACTOR_NOT_AUTHORIZED";
  actorKind: ActorKind;
  operationType: ProjectOperation["type"];
  summary: string;
}

export type ProjectCommandError =
  | RevisionConflictError
  | EntityLockedError
  | EntityNotFoundError
  | InvalidOperationError
  | InvariantViolationError
  | ActorNotAuthorizedError;

export interface CommandResult {
  revision: number;
  appliedOperationIds: string[];
  affectedEntityIds: string[];
  invalidatedEntityIds: string[];
  dryRun: boolean;
  checkpointId?: string;
}

export interface ApplyProjectCommandSuccess {
  ok: true;
  project: ProductionProject;
  /** Present for dry runs; project remains the original committed snapshot. */
  previewProject?: ProductionProject;
  result: CommandResult;
  inverseCommand: ProjectCommand;
}

export interface ApplyProjectCommandFailure {
  ok: false;
  project: ProductionProject;
  error: ProjectCommandError;
}

export type ApplyProjectCommandResult = ApplyProjectCommandSuccess | ApplyProjectCommandFailure;

class DomainAbort extends Error {
  constructor(readonly domainError: ProjectCommandError) {
    super(domainError.summary);
  }
}

interface MutableApplyContext {
  project: ProductionProject;
  command: ProjectCommand;
  nextRevision: number;
  timestamp: string;
  affected: Set<string>;
  invalidated: Set<string>;
  inverseOperations: ProjectOperation[];
  appliedOperationIds: string[];
  checkpointId?: string;
}

const issueList = (error: z.ZodError): ValidationIssue[] =>
  error.issues.map((issue) => ({
    path: [...issue.path],
    message: issue.message,
  }));

function abort(error: ProjectCommandError): never {
  throw new DomainAbort(error);
}

function notFound(
  entityId: string,
  entityType: string,
  operationType: ProjectOperation["type"],
): never {
  return abort({
    code: "ENTITY_NOT_FOUND",
    entityId,
    entityType,
    operationType,
    summary: `${entityType} ${entityId} does not exist`,
  });
}

function locked(
  entityId: string,
  entityType: EntityLockedError["entityType"],
  operationType: ProjectOperation["type"],
): never {
  return abort({
    code: "ENTITY_LOCKED",
    entityId,
    entityType,
    operationType,
    lockedBy: "director",
    summary: `${entityType} ${entityId} is director-locked and was preserved`,
  });
}

function requireAssetMutationAuthority(
  actor: ActorKind,
  operationType: ProjectOperation["type"],
) {
  if (actor === "codex") {
    abort({
      code: "ACTOR_NOT_AUTHORIZED",
      actorKind: actor,
      operationType,
      summary: `${actor} cannot commit immutable asset records or versions directly; dispatch a media job for a system commit`,
    });
  }
}

const touchMeta = (meta: EntityMeta, actor: ActorKind, revision: number) => {
  meta.revisionUpdated = revision;
  meta.lastEditedBy = actor;
};

const findBeat = (project: ProductionProject, id: string): ScriptBeat | undefined =>
  project.script.beats.find((beat) => beat.meta.id === id);

const findDecision = (project: ProductionProject, id: string): DecisionRecord | undefined =>
  project.decisions.find((decision) => decision.meta.id === id);

const findAsset = (project: ProductionProject, id: string): AssetRecord | undefined =>
  project.assets[id];

interface ClipLocation {
  clip: TimelineClip;
  clipIndex: number;
  track: TimelineTrack;
  trackIndex: number;
}

const findClip = (project: ProductionProject, clipId: string): ClipLocation | undefined => {
  for (const [trackIndex, track] of project.timeline.tracks.entries()) {
    const clipIndex = track.clips.findIndex((clip) => clip.meta.id === clipId);
    if (clipIndex >= 0) {
      return { clip: track.clips[clipIndex]!, clipIndex, track, trackIndex };
    }
  }
  return undefined;
};

const ensureMetaUnlocked = (
  meta: EntityMeta,
  entityType: EntityLockedError["entityType"],
  operationType: ProjectOperation["type"],
) => {
  if (meta.locked) locked(meta.id, entityType, operationType);
};

const ensureClipUnlocked = (
  project: ProductionProject,
  location: ClipLocation,
  operationType: ProjectOperation["type"],
) => {
  ensureMetaUnlocked(location.track.meta, "track", operationType);
  ensureMetaUnlocked(location.clip.meta, "clip", operationType);
  if (location.clip.sceneId) {
    const scene = project.scenes.find((candidate) => candidate.meta.id === location.clip.sceneId);
    if (scene?.meta.locked) locked(scene.meta.id, "scene", operationType);
  }
  if (location.clip.assetId) {
    const asset = project.assets[location.clip.assetId];
    if (asset?.meta.locked) locked(asset.meta.id, "asset", operationType);
  }
};

const stageId = (stage: StageName) => `stage:${stage}`;

const touchStage = (
  context: MutableApplyContext,
  stage: StageName,
  status?: ProductionProject["stages"][StageName]["status"],
) => {
  const state = context.project.stages[stage];
  if (status) state.status = status;
  state.revisionUpdated = context.nextRevision;
  context.affected.add(stageId(stage));
};

const invalidateStage = (context: MutableApplyContext, stage: StageName, reason: string) => {
  const state = context.project.stages[stage];
  state.status = "stale";
  state.revisionUpdated = context.nextRevision;
  if (!state.staleReasons.includes(reason)) state.staleReasons.push(reason);
  context.invalidated.add(stageId(stage));
};

const invalidateMeta = (context: MutableApplyContext, meta: EntityMeta) => {
  if (meta.status !== "failed" && meta.status !== "rejected") meta.status = "stale";
  touchMeta(meta, "system", context.nextRevision);
  context.invalidated.add(meta.id);
};

const invalidateFromBeat = (context: MutableApplyContext, beatId: string) => {
  const sceneIds = new Set(
    context.project.scenes
      .filter((scene) => scene.beatId === beatId || scene.meta.derivedFrom.includes(beatId))
      .map((scene) => {
        invalidateMeta(context, scene.meta);
        return scene.meta.id;
      }),
  );

  const assetIds = new Set<string>();
  for (const asset of Object.values(context.project.assets)) {
    const isRequiredByScene = context.project.scenes.some(
      (scene) => sceneIds.has(scene.meta.id) && scene.requiredAssetIds.includes(asset.meta.id),
    );
    if (
      asset.meta.derivedFrom.includes(beatId) ||
      asset.meta.derivedFrom.some((id) => sceneIds.has(id)) ||
      isRequiredByScene
    ) {
      invalidateMeta(context, asset.meta);
      for (const version of asset.versions) {
        if (version.status === "ready" || version.status === "approved") version.status = "stale";
      }
      assetIds.add(asset.meta.id);
    }
  }

  for (const track of context.project.timeline.tracks) {
    for (const clip of track.clips) {
      if (
        (clip.sceneId && sceneIds.has(clip.sceneId)) ||
        (clip.assetId && assetIds.has(clip.assetId)) ||
        clip.meta.derivedFrom.some((id) => id === beatId || sceneIds.has(id) || assetIds.has(id))
      ) {
        // Staleness is metadata only: timing, identity, track membership, pins, and locks remain intact.
        invalidateMeta(context, clip.meta);
      }
    }
  }

  const reason = `Script beat ${beatId} changed`;
  invalidateStage(context, "previz", reason);
  invalidateStage(context, "assets", reason);
  invalidateStage(context, "edit", reason);
  invalidateStage(context, "finish", reason);
};

const invalidateFromScene = (
  context: MutableApplyContext,
  sceneId: string,
  additionallyAffectedAssetIds: readonly string[] = [],
) => {
  const assetIds = new Set<string>(additionallyAffectedAssetIds);
  const scene = context.project.scenes.find((candidate) => candidate.meta.id === sceneId);
  for (const asset of Object.values(context.project.assets)) {
    if (
      assetIds.has(asset.meta.id) ||
      asset.meta.derivedFrom.includes(sceneId) ||
      scene?.requiredAssetIds.includes(asset.meta.id)
    ) {
      invalidateMeta(context, asset.meta);
      assetIds.add(asset.meta.id);
    }
  }
  for (const track of context.project.timeline.tracks) {
    for (const clip of track.clips) {
      if (
        clip.sceneId === sceneId ||
        (clip.assetId && assetIds.has(clip.assetId)) ||
        clip.meta.derivedFrom.some((id) => id === sceneId || assetIds.has(id))
      ) {
        invalidateMeta(context, clip.meta);
      }
    }
  }
  const reason = `Scene ${sceneId} changed`;
  invalidateStage(context, "assets", reason);
  invalidateStage(context, "edit", reason);
  invalidateStage(context, "finish", reason);
};

const invalidateFromTimelineEdit = (context: MutableApplyContext, clipId: string) => {
  touchStage(context, "edit", "active");
  invalidateStage(context, "finish", `Timeline clip ${clipId} changed`);
};

const previousBeatPatch = (beat: ScriptBeat, patch: ScriptBeatPatch): ScriptBeatPatch => {
  const inverse: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as Array<keyof ScriptBeatPatch>) {
    if (key === "status") inverse.status = beat.meta.status;
    else if (key === "deliveryCue") inverse.deliveryCue = beat.deliveryCue ?? null;
    else inverse[key] = structuredClone(beat[key as keyof ScriptBeat]);
  }
  return inverse as ScriptBeatPatch;
};

const applyBeatPatch = (beat: ScriptBeat, patch: ScriptBeatPatch) => {
  if (patch.title !== undefined) beat.title = patch.title;
  if (patch.startFrame !== undefined) beat.startFrame = patch.startFrame;
  if (patch.durationFrames !== undefined) beat.durationFrames = patch.durationFrames;
  if (patch.narration !== undefined) beat.narration = patch.narration;
  if (patch.visualIntent !== undefined) beat.visualIntent = patch.visualIntent;
  if (patch.deliveryCue === null) delete beat.deliveryCue;
  else if (patch.deliveryCue !== undefined) beat.deliveryCue = patch.deliveryCue;
  if (patch.enhancementCues !== undefined) beat.enhancementCues = [...patch.enhancementCues];
  if (patch.sourceRefs !== undefined) beat.sourceRefs = [...patch.sourceRefs];
  if (patch.status !== undefined) beat.meta.status = patch.status;
};

const previousScenePatch = (scene: Scene, patch: ScenePatch): ScenePatch => {
  const inverse: Partial<Record<keyof ScenePatch, unknown>> = {};
  for (const key of Object.keys(patch) as Array<keyof ScenePatch>) {
    inverse[key] = structuredClone(scene[key]);
  }
  return inverse as ScenePatch;
};

const applyScenePatch = (scene: Scene, patch: ScenePatch) => {
  if (patch.title !== undefined) scene.title = patch.title;
  if (patch.narrativeRole !== undefined) scene.narrativeRole = patch.narrativeRole;
  if (patch.informationRole !== undefined) scene.informationRole = patch.informationRole;
  if (patch.visualDescription !== undefined) scene.visualDescription = patch.visualDescription;
  if (patch.shotIntent !== undefined) scene.shotIntent = patch.shotIntent;
  if (patch.cameraLanguage !== undefined) scene.cameraLanguage = patch.cameraLanguage;
  if (patch.estimatedDurationFrames !== undefined) {
    scene.estimatedDurationFrames = patch.estimatedDurationFrames;
  }
  if (patch.requiredAssetIds !== undefined) {
    scene.requiredAssetIds = [...patch.requiredAssetIds];
  }
  if (patch.heroMoment !== undefined) scene.heroMoment = patch.heroMoment;
};

const previousClipPatch = (clip: TimelineClip, patch: TimelineClipPatch): TimelineClipPatch => {
  const inverse: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as Array<keyof TimelineClipPatch>) {
    if (key === "status") inverse.status = clip.meta.status;
    else if (key === "sceneId" || key === "assetId" || key === "assetVersionId") {
      inverse[key] = clip[key] ?? null;
    } else if (
      key === "sourceDurationFrames" ||
      key === "transitionIn" ||
      key === "transitionOut" ||
      key === "text" ||
      key === "gainDb"
    ) {
      inverse[key] = clip[key] ?? null;
    } else if (key === "transform") {
      inverse.transform = structuredClone(clip.transform);
    } else if (key === "textStyle") {
      inverse.textStyle = clip.textStyle ? structuredClone(clip.textStyle) : null;
    } else {
      inverse[key] = structuredClone(clip[key as keyof TimelineClip]);
    }
  }
  return inverse as TimelineClipPatch;
};

const assignNullable = <K extends "sceneId" | "assetId" | "assetVersionId" | "transitionIn" | "transitionOut" | "sourceDurationFrames">(
  clip: TimelineClip,
  key: K,
  value: TimelineClipPatch[K],
) => {
  if (value === null) delete clip[key];
  else if (value !== undefined) Object.assign(clip, { [key]: value });
};

const applyClipPatch = (clip: TimelineClip, patch: TimelineClipPatch) => {
  if (patch.kind !== undefined) clip.kind = patch.kind;
  if (patch.name !== undefined) clip.name = patch.name;
  if (patch.startFrame !== undefined) clip.startFrame = patch.startFrame;
  if (patch.durationFrames !== undefined) clip.durationFrames = patch.durationFrames;
  if (patch.sourceStartFrame !== undefined) clip.sourceStartFrame = patch.sourceStartFrame;
  assignNullable(clip, "sourceDurationFrames", patch.sourceDurationFrames);
  assignNullable(clip, "sceneId", patch.sceneId);
  assignNullable(clip, "assetId", patch.assetId);
  assignNullable(clip, "assetVersionId", patch.assetVersionId);
  if (patch.versionPolicy !== undefined) clip.versionPolicy = patch.versionPolicy;
  if (patch.opacity !== undefined) clip.opacity = patch.opacity;
  if (patch.transform !== undefined) clip.transform = { ...clip.transform, ...patch.transform };
  if (patch.text === null) delete clip.text;
  else if (patch.text !== undefined) clip.text = patch.text;
  if (patch.textStyle === null) delete clip.textStyle;
  else if (patch.textStyle !== undefined) {
    clip.textStyle = TimelineTextStyleSchema.parse({ ...clip.textStyle, ...patch.textStyle });
  }
  if (patch.gainDb === null) delete clip.gainDb;
  else if (patch.gainDb !== undefined) clip.gainDb = patch.gainDb;
  assignNullable(clip, "transitionIn", patch.transitionIn);
  assignNullable(clip, "transitionOut", patch.transitionOut);
  if (patch.status !== undefined) clip.meta.status = patch.status;
};

const decisionState = (decision: DecisionRecord) => ({
  status: decision.status,
  resolvedBy: decision.resolvedBy ?? null,
  resolvedAt: decision.resolvedAt ?? null,
  resolutionReason: decision.resolutionReason ?? null,
});

const applyDecisionState = (
  decision: DecisionRecord,
  state: {
    status: DecisionRecord["status"];
    resolvedBy: ActorKind | null;
    resolvedAt: string | null;
    resolutionReason: string | null;
  },
) => {
  decision.status = state.status;
  if (state.resolvedBy === null) delete decision.resolvedBy;
  else decision.resolvedBy = state.resolvedBy;
  if (state.resolvedAt === null) delete decision.resolvedAt;
  else decision.resolvedAt = state.resolvedAt;
  if (state.resolutionReason === null) delete decision.resolutionReason;
  else decision.resolutionReason = state.resolutionReason;
};

const allEntityIds = (project: ProductionProject): string[] => [
  ...project.script.beats.map((beat) => beat.meta.id),
  ...project.scenes.map((scene) => scene.meta.id),
  ...Object.values(project.assets).flatMap((asset) => [asset.meta.id, ...asset.versions.map((version) => version.id)]),
  project.timeline.meta.id,
  ...project.timeline.tracks.flatMap((track) => [track.meta.id, ...track.clips.map((clip) => clip.meta.id)]),
  ...project.decisions.map((decision) => decision.meta.id),
  ...project.checkpoints.map((checkpoint) => checkpoint.id),
  ...Object.keys(project.stages).map((stage) => `stage:${stage}`),
];

const touchEveryEntity = (project: ProductionProject, actor: ActorKind, revision: number) => {
  for (const beat of project.script.beats) touchMeta(beat.meta, actor, revision);
  for (const scene of project.scenes) touchMeta(scene.meta, actor, revision);
  for (const asset of Object.values(project.assets)) touchMeta(asset.meta, actor, revision);
  touchMeta(project.timeline.meta, actor, revision);
  for (const track of project.timeline.tracks) {
    touchMeta(track.meta, actor, revision);
    for (const clip of track.clips) touchMeta(clip.meta, actor, revision);
  }
  for (const decision of project.decisions) touchMeta(decision.meta, actor, revision);
  for (const stage of Object.values(project.stages)) stage.revisionUpdated = revision;
};

const assertNoDuplicateClipId = (project: ProductionProject, clipId: string, operationType: ProjectOperation["type"]) => {
  if (findClip(project, clipId)) {
    abort({
      code: "INVALID_OPERATION",
      operationType,
      summary: `Timeline clip ID ${clipId} already exists`,
    });
  }
};

const assertUnusedEntityId = (
  project: ProductionProject,
  entityId: string,
  operationType: ProjectOperation["type"],
) => {
  if (entityId === project.projectId || allEntityIds(project).includes(entityId)) {
    abort({
      code: "INVALID_OPERATION",
      operationType,
      summary: `Entity ID ${entityId} already exists in this project`,
    });
  }
};

const entityStatusForSelectedVersion = (version: AssetVersion): EntityStatus => {
  if (version.status === "approved") return "approved";
  if (version.status === "stale") return "stale";
  return "draft";
};

const applyOne = (
  context: MutableApplyContext,
  operation: ProjectOperation,
  operationLabel: string,
  proposalDepth = 0,
) => {
  context.appliedOperationIds.push(operation.operationId ?? operationLabel);

  switch (operation.type) {
    case "script.updateBeat": {
      const beat = findBeat(context.project, operation.beatId);
      if (!beat) notFound(operation.beatId, "beat", operation.type);
      ensureMetaUnlocked(beat.meta, "beat", operation.type);
      const lockedScene = context.project.scenes.find(
        (scene) =>
          (scene.beatId === beat.meta.id || scene.meta.derivedFrom.includes(beat.meta.id)) &&
          scene.meta.locked,
      );
      if (lockedScene) locked(lockedScene.meta.id, "scene", operation.type);
      const inversePatch = previousBeatPatch(beat, operation.patch);
      applyBeatPatch(beat, operation.patch);
      touchMeta(beat.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(beat.meta.id);
      touchStage(context, "script", "active");
      invalidateFromBeat(context, beat.meta.id);
      context.inverseOperations.unshift({
        type: "script.updateBeat",
        beatId: beat.meta.id,
        patch: inversePatch,
      });
      return;
    }

    case "scene.update": {
      const scene = context.project.scenes.find((candidate) => candidate.meta.id === operation.sceneId);
      if (!scene) notFound(operation.sceneId, "scene", operation.type);
      ensureMetaUnlocked(scene.meta, "scene", operation.type);
      const previousRequiredAssetIds = [...scene.requiredAssetIds];
      const inversePatch = previousScenePatch(scene, operation.patch);
      applyScenePatch(scene, operation.patch);
      touchMeta(scene.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(scene.meta.id);
      touchStage(context, "previz", "active");
      invalidateFromScene(context, scene.meta.id, previousRequiredAssetIds);
      context.inverseOperations.unshift({
        type: "scene.update",
        sceneId: scene.meta.id,
        patch: inversePatch,
      });
      return;
    }

    case "scene.setLocked": {
      const scene = context.project.scenes.find((candidate) => candidate.meta.id === operation.sceneId);
      if (!scene) notFound(operation.sceneId, "scene", operation.type);
      if (scene.meta.locked && !operation.locked && context.command.actor.kind === "codex") {
        locked(scene.meta.id, "scene", operation.type);
      }
      if (scene.meta.locked && operation.locked && context.command.actor.kind === "codex") {
        locked(scene.meta.id, "scene", operation.type);
      }
      const previous = scene.meta.locked;
      scene.meta.locked = operation.locked;
      touchMeta(scene.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(scene.meta.id);
      context.inverseOperations.unshift({
        type: "scene.setLocked",
        sceneId: scene.meta.id,
        locked: previous,
      });
      return;
    }

    case "scene.setStatus": {
      const scene = context.project.scenes.find((candidate) => candidate.meta.id === operation.sceneId);
      if (!scene) notFound(operation.sceneId, "scene", operation.type);
      ensureMetaUnlocked(scene.meta, "scene", operation.type);
      const previous = scene.meta.status;
      scene.meta.status = operation.status;
      touchMeta(scene.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(scene.meta.id);
      if (operation.status === "stale" || operation.status === "draft") {
        invalidateFromScene(context, scene.meta.id);
      }
      context.inverseOperations.unshift({
        type: "scene.setStatus",
        sceneId: scene.meta.id,
        status: previous,
      });
      return;
    }

    case "timeline.moveClip": {
      const location = findClip(context.project, operation.clipId);
      if (!location) notFound(operation.clipId, "clip", operation.type);
      ensureClipUnlocked(context.project, location, operation.type);
      const targetTrack = operation.targetTrackId
        ? context.project.timeline.tracks.find((track) => track.meta.id === operation.targetTrackId)
        : location.track;
      if (!targetTrack) notFound(operation.targetTrackId!, "track", operation.type);
      ensureMetaUnlocked(targetTrack.meta, "track", operation.type);

      const previousTrackId = location.track.meta.id;
      const previousStart = location.clip.startFrame;
      if (targetTrack.meta.id !== location.track.meta.id) {
        location.track.clips.splice(location.clipIndex, 1);
        targetTrack.clips.push(location.clip);
      }
      location.clip.startFrame = operation.startFrame;
      touchMeta(location.clip.meta, context.command.actor.kind, context.nextRevision);
      touchMeta(location.track.meta, context.command.actor.kind, context.nextRevision);
      touchMeta(targetTrack.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(location.clip.meta.id);
      context.affected.add(location.track.meta.id);
      context.affected.add(targetTrack.meta.id);
      invalidateFromTimelineEdit(context, location.clip.meta.id);
      context.inverseOperations.unshift({
        type: "timeline.moveClip",
        clipId: location.clip.meta.id,
        startFrame: previousStart,
        targetTrackId: previousTrackId,
      });
      return;
    }

    case "timeline.insertClip": {
      const track = context.project.timeline.tracks.find((candidate) => candidate.meta.id === operation.trackId);
      if (!track) notFound(operation.trackId, "track", operation.type);
      ensureMetaUnlocked(track.meta, "track", operation.type);
      assertNoDuplicateClipId(context.project, operation.clip.meta.id, operation.type);
      if (operation.clip.sceneId) {
        const scene = context.project.scenes.find((candidate) => candidate.meta.id === operation.clip.sceneId);
        if (scene?.meta.locked) locked(scene.meta.id, "scene", operation.type);
      }
      if (operation.clip.assetId) {
        const asset = context.project.assets[operation.clip.assetId];
        if (asset?.meta.locked) locked(asset.meta.id, "asset", operation.type);
      }
      const clip = structuredClone(operation.clip);
      clip.meta.revisionCreated = context.nextRevision;
      clip.meta.revisionUpdated = context.nextRevision;
      clip.meta.authoredBy = context.command.actor.kind;
      clip.meta.lastEditedBy = context.command.actor.kind;
      track.clips.push(clip);
      touchMeta(track.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(clip.meta.id);
      context.affected.add(track.meta.id);
      invalidateFromTimelineEdit(context, clip.meta.id);
      context.inverseOperations.unshift({ type: "timeline.removeClip", clipId: clip.meta.id });
      return;
    }

    case "timeline.updateClip": {
      const location = findClip(context.project, operation.clipId);
      if (!location) notFound(operation.clipId, "clip", operation.type);
      ensureClipUnlocked(context.project, location, operation.type);
      if (operation.patch.sceneId) {
        const targetScene = context.project.scenes.find((scene) => scene.meta.id === operation.patch.sceneId);
        if (targetScene?.meta.locked) locked(targetScene.meta.id, "scene", operation.type);
      }
      if (operation.patch.assetId) {
        const targetAsset = context.project.assets[operation.patch.assetId];
        if (targetAsset?.meta.locked) locked(targetAsset.meta.id, "asset", operation.type);
      }
      const inversePatch = previousClipPatch(location.clip, operation.patch);
      applyClipPatch(location.clip, operation.patch);
      touchMeta(location.clip.meta, context.command.actor.kind, context.nextRevision);
      touchMeta(location.track.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(location.clip.meta.id);
      context.affected.add(location.track.meta.id);
      invalidateFromTimelineEdit(context, location.clip.meta.id);
      context.inverseOperations.unshift({
        type: "timeline.updateClip",
        clipId: location.clip.meta.id,
        patch: inversePatch,
      });
      return;
    }

    case "timeline.removeClip": {
      const location = findClip(context.project, operation.clipId);
      if (!location) notFound(operation.clipId, "clip", operation.type);
      ensureClipUnlocked(context.project, location, operation.type);
      const removed = structuredClone(location.clip);
      location.track.clips.splice(location.clipIndex, 1);
      touchMeta(location.track.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(removed.meta.id);
      context.affected.add(location.track.meta.id);
      invalidateFromTimelineEdit(context, removed.meta.id);
      context.inverseOperations.unshift({
        type: "timeline.insertClip",
        trackId: location.track.meta.id,
        clip: removed,
      });
      return;
    }

    case "asset.create": {
      requireAssetMutationAuthority(context.command.actor.kind, operation.type);
      assertUnusedEntityId(context.project, operation.asset.id, operation.type);
      const asset: AssetRecord = {
        meta: createEntityMeta(operation.asset.id, context.nextRevision, context.command.actor.kind, {
          derivedFrom: [...(operation.asset.derivedFrom ?? [])],
        }),
        kind: operation.asset.kind,
        name: operation.asset.name,
        description: operation.asset.description ?? "",
        versions: [],
        tags: [...(operation.asset.tags ?? [])],
        pinned: operation.asset.pinned ?? false,
      };
      context.project.assets[asset.meta.id] = asset;
      context.affected.add(asset.meta.id);
      touchStage(context, "assets", "active");
      return;
    }

    case "asset.addVersion": {
      requireAssetMutationAuthority(context.command.actor.kind, operation.type);
      const asset = findAsset(context.project, operation.assetId);
      if (!asset) notFound(operation.assetId, "asset", operation.type);
      ensureMetaUnlocked(asset.meta, "asset", operation.type);
      assertUnusedEntityId(context.project, operation.version.id, operation.type);
      if (asset.versions.some((version) => version.version === operation.version.version)) {
        abort({
          code: "INVALID_OPERATION",
          operationType: operation.type,
          summary: `Asset ${asset.meta.id} already has version number ${operation.version.version}`,
        });
      }
      asset.versions.push(structuredClone(operation.version));
      touchMeta(asset.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(asset.meta.id);
      context.affected.add(operation.version.id);
      touchStage(context, "assets", "active");
      return;
    }

    case "asset.selectVersion": {
      requireAssetMutationAuthority(context.command.actor.kind, operation.type);
      const asset = findAsset(context.project, operation.assetId);
      if (!asset) notFound(operation.assetId, "asset", operation.type);
      ensureMetaUnlocked(asset.meta, "asset", operation.type);
      const version = asset.versions.find((candidate) => candidate.id === operation.versionId);
      if (!version) notFound(operation.versionId, "asset version", operation.type);
      if (!["ready", "approved", "stale"].includes(version.status)) {
        abort({
          code: "INVALID_OPERATION",
          operationType: operation.type,
          summary: `Asset version ${version.id} is not selectable while ${version.status}`,
        });
      }

      const lockedScene = context.project.scenes.find(
        (scene) => scene.meta.locked && scene.requiredAssetIds.includes(asset.meta.id),
      );
      if (lockedScene) locked(lockedScene.meta.id, "scene", operation.type);

      const followingLocations: ClipLocation[] = [];
      for (const track of context.project.timeline.tracks) {
        for (const clip of track.clips) {
          if (
            clip.assetId === asset.meta.id &&
            (clip.versionPolicy === "follow-latest" || clip.assetVersionId === undefined)
          ) {
            const location = findClip(context.project, clip.meta.id)!;
            ensureClipUnlocked(context.project, location, operation.type);
            followingLocations.push(location);
          }
        }
      }

      asset.currentVersionId = version.id;
      asset.meta.status = entityStatusForSelectedVersion(version);
      if (version.provenance?.jobId) asset.meta.generationJobId = version.provenance.jobId;
      else delete asset.meta.generationJobId;
      touchMeta(asset.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(asset.meta.id);
      context.affected.add(version.id);

      for (const location of followingLocations) {
        location.clip.assetVersionId = version.id;
        invalidateMeta(context, location.clip.meta);
        touchMeta(location.track.meta, context.command.actor.kind, context.nextRevision);
        context.affected.add(location.clip.meta.id);
        context.affected.add(location.track.meta.id);
      }
      touchStage(context, "assets");
      invalidateStage(context, "edit", `Asset ${asset.meta.id} selected version ${version.id}`);
      invalidateStage(context, "finish", `Asset ${asset.meta.id} selected version ${version.id}`);
      return;
    }

    case "delegation.set": {
      const previous = structuredClone(context.project.delegation[operation.stage]);
      if (previous.mode === "locked" && context.command.actor.kind === "codex") {
        locked(stageId(operation.stage), "stage", operation.type);
      }
      const policy = context.project.delegation[operation.stage];
      policy.mode = operation.mode;
      if (operation.maxSpendUsd === null) delete policy.maxSpendUsd;
      else if (operation.maxSpendUsd !== undefined) policy.maxSpendUsd = operation.maxSpendUsd;
      if (operation.checkpointAfterStage !== undefined) {
        policy.checkpointAfterStage = operation.checkpointAfterStage;
      }
      context.affected.add(stageId(operation.stage));
      context.inverseOperations.unshift({
        type: "delegation.set",
        stage: previous.stage,
        mode: previous.mode,
        maxSpendUsd: previous.maxSpendUsd ?? null,
        checkpointAfterStage: previous.checkpointAfterStage,
      });
      return;
    }

    case "proposal.accept": {
      const decision = findDecision(context.project, operation.decisionId);
      if (!decision) notFound(operation.decisionId, "decision", operation.type);
      ensureMetaUnlocked(decision.meta, "decision", operation.type);
      if (decision.kind !== "proposal" || decision.status !== "pending") {
        abort({
          code: "INVALID_OPERATION",
          operationType: operation.type,
          summary: `Decision ${decision.meta.id} is not a pending proposal`,
        });
      }
      if (proposalDepth >= 2) {
        abort({
          code: "INVALID_OPERATION",
          operationType: operation.type,
          summary: "Nested proposal resolution exceeds the supported depth",
        });
      }
      const previous = decisionState(decision);
      for (const [index, proposedInput] of decision.proposedOperations.entries()) {
        const parsed = ProjectOperationSchema.safeParse(proposedInput);
        if (!parsed.success) {
          abort({
            code: "INVALID_OPERATION",
            operationType: operation.type,
            summary: `Proposal ${decision.meta.id} contains an invalid operation`,
            issues: issueList(parsed.error),
          });
        }
        if (parsed.data.type === "project.restore") {
          abort({
            code: "INVALID_OPERATION",
            operationType: operation.type,
            summary: "A proposal cannot contain a project restore",
          });
        }
        applyOne(context, parsed.data, `${operationLabel}:proposal:${index}`, proposalDepth + 1);
      }
      applyDecisionState(decision, {
        status: "accepted",
        resolvedBy: context.command.actor.kind,
        resolvedAt: context.timestamp,
        resolutionReason: operation.resolutionReason ?? null,
      });
      decision.meta.status = "approved";
      touchMeta(decision.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(decision.meta.id);
      context.inverseOperations.unshift({
        type: "decision.setState",
        decisionId: decision.meta.id,
        state: previous,
      });
      return;
    }

    case "proposal.reject": {
      const decision = findDecision(context.project, operation.decisionId);
      if (!decision) notFound(operation.decisionId, "decision", operation.type);
      ensureMetaUnlocked(decision.meta, "decision", operation.type);
      if (decision.kind !== "proposal" || decision.status !== "pending") {
        abort({
          code: "INVALID_OPERATION",
          operationType: operation.type,
          summary: `Decision ${decision.meta.id} is not a pending proposal`,
        });
      }
      const previous = decisionState(decision);
      applyDecisionState(decision, {
        status: "rejected",
        resolvedBy: context.command.actor.kind,
        resolvedAt: context.timestamp,
        resolutionReason: operation.resolutionReason,
      });
      decision.meta.status = "rejected";
      touchMeta(decision.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(decision.meta.id);
      context.inverseOperations.unshift({
        type: "decision.setState",
        decisionId: decision.meta.id,
        state: previous,
      });
      return;
    }

    case "decision.setState": {
      const decision = findDecision(context.project, operation.decisionId);
      if (!decision) notFound(operation.decisionId, "decision", operation.type);
      const previous = decisionState(decision);
      applyDecisionState(decision, operation.state);
      decision.meta.status =
        operation.state.status === "accepted"
          ? "approved"
          : operation.state.status === "rejected"
            ? "rejected"
            : operation.state.status === "superseded"
              ? "stale"
              : "draft";
      touchMeta(decision.meta, context.command.actor.kind, context.nextRevision);
      context.affected.add(decision.meta.id);
      context.inverseOperations.unshift({
        type: "decision.setState",
        decisionId: decision.meta.id,
        state: previous,
      });
      return;
    }

    case "checkpoint.add": {
      if (context.project.checkpoints.some((checkpoint) => checkpoint.id === operation.checkpoint.id)) {
        abort({
          code: "INVALID_OPERATION",
          operationType: operation.type,
          summary: `Checkpoint ${operation.checkpoint.id} already exists`,
        });
      }
      const checkpoint = structuredClone(operation.checkpoint);
      context.project.checkpoints.push(checkpoint);
      context.affected.add(checkpoint.id);
      context.checkpointId = checkpoint.id;
      context.inverseOperations.unshift({
        type: "checkpoint.remove",
        checkpointId: checkpoint.id,
      });
      return;
    }

    case "checkpoint.remove": {
      const index = context.project.checkpoints.findIndex(
        (checkpoint) => checkpoint.id === operation.checkpointId,
      );
      if (index < 0) notFound(operation.checkpointId, "checkpoint", operation.type);
      const [checkpoint] = context.project.checkpoints.splice(index, 1);
      context.affected.add(operation.checkpointId);
      context.inverseOperations.unshift({
        type: "checkpoint.add",
        checkpoint: checkpoint!,
      });
      return;
    }

    case "project.restore": {
      if (operation.snapshot.projectId !== context.project.projectId) {
        abort({
          code: "INVALID_OPERATION",
          operationType: operation.type,
          summary: "A checkpoint snapshot cannot be restored into a different project",
        });
      }
      if (context.command.actor.kind === "codex") {
        const lockedEntity = [
          ...context.project.script.beats.map((beat) => beat.meta),
          ...context.project.scenes.map((scene) => scene.meta),
          ...Object.values(context.project.assets).map((asset) => asset.meta),
          ...context.project.timeline.tracks.flatMap((track) => [
            track.meta,
            ...track.clips.map((clip) => clip.meta),
          ]),
        ].find((meta) => meta.locked);
        if (lockedEntity) locked(lockedEntity.id, "project", operation.type);
      }
      const previous = structuredClone(context.project);
      const restored = structuredClone(operation.snapshot);
      touchEveryEntity(restored, context.command.actor.kind, context.nextRevision);
      context.project = restored;
      for (const id of allEntityIds(restored)) context.affected.add(id);
      if (operation.checkpointId) context.checkpointId = operation.checkpointId;
      context.inverseOperations.unshift({
        type: "project.restore",
        snapshot: previous,
      });
      return;
    }
  }
};

const normalizeTimeline = (project: ProductionProject) => {
  for (const track of project.timeline.tracks) {
    track.clips.sort(
      (left, right) => left.startFrame - right.startFrame || left.meta.id.localeCompare(right.meta.id),
    );
  }
  const latestClipEnd = project.timeline.tracks.reduce(
    (maximum, track) =>
      track.clips.reduce(
        (trackMaximum, clip) => Math.max(trackMaximum, clip.startFrame + clip.durationFrames),
        maximum,
      ),
    0,
  );
  const latestBeatEnd = project.script.beats.reduce(
    (maximum, beat) => Math.max(maximum, beat.startFrame + beat.durationFrames),
    0,
  );
  const duration = Math.max(project.metadata.durationFrames, latestClipEnd, latestBeatEnd);
  project.timeline.durationFrames = duration;
  project.metadata.durationFrames = duration;
};

const changedEntitiesSince = (project: ProductionProject, baseRevision: number): string[] => {
  const changed = new Set<string>();
  const includeMeta = (meta: EntityMeta) => {
    if (meta.revisionUpdated > baseRevision) changed.add(meta.id);
  };
  project.script.beats.forEach((beat) => includeMeta(beat.meta));
  project.scenes.forEach((scene) => includeMeta(scene.meta));
  Object.values(project.assets).forEach((asset) => includeMeta(asset.meta));
  includeMeta(project.timeline.meta);
  project.timeline.tracks.forEach((track) => {
    includeMeta(track.meta);
    track.clips.forEach((clip) => includeMeta(clip.meta));
  });
  project.decisions.forEach((decision) => includeMeta(decision.meta));
  for (const [name, state] of Object.entries(project.stages)) {
    if (state.revisionUpdated > baseRevision) changed.add(`stage:${name}`);
  }
  project.checkpoints.forEach((checkpoint) => {
    if (checkpoint.revision > baseRevision) changed.add(checkpoint.id);
  });
  return [...changed].sort();
};

/**
 * Applies a command against a private working snapshot. No caller-owned object is ever mutated;
 * any failing operation rejects the entire batch and returns the original project.
 */
export const applyProjectCommand = (
  project: ProductionProject,
  commandInput: ProjectCommandInput | unknown,
): ApplyProjectCommandResult => {
  const originalValidation = ProductionProjectSchema.safeParse(project);
  if (!originalValidation.success) {
    return {
      ok: false,
      project,
      error: {
        code: "INVARIANT_VIOLATION",
        summary: "The input project is not a valid Praxis project",
        issues: issueList(originalValidation.error),
      },
    };
  }

  const commandValidation = ProjectCommandSchema.safeParse(commandInput);
  if (!commandValidation.success) {
    return {
      ok: false,
      project,
      error: {
        code: "INVALID_OPERATION",
        summary: "The project command envelope or operations are invalid",
        issues: issueList(commandValidation.error),
      },
    };
  }
  const command = commandValidation.data;

  if (command.projectId !== project.projectId) {
    return {
      ok: false,
      project,
      error: {
        code: "INVALID_OPERATION",
        summary: `Command targets ${command.projectId}, not ${project.projectId}`,
      },
    };
  }

  if (command.baseRevision !== project.revision) {
    const changedEntities = changedEntitiesSince(project, command.baseRevision);
    return {
      ok: false,
      project,
      error: {
        code: "REVISION_CONFLICT",
        expectedRevision: command.baseRevision,
        currentRevision: project.revision,
        changedEntities,
        summary:
          changedEntities.length > 0
            ? `Project advanced to revision ${project.revision}; reread ${changedEntities.length} changed entities`
            : `Project is at revision ${project.revision}, not ${command.baseRevision}`,
      },
    };
  }

  const timestamp = command.createdAt ?? new Date().toISOString();
  const context: MutableApplyContext = {
    project: structuredClone(project),
    command,
    nextRevision: project.revision + 1,
    timestamp,
    affected: new Set(),
    invalidated: new Set(),
    inverseOperations: [],
    appliedOperationIds: [],
  };

  try {
    command.operations.forEach((operation, index) =>
      applyOne(context, operation, `${command.commandId}:${index}`),
    );
    normalizeTimeline(context.project);
    context.project.revision = context.nextRevision;
    context.project.metadata.updatedAt = timestamp;
    touchMeta(context.project.timeline.meta, command.actor.kind, context.nextRevision);

    const finalValidation = ProductionProjectSchema.safeParse(context.project);
    if (!finalValidation.success) {
      return {
        ok: false,
        project,
        error: {
          code: "INVARIANT_VIOLATION",
          summary: "The atomic batch would violate project invariants",
          issues: issueList(finalValidation.error),
        },
      };
    }

    // The materialized pre-command snapshot is the authoritative inverse. Granular inverses are
    // still computed while applying, but a snapshot also restores system-computed staleness and
    // stage state that are intentionally not represented as user-authored operations.
    const inverseCommand = ProjectCommandSchema.parse({
      commandId: `${command.commandId.slice(0, 120)}:inverse`,
      idempotencyKey: `${command.idempotencyKey.slice(0, 120)}:inverse`,
      projectId: project.projectId,
      baseRevision: context.nextRevision,
      actor: { kind: "system", sessionId: "session_history_inverse" },
      reason: `Undo: ${command.reason ?? command.commandId}`.slice(0, 500),
      createdAt: timestamp,
      dryRun: false,
      operations: [{ type: "project.restore", snapshot: originalValidation.data }],
    });
    const affectedEntityIds = [...context.affected].sort();
    const invalidatedEntityIds = [...context.invalidated].sort();

    if (command.dryRun) {
      return {
        ok: true,
        project,
        previewProject: finalValidation.data,
        result: {
          revision: project.revision,
          appliedOperationIds: context.appliedOperationIds,
          affectedEntityIds,
          invalidatedEntityIds,
          dryRun: true,
          checkpointId: context.checkpointId,
        },
        inverseCommand,
      };
    }

    return {
      ok: true,
      project: finalValidation.data,
      result: {
        revision: finalValidation.data.revision,
        appliedOperationIds: context.appliedOperationIds,
        affectedEntityIds,
        invalidatedEntityIds,
        dryRun: false,
        checkpointId: context.checkpointId,
      },
      inverseCommand,
    };
  } catch (error) {
    if (error instanceof DomainAbort) {
      return { ok: false, project, error: error.domainError };
    }
    throw error;
  }
};

/** Throwing convenience for trusted local call sites. */
export const requireAppliedProjectCommand = (
  project: ProductionProject,
  command: ProjectCommandInput | unknown,
): ApplyProjectCommandSuccess => {
  const result = applyProjectCommand(project, command);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.error));
  }
  return result;
};

export const isProjectCommandError = (value: unknown): value is ProjectCommandError => {
  if (!value || typeof value !== "object" || !("code" in value)) return false;
  return [
    "REVISION_CONFLICT",
    "ENTITY_LOCKED",
    "ENTITY_NOT_FOUND",
    "INVALID_OPERATION",
    "INVARIANT_VIOLATION",
    "ACTOR_NOT_AUTHORIZED",
  ].includes(String((value as { code: unknown }).code));
};

export const setEntityStatus = (meta: EntityMeta, status: EntityStatus) => {
  meta.status = status;
};

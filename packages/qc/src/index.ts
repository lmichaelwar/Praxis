import {
  JobRecordSchema,
  PersistedAssetRecordSchema,
  RenderRecordSchema,
  type JobRecord,
  type RenderRecord,
} from "@praxis/jobs";
import {
  ProductionProjectSchema,
  type ProductionProject,
} from "@praxis/project-schema";
import {
  RenderManifestCompileError,
  RenderManifestSchema,
  TrustedAssetMetadataSchema,
  canonicalSerialize,
  compileRenderManifest,
  sha256Hex,
  type RenderManifest,
  type RenderPreflightIssue,
  type TrustedAssetMetadata,
} from "@praxis/render-manifest";

/**
 * Deterministic structural quality control for Praxis projects and renders.
 * The legacy structural surface remains structurally typed; render preflight
 * and postflight parse canonical project, job, manifest, and render records at
 * their package boundaries and never mutate supplied values.
 */

export const QC_FINDING_CODES = [
  "MISSING_MEDIA",
  "FAILED_MEDIA",
  "STALE_MEDIA",
  "MISSING_PRIMARY_VIDEO",
  "PRIMARY_VIDEO_GAP",
  "PRIMARY_VIDEO_OVERLAP",
  "CLIP_OUT_OF_BOUNDS",
  "NARRATION_DURATION_MISMATCH",
  "LOCKED_STALE_ENTITY",
  "UNRESOLVED_PROPOSAL",
  "DELIVERY_FRAME_SIZE_MISMATCH",
  "DELIVERY_FPS_MISMATCH",
  "INVALID_PROJECT",
  "RENDER_REVISION_MISMATCH",
  "ASSET_METADATA_MISMATCH",
  "LOCKED_REQUIRED_ASSET",
  "LOCKED_REQUIRED_SCENE",
  "UNSUPPORTED_RENDER_CLIP",
  "UNSUPPORTED_RENDER_TRANSITION",
  "TIMELINE_DURATION_MISMATCH",
  "NARRATION_OUT_OF_BOUNDS",
  "EMPTY_VISUAL_INTERVAL",
  "INVALID_OUTPUT_SETTINGS",
  "OUTPUT_OBJECT_MISSING",
  "OUTPUT_OBJECT_EMPTY",
  "OUTPUT_CONTAINER_INVALID",
  "OUTPUT_VIDEO_STREAM_MISSING",
  "OUTPUT_AUDIO_STREAM_MISSING",
  "OUTPUT_STREAM_CODEC_MISMATCH",
  "OUTPUT_DIMENSIONS_MISMATCH",
  "OUTPUT_DURATION_MISMATCH",
  "OUTPUT_PIXEL_FORMAT_MISMATCH",
  "OUTPUT_HASH_MISSING",
  "OUTPUT_HASH_MISMATCH",
  "OUTPUT_METADATA_MISSING",
  "OUTPUT_METADATA_MISMATCH",
] as const;

export type QcFindingCode = (typeof QC_FINDING_CODES)[number];
export type QcSeverity = "error" | "warning" | "info";

export interface QcFinding {
  readonly severity: QcSeverity;
  readonly code: QcFindingCode;
  readonly entityIds: readonly string[];
  readonly message: string;
  readonly suggestedFix: string;
}

export interface QcSummary {
  readonly total: number;
  readonly counts: Readonly<Record<QcSeverity, number>>;
  readonly byCode: Readonly<Record<QcFindingCode, number>>;
  /** Warnings are non-blocking; passed is false only when errors exist. */
  readonly passed: boolean;
}

export interface QcReport {
  readonly projectId: string;
  readonly revision?: number;
  readonly findings: readonly QcFinding[];
  readonly summary: QcSummary;
}

export interface QcEntityMetaLike {
  id: string;
  status: string;
  locked: boolean;
}

export interface QcScriptBeatLike {
  meta: QcEntityMetaLike;
  startFrame: number;
  durationFrames: number;
  narration: string;
}

export interface QcSceneLike {
  meta: QcEntityMetaLike;
  requiredAssetIds: string[];
}

export interface QcAssetVersionLike {
  id: string;
  status: string;
  uri?: string;
  durationFrames?: number;
}

export interface QcAssetLike {
  meta: QcEntityMetaLike;
  kind: string;
  name: string;
  currentVersionId?: string;
  versions: QcAssetVersionLike[];
  tags?: string[];
}

export interface QcTimelineClipLike {
  meta: QcEntityMetaLike;
  kind: string;
  name: string;
  startFrame: number;
  durationFrames: number;
  sourceStartFrame?: number;
  sourceDurationFrames?: number;
  sceneId?: string;
  assetId?: string;
  assetVersionId?: string;
  versionPolicy?: string;
}

export interface QcTimelineTrackLike {
  meta: QcEntityMetaLike;
  name: string;
  kind: string;
  order: number;
  muted?: boolean;
  solo?: boolean;
  clips: QcTimelineClipLike[];
}

export interface QcDecisionLike {
  meta: QcEntityMetaLike;
  kind: string;
  status: string;
  title: string;
}

/** The minimal structural ProductionProject slice read by runStructuralQc. */
export interface QcProductionProjectLike {
  projectId: string;
  revision?: number;
  metadata: {
    fps: number;
    frameSize: { width: number; height: number };
    durationFrames: number;
  };
  script: { beats: QcScriptBeatLike[] };
  scenes: QcSceneLike[];
  assets: Record<string, QcAssetLike>;
  timeline: {
    meta: QcEntityMetaLike;
    fps: number;
    durationFrames: number;
    tracks: QcTimelineTrackLike[];
  };
  decisions: QcDecisionLike[];
  delivery: {
    width: number;
    height: number;
    fps: number;
  };
}

export interface RunStructuralQcOptions {
  /** Select a specific video track instead of the first unmuted track by order. */
  readonly primaryVideoTrackId?: string;
  /** Add explicit narration clips when naming/tag detection is insufficient. */
  readonly narrationClipIds?: readonly string[];
}

interface ClipEntry {
  readonly track: QcTimelineTrackLike;
  readonly clip: QcTimelineClipLike;
}

interface KnownEntity {
  readonly kind: string;
  readonly meta: QcEntityMetaLike;
}

const CODE_ORDER = new Map<QcFindingCode, number>(
  QC_FINDING_CODES.map((code, index) => [code, index]),
);

/** Run all deterministic structural checks and return a delivery-oriented report. */
export function runStructuralQc(
  project: QcProductionProjectLike,
  options: RunStructuralQcOptions = {},
): QcReport {
  const findings: QcFinding[] = [];
  const tracks = sortedTracks(project.timeline.tracks);
  const clipEntries = tracks.flatMap((track) =>
    sortedClips(track.clips).map((clip) => ({ track, clip })),
  );

  checkMedia(project, clipEntries, findings);
  checkPrimaryVideo(project, tracks, findings, options.primaryVideoTrackId);
  checkClipBounds(project, clipEntries, findings);
  checkNarrationDurations(
    project,
    clipEntries,
    findings,
    new Set(options.narrationClipIds ?? []),
  );
  checkLockedStaleEntities(project, tracks, findings);
  checkUnresolvedProposals(project, findings);
  checkDelivery(project, findings);

  findings.sort(compareFindings);

  return {
    projectId: project.projectId,
    ...(project.revision === undefined ? {} : { revision: project.revision }),
    findings,
    summary: summarize(findings),
  };
}

/** Short alias for consumers that already scope the call to structural QC. */
export const runQc = runStructuralQc;

export interface RunPreRenderQcInput {
  /** Untrusted boundaries are parsed with the canonical project schema. */
  readonly project: unknown;
  /** Durable asset records, never media bytes or signed URLs. */
  readonly assetRecords: readonly unknown[];
  readonly expectedRevision?: number;
  readonly outputKind?: "preview" | "final";
  readonly rendererVersion?: string;
}

export interface QcOutputStreamEvidence {
  readonly kind: "video" | "audio";
  readonly codec?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly pixelFormat?: string;
}

/** Evidence supplied by an object-store lookup and a bounded media probe. */
export interface QcOutputObjectEvidence {
  readonly objectKey?: string;
  readonly exists: boolean;
  readonly byteLength?: number;
  readonly sha256?: string;
  readonly mimeType?: string;
  /** Normalized container name or an ffprobe comma-separated format_name. */
  readonly container?: string;
  readonly durationMs?: number;
  readonly streams?: readonly QcOutputStreamEvidence[];
}

export interface RunPostRenderQcInput {
  readonly manifest: unknown;
  readonly video?: QcOutputObjectEvidence;
  readonly poster?: QcOutputObjectEvidence;
  /** Persisted authoritative metadata; absence is itself a QC finding. */
  readonly renderRecord?: unknown;
  /** Optional job context is validated when supplied. */
  readonly jobRecord?: unknown;
  /** Defaults to one frame plus 10ms. */
  readonly durationToleranceMs?: number;
  /** Defaults to true only when the manifest contains narration. */
  readonly requireAudio?: boolean;
}

export interface RenderQcReport extends QcReport {
  readonly phase: "pre-render" | "post-render";
}

const PRE_RENDER_STRUCTURAL_CODES = new Set<QcFindingCode>([
  "MISSING_MEDIA",
  "FAILED_MEDIA",
  "STALE_MEDIA",
  "MISSING_PRIMARY_VIDEO",
  "PRIMARY_VIDEO_GAP",
  "PRIMARY_VIDEO_OVERLAP",
  "CLIP_OUT_OF_BOUNDS",
  "NARRATION_DURATION_MISMATCH",
  "LOCKED_STALE_ENTITY",
  "DELIVERY_FRAME_SIZE_MISMATCH",
  "DELIVERY_FPS_MISMATCH",
]);

/**
 * Validate that one exact canonical revision can enter the bounded renderer.
 * This does no I/O: callers provide already-persisted asset metadata.
 */
export async function runPreRenderQc(input: RunPreRenderQcInput): Promise<RenderQcReport> {
  const findings: QcFinding[] = [];
  const fallbackProjectId = readStringProperty(input.project, "projectId") ?? "project_unknown";
  const fallbackRevision = readNumberProperty(input.project, "revision");
  const projectLike = asQcProjectLike(input.project);

  if (projectLike) {
    try {
      for (const structural of runStructuralQc(projectLike).findings) {
        if (!PRE_RENDER_STRUCTURAL_CODES.has(structural.code)) continue;
        if (structural.code === "PRIMARY_VIDEO_GAP" || structural.code === "MISSING_PRIMARY_VIDEO") {
          findings.push(finding(
            "EMPTY_VISUAL_INTERVAL",
            "error",
            structural.entityIds,
            structural.message,
            structural.suggestedFix,
          ));
        } else if (structural.code === "DELIVERY_FRAME_SIZE_MISMATCH" || structural.code === "DELIVERY_FPS_MISMATCH") {
          findings.push(finding(
            "INVALID_OUTPUT_SETTINGS",
            "error",
            structural.entityIds,
            structural.message,
            structural.suggestedFix,
          ));
        } else if (structural.code === "STALE_MEDIA") {
          findings.push({ ...structural, severity: "error" });
        } else {
          findings.push(structural);
        }
      }
      checkPreRenderProjectShape(projectLike, findings);
    } catch (error) {
      findings.push(finding(
        "INVALID_PROJECT",
        "error",
        [fallbackProjectId],
        `Structural preflight could not inspect the project: ${errorMessage(error)}.`,
        "Repair and revalidate the canonical project snapshot before rendering.",
      ));
    }
  }

  const parsedProject = ProductionProjectSchema.safeParse(input.project);
  if (!parsedProject.success) {
    for (const issue of parsedProject.error.issues) {
      const path = issue.path.join(".");
      const lowerMessage = issue.message.toLowerCase();
      let code: QcFindingCode = "INVALID_PROJECT";
      if (lowerMessage.includes("timeline and project durations") || path === "timeline.durationFrames") {
        code = "TIMELINE_DURATION_MISMATCH";
      } else if (path.startsWith("delivery") || lowerMessage.includes("frame rates must match")) {
        code = "INVALID_OUTPUT_SETTINGS";
      } else if (path.includes("timeline.tracks") && (path.endsWith("startFrame") || path.endsWith("durationFrames"))) {
        code = "CLIP_OUT_OF_BOUNDS";
      } else if (path.endsWith("assetVersionId") || lowerMessage.includes("unknown asset")) {
        code = "MISSING_MEDIA";
      }
      findings.push(finding(
        code,
        "error",
        [fallbackProjectId],
        `Canonical project validation failed at ${path || "project"}: ${issue.message}.`,
        "Repair the canonical snapshot through a validated project command before rendering.",
      ));
    }
    return renderQcReport("pre-render", fallbackProjectId, fallbackRevision, findings);
  }

  const project = parsedProject.data;
  const trustedRecords: TrustedAssetMetadata[] = [];
  for (const [index, candidate] of input.assetRecords.entries()) {
    const persisted = PersistedAssetRecordSchema.safeParse(candidate);
    const trusted = persisted.success ? TrustedAssetMetadataSchema.safeParse(persisted.data) : undefined;
    if (!persisted.success || !trusted?.success) {
      const detail = !persisted.success
        ? persisted.error.message
        : trusted && !trusted.success
          ? trusted.error.message
          : "invalid record";
      findings.push(finding(
        "ASSET_METADATA_MISMATCH",
        "error",
        [project.projectId],
        `Asset record ${index} is not valid trusted render metadata: ${detail ?? "invalid record"}.`,
        "Re-read the immutable object metadata and persist a schema-valid asset record.",
      ));
      continue;
    }
    trustedRecords.push(trusted.data);
  }

  if (trustedRecords.length === input.assetRecords.length) {
    try {
      await compileRenderManifest({
        project,
        expectedRevision: input.expectedRevision ?? project.revision,
        renderId: "render_qc_preflight",
        kind: input.outputKind ?? "preview",
        rendererVersion: input.rendererVersion ?? "praxis-ffmpeg-1",
        assetRecords: trustedRecords,
      });
    } catch (error) {
      if (error instanceof RenderManifestCompileError) {
        for (const issue of error.issues) findings.push(preflightIssueFinding(project, issue));
      } else {
        findings.push(finding(
          "INVALID_OUTPUT_SETTINGS",
          "error",
          [project.projectId],
          `The canonical project could not produce a bounded render manifest: ${errorMessage(error)}.`,
          "Correct timing, output, clip, or transition settings before dispatching the render.",
        ));
      }
    }
  }

  return renderQcReport("pre-render", project.projectId, project.revision, findings);
}

/**
 * Validate persisted render metadata against object-store and media-probe
 * evidence. This verifies structure only; it makes no perceptual claims.
 */
export async function runPostRenderQc(input: RunPostRenderQcInput): Promise<RenderQcReport> {
  const findings: QcFinding[] = [];
  const parsedManifest = RenderManifestSchema.safeParse(input.manifest);
  const fallbackProjectId = readStringProperty(input.manifest, "projectId") ?? "project_unknown";
  const fallbackRevision = readNumberProperty(input.manifest, "projectRevision");
  if (!parsedManifest.success) {
    findings.push(finding(
      "INVALID_PROJECT",
      "error",
      [fallbackProjectId],
      `Post-render QC received an invalid render manifest: ${parsedManifest.error.message}.`,
      "Load the immutable, schema-valid manifest used by the render worker.",
    ));
    return renderQcReport("post-render", fallbackProjectId, fallbackRevision, findings);
  }

  const manifest = parsedManifest.data;
  const identity = [manifest.projectId, manifest.renderId];
  const expectedManifestHash = await sha256Hex(canonicalSerialize(manifest));
  const video = input.video;
  if (!video?.exists) {
    findings.push(finding(
      "OUTPUT_OBJECT_MISSING",
      "error",
      identity,
      `Rendered MP4 ${quote(video?.objectKey ?? manifest.renderId)} is missing from object storage.`,
      "Recover or rerun the render and persist its immutable revision-scoped output object.",
    ));
  } else {
    checkVideoEvidence(manifest, video, input, findings);
  }

  const parsedRender = input.renderRecord === undefined
    ? undefined
    : RenderRecordSchema.safeParse(input.renderRecord);
  let renderRecord: RenderRecord | undefined;
  if (!parsedRender?.success) {
    findings.push(finding(
      "OUTPUT_METADATA_MISSING",
      "error",
      identity,
      parsedRender
        ? `Persisted render metadata is invalid: ${parsedRender.error.message}.`
        : "No persisted render record was supplied for the completed output.",
      "Persist a schema-valid immutable RenderRecord after probing and hashing the MP4.",
    ));
  } else {
    renderRecord = parsedRender.data;
    checkRenderRecord(manifest, expectedManifestHash, video, renderRecord, findings);
  }

  const parsedJob = input.jobRecord === undefined ? undefined : JobRecordSchema.safeParse(input.jobRecord);
  if (parsedJob && !parsedJob.success) {
    findings.push(finding(
      "OUTPUT_METADATA_MISSING",
      "error",
      identity,
      `Persisted render job metadata is invalid: ${parsedJob.error.message}.`,
      "Persist a schema-valid render JobRecord and its immutable output metadata.",
    ));
  } else if (parsedJob?.success) {
    checkRenderJob(manifest, expectedManifestHash, video, parsedJob.data, findings);
  }

  const expectedPosterKey = renderRecord?.posterObjectKey ??
    (parsedJob?.success ? parsedJob.data.output?.posterObjectKey : undefined);
  if (expectedPosterKey) checkPosterEvidence(manifest, expectedPosterKey, input.poster, parsedJob?.success ? parsedJob.data : undefined, findings);

  return renderQcReport("post-render", manifest.projectId, manifest.projectRevision, findings);
}

function asQcProjectLike(value: unknown): QcProductionProjectLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const project = value as Partial<QcProductionProjectLike>;
  if (
    typeof project.projectId !== "string" ||
    !project.metadata ||
    !project.script ||
    !Array.isArray(project.script.beats) ||
    !Array.isArray(project.scenes) ||
    !project.assets ||
    !project.timeline ||
    !Array.isArray(project.timeline.tracks) ||
    !Array.isArray(project.decisions) ||
    !project.delivery
  ) {
    return undefined;
  }
  return project as QcProductionProjectLike;
}

function checkPreRenderProjectShape(
  project: QcProductionProjectLike,
  findings: QcFinding[],
): void {
  if (project.timeline.durationFrames !== project.metadata.durationFrames) {
    findings.push(finding(
      "TIMELINE_DURATION_MISMATCH",
      "error",
      [project.projectId, project.timeline.meta.id],
      `Timeline duration ${project.timeline.durationFrames} does not match canonical project duration ${project.metadata.durationFrames}.`,
      "Align the timeline and project duration through a validated edit before rendering.",
    ));
  }

  const hasSolo = project.timeline.tracks.some((track) => track.solo === true);
  const activeTracks = project.timeline.tracks.filter(
    (track) => track.muted !== true && (!hasSolo || track.solo === true),
  );
  for (const track of activeTracks) {
    for (const clip of track.clips) {
      const scene = clip.sceneId
        ? project.scenes.find((candidate) => candidate.meta.id === clip.sceneId)
        : undefined;
      const asset = clip.assetId ? project.assets[clip.assetId] : undefined;
      if (scene?.meta.locked && ["scene", "image", "video"].includes(clip.kind)) {
        findings.push(finding(
          "LOCKED_REQUIRED_SCENE",
          "error",
          [scene.meta.id, clip.meta.id],
          `Required scene ${quote(scene.meta.id)} is director-locked for visual clip ${quote(clip.meta.id)}.`,
          "Have the director confirm and unlock the required scene, or render a revision whose required scene is not locked.",
        ));
      }
      if (asset?.meta.locked) {
        findings.push(finding(
          "LOCKED_REQUIRED_ASSET",
          "error",
          [asset.meta.id, clip.meta.id],
          `Required asset ${quote(asset.meta.id)} is director-locked for clip ${quote(clip.meta.id)}.`,
          "Have the director confirm and unlock the required asset before render dispatch.",
        ));
      }
      if (
        asset &&
        isNarrationClip(track, clip, asset, new Set()) &&
        clip.startFrame + clip.durationFrames > project.metadata.durationFrames
      ) {
        findings.push(finding(
          "NARRATION_OUT_OF_BOUNDS",
          "error",
          [clip.meta.id, asset.meta.id],
          `Narration clip ${quote(clip.meta.id)} ends at frame ${clip.startFrame + clip.durationFrames}, beyond project frame ${project.metadata.durationFrames}.`,
          "Trim or move the narration, or intentionally extend the canonical project duration.",
        ));
      }
    }
  }

  const delivery = project.delivery as QcProductionProjectLike["delivery"] & {
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
  };
  const invalidBound =
    !Number.isSafeInteger(delivery.width) ||
    !Number.isSafeInteger(delivery.height) ||
    !Number.isSafeInteger(delivery.fps) ||
    delivery.width < 2 ||
    delivery.height < 2 ||
    delivery.width > 3_840 ||
    delivery.height > 2_160 ||
    delivery.width % 2 !== 0 ||
    delivery.height % 2 !== 0 ||
    delivery.fps < 1 ||
    delivery.fps > 60;
  const unsupportedEncoding =
    (delivery.container !== undefined && delivery.container !== "mp4") ||
    (delivery.videoCodec !== undefined && delivery.videoCodec !== "h264") ||
    (delivery.audioCodec !== undefined && delivery.audioCodec !== "aac");
  const invalidDuration =
    project.timeline.durationFrames <= 0 ||
    project.timeline.durationFrames / Math.max(1, delivery.fps) > 600;
  if (invalidBound || unsupportedEncoding || invalidDuration) {
    findings.push(finding(
      "INVALID_OUTPUT_SETTINGS",
      "error",
      [project.projectId, project.timeline.meta.id],
      `Output settings ${delivery.width}×${delivery.height} at ${delivery.fps}fps are outside the bounded H.264/AAC MP4 renderer.`,
      "Use positive even dimensions up to 3840×2160, 1–60fps, H.264/AAC MP4, and a duration no longer than ten minutes.",
    ));
  }
}

function preflightIssueFinding(
  project: ProductionProject,
  issue: RenderPreflightIssue,
): QcFinding {
  const entityIds = [issue.entityId ?? project.projectId];
  switch (issue.code) {
    case "REVISION_MISMATCH":
      return finding(
        "RENDER_REVISION_MISMATCH",
        "error",
        entityIds,
        issue.message,
        "Reload the exact requested project revision before compiling the immutable manifest.",
      );
    case "UNSUPPORTED_DELIVERY":
      return finding(
        "INVALID_OUTPUT_SETTINGS",
        "error",
        entityIds,
        issue.message,
        "Select the bounded H.264/AAC MP4 delivery profile.",
      );
    case "UNSUPPORTED_CLIP":
      return finding(
        "UNSUPPORTED_RENDER_CLIP",
        "error",
        entityIds,
        issue.message,
        "Replace or simplify the clip to the supported still-image, text, narration, or audio subset.",
      );
    case "UNSUPPORTED_TRANSITION":
      return finding(
        "UNSUPPORTED_RENDER_TRANSITION",
        "error",
        entityIds,
        issue.message,
        "Use a bounded fade, inbound dissolve, or outbound fade-to-black transition.",
      );
    case "MISSING_ASSET":
    case "MEDIA_NOT_READY":
      return finding(
        "MISSING_MEDIA",
        "error",
        entityIds,
        issue.message,
        "Persist and select a ready immutable asset version before rendering.",
      );
    case "STALE_MEDIA":
      return finding(
        "STALE_MEDIA",
        "error",
        entityIds,
        issue.message,
        "Regenerate or explicitly approve the stale required media before rendering.",
      );
    case "ASSET_MISMATCH":
      return finding(
        "ASSET_METADATA_MISMATCH",
        "error",
        entityIds,
        issue.message,
        "Reconcile canonical asset metadata with its immutable persisted object record.",
      );
  }
}

function checkVideoEvidence(
  manifest: RenderManifest,
  video: QcOutputObjectEvidence,
  input: RunPostRenderQcInput,
  findings: QcFinding[],
): void {
  const identity = [manifest.projectId, manifest.renderId];
  const expectedKey = `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.mp4`;
  if (!video.objectKey) {
    findings.push(finding(
      "OUTPUT_METADATA_MISSING",
      "error",
      identity,
      "The rendered MP4 has no recorded immutable object key.",
      "Record the revision-scoped output object key after upload.",
    ));
  } else if (video.objectKey !== expectedKey) {
    findings.push(finding(
      "OUTPUT_METADATA_MISMATCH",
      "error",
      identity,
      `Rendered MP4 key ${quote(video.objectKey)} does not match ${quote(expectedKey)}.`,
      "Persist the output at the manifest's immutable revision-scoped key.",
    ));
  }

  if (video.byteLength === 0) {
    findings.push(finding(
      "OUTPUT_OBJECT_EMPTY",
      "error",
      identity,
      "The rendered MP4 exists but contains zero bytes.",
      "Rerun the renderer and upload a nonempty validated MP4.",
    ));
  } else if (!Number.isSafeInteger(video.byteLength) || (video.byteLength ?? -1) < 0) {
    findings.push(finding(
      "OUTPUT_METADATA_MISSING",
      "error",
      identity,
      "The rendered MP4 has no valid byte-length metadata.",
      "Record the object byte length after upload.",
    ));
  }

  if (!isSha256(video.sha256)) {
    findings.push(finding(
      "OUTPUT_HASH_MISSING",
      "error",
      identity,
      "The rendered MP4 has no lowercase SHA-256 evidence.",
      "Hash the uploaded bytes and record their SHA-256 digest.",
    ));
  }

  const containerNames = new Set((video.container ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  if (video.mimeType !== "video/mp4" || !containerNames.has("mp4")) {
    findings.push(finding(
      "OUTPUT_CONTAINER_INVALID",
      "error",
      identity,
      `Rendered output is ${video.mimeType ?? "unknown MIME"} in ${video.container ?? "an unknown container"}, not MP4.`,
      "Produce and probe a browser-compatible video/mp4 container.",
    ));
  }

  const streams = video.streams ?? [];
  const videoStream = streams.find((stream) => stream.kind === "video");
  const audioStream = streams.find((stream) => stream.kind === "audio");
  if (!videoStream) {
    findings.push(finding(
      "OUTPUT_VIDEO_STREAM_MISSING",
      "error",
      identity,
      "The rendered MP4 has no video stream.",
      "Rerun the render and require a probed H.264 video stream.",
    ));
  } else {
    if (videoStream.codec !== manifest.output.videoCodec) {
      findings.push(finding(
        "OUTPUT_STREAM_CODEC_MISMATCH",
        "error",
        identity,
        `Video codec ${videoStream.codec ?? "unknown"} does not match ${manifest.output.videoCodec}.`,
        "Encode the video stream with the manifest codec.",
      ));
    }
    if (videoStream.width !== manifest.canvas.width || videoStream.height !== manifest.canvas.height) {
      findings.push(finding(
        "OUTPUT_DIMENSIONS_MISMATCH",
        "error",
        identity,
        `Probed dimensions ${videoStream.width ?? "?"}×${videoStream.height ?? "?"} do not match ${manifest.canvas.width}×${manifest.canvas.height}.`,
        "Render at the manifest canvas dimensions.",
      ));
    }
    if (videoStream.pixelFormat !== manifest.output.pixelFormat) {
      findings.push(finding(
        "OUTPUT_PIXEL_FORMAT_MISMATCH",
        "error",
        identity,
        `Pixel format ${videoStream.pixelFormat ?? "unknown"} does not match ${manifest.output.pixelFormat}.`,
        "Encode the MP4 with browser-compatible yuv420p pixels.",
      ));
    }
  }

  const audioRequired = input.requireAudio ?? manifest.audio.some((clip) => clip.type === "narration");
  if (audioRequired && !audioStream) {
    findings.push(finding(
      "OUTPUT_AUDIO_STREAM_MISSING",
      "error",
      identity,
      "The manifest contains narration but the rendered MP4 has no audio stream.",
      "Mux the expected AAC narration stream into the output.",
    ));
  } else if (audioStream && audioStream.codec !== manifest.output.audioCodec) {
    findings.push(finding(
      "OUTPUT_STREAM_CODEC_MISMATCH",
      "error",
      identity,
      `Audio codec ${audioStream.codec ?? "unknown"} does not match ${manifest.output.audioCodec}.`,
      "Encode the audio stream with the manifest codec.",
    ));
  }

  const durationMs = video.durationMs ?? videoStream?.durationMs;
  const expectedDurationMs = (manifest.canvas.durationFrames / manifest.canvas.fps) * 1_000;
  const defaultTolerance = Math.ceil(1_000 / manifest.canvas.fps) + 10;
  const tolerance = Number.isFinite(input.durationToleranceMs) && (input.durationToleranceMs ?? -1) >= 0
    ? input.durationToleranceMs!
    : defaultTolerance;
  if (!Number.isFinite(durationMs)) {
    findings.push(finding(
      "OUTPUT_METADATA_MISSING",
      "error",
      identity,
      "The rendered MP4 has no probed duration metadata.",
      "Record the bounded media-probe duration before accepting the output.",
    ));
  } else if (Math.abs((durationMs as number) - expectedDurationMs) > tolerance) {
    findings.push(finding(
      "OUTPUT_DURATION_MISMATCH",
      "error",
      identity,
      `Probed duration ${durationMs}ms differs from expected ${Math.round(expectedDurationMs)}ms by more than ${tolerance}ms.`,
      "Render the exact manifest duration or explicitly revise the duration tolerance.",
    ));
  }
}

function checkRenderRecord(
  manifest: RenderManifest,
  expectedManifestHash: string,
  video: QcOutputObjectEvidence | undefined,
  record: RenderRecord,
  findings: QcFinding[],
): void {
  const identity = [manifest.projectId, manifest.renderId, record.jobId];
  const mismatches: string[] = [];
  if (record.renderId !== manifest.renderId) mismatches.push("render ID");
  if (record.projectId !== manifest.projectId) mismatches.push("project ID");
  if (record.projectRevision !== manifest.projectRevision) mismatches.push("project revision");
  if (record.manifestHash !== expectedManifestHash) mismatches.push("manifest hash");
  if (video?.objectKey && record.outputObjectKey !== video.objectKey) mismatches.push("output object key");
  if (video?.byteLength !== undefined && record.byteLength !== video.byteLength) mismatches.push("byte length");
  const videoStream = video?.streams?.find((stream) => stream.kind === "video");
  if (videoStream?.width !== undefined && record.width !== videoStream.width) mismatches.push("width");
  if (videoStream?.height !== undefined && record.height !== videoStream.height) mismatches.push("height");
  if (video?.durationMs !== undefined && record.durationMs !== video.durationMs) mismatches.push("duration");
  if (record.videoCodec !== manifest.output.videoCodec) mismatches.push("video codec");
  if (manifest.audio.some((clip) => clip.type === "narration") && record.audioCodec !== manifest.output.audioCodec) mismatches.push("audio codec");
  if (record.pixelFormat !== manifest.output.pixelFormat) mismatches.push("pixel format");
  if (mismatches.length) {
    findings.push(finding(
      "OUTPUT_METADATA_MISMATCH",
      "error",
      identity,
      `Persisted RenderRecord disagrees with render evidence or manifest for: ${mismatches.join(", ")}.`,
      "Persist metadata from the exact immutable manifest and probed output revision.",
    ));
  }
  if (isSha256(video?.sha256) && record.sha256 !== video?.sha256) {
    findings.push(finding(
      "OUTPUT_HASH_MISMATCH",
      "error",
      identity,
      "Persisted render SHA-256 does not match the uploaded MP4 hash evidence.",
      "Reject the output and reconcile or regenerate the immutable object.",
    ));
  }
}

function checkRenderJob(
  manifest: RenderManifest,
  expectedManifestHash: string,
  video: QcOutputObjectEvidence | undefined,
  job: JobRecord,
  findings: QcFinding[],
): void {
  const identity = [manifest.projectId, manifest.renderId, job.jobId];
  const mismatches: string[] = [];
  if (job.jobType !== "render.preview" && job.jobType !== "render.final") mismatches.push("job type");
  if (job.projectId !== manifest.projectId) mismatches.push("project ID");
  if (job.baseRevision !== manifest.projectRevision) mismatches.push("base revision");
  if (job.output) {
    if (job.output.renderId !== manifest.renderId) mismatches.push("output render ID");
    if (job.output.projectRevision !== manifest.projectRevision) mismatches.push("output revision");
    if (video?.objectKey && job.output.objectKey !== video.objectKey) mismatches.push("output object key");
    if (video?.byteLength !== undefined && job.output.byteLength !== video.byteLength) mismatches.push("output byte length");
    if (isSha256(video?.sha256) && job.output.sha256 !== video?.sha256) mismatches.push("output hash");
    if (job.output.metadata.manifestSha256 !== expectedManifestHash) mismatches.push("output manifest hash");
  } else if (job.status === "succeeded") {
    findings.push(finding(
      "OUTPUT_METADATA_MISSING",
      "error",
      identity,
      "Succeeded render job has no immutable output metadata.",
      "Attach the schema-valid render output when settling the job.",
    ));
  }
  if (mismatches.length) {
    findings.push(finding(
      "OUTPUT_METADATA_MISMATCH",
      "error",
      identity,
      `Persisted render JobRecord disagrees with the manifest or object evidence for: ${mismatches.join(", ")}.`,
      "Settle the job with metadata from the exact rendered revision.",
    ));
  }
}

function checkPosterEvidence(
  manifest: RenderManifest,
  expectedKey: string,
  poster: QcOutputObjectEvidence | undefined,
  job: JobRecord | undefined,
  findings: QcFinding[],
): void {
  const identity = [manifest.projectId, manifest.renderId];
  if (!poster?.exists) {
    findings.push(finding(
      "OUTPUT_OBJECT_MISSING",
      "error",
      identity,
      `Referenced poster object ${quote(expectedKey)} is missing from object storage.`,
      "Upload and verify the immutable poster object referenced by the render metadata.",
    ));
    return;
  }
  if (poster.objectKey !== expectedKey) {
    findings.push(finding(
      "OUTPUT_METADATA_MISMATCH",
      "error",
      identity,
      `Poster evidence key ${quote(poster.objectKey ?? "missing")} does not match ${quote(expectedKey)}.`,
      "Probe the exact poster object referenced by the render record.",
    ));
  }
  if (!Number.isSafeInteger(poster.byteLength) || (poster.byteLength ?? 0) <= 0) {
    findings.push(finding(
      "OUTPUT_OBJECT_EMPTY",
      "error",
      identity,
      "Referenced poster output is empty or lacks valid byte-length metadata.",
      "Upload a nonempty poster and record its byte length.",
    ));
  }
  if (!isSha256(poster.sha256)) {
    findings.push(finding(
      "OUTPUT_HASH_MISSING",
      "error",
      identity,
      "Referenced poster output has no SHA-256 evidence.",
      "Hash the uploaded poster bytes and record their digest.",
    ));
  } else if (job?.output?.posterSha256 && job.output.posterSha256 !== poster.sha256) {
    findings.push(finding(
      "OUTPUT_HASH_MISMATCH",
      "error",
      identity,
      "Persisted poster SHA-256 does not match object-store evidence.",
      "Reject and regenerate or reconcile the immutable poster object.",
    ));
  }
}

function renderQcReport(
  phase: RenderQcReport["phase"],
  projectId: string,
  revision: number | undefined,
  findings: readonly QcFinding[],
): RenderQcReport {
  const deduplicated = new Map<string, QcFinding>();
  for (const current of findings) {
    const key = [current.code, current.severity, current.entityIds.join("\u0000"), current.message].join("\u0001");
    deduplicated.set(key, current);
  }
  const ordered = [...deduplicated.values()].sort(compareFindings);
  return {
    phase,
    projectId,
    ...(revision === undefined ? {} : { revision }),
    findings: ordered,
    summary: summarize(ordered),
  };
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function readNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "unknown structural error";
}

function checkMedia(
  project: QcProductionProjectLike,
  clipEntries: readonly ClipEntry[],
  findings: QcFinding[],
): void {
  const references = new Map<string, Set<string>>();
  const addReference = (assetId: string, entityId: string): void => {
    const entityIds = references.get(assetId) ?? new Set<string>();
    entityIds.add(entityId);
    references.set(assetId, entityIds);
  };

  for (const scene of [...project.scenes].sort(compareEntityMeta)) {
    for (const assetId of [...scene.requiredAssetIds].sort()) {
      addReference(assetId, scene.meta.id);
    }
  }

  for (const { clip } of clipEntries) {
    if (clip.assetId) {
      addReference(clip.assetId, clip.meta.id);
    } else if (clip.kind === "placeholder") {
      findings.push(
        finding(
          "MISSING_MEDIA",
          "warning",
          [clip.meta.id],
          `Placeholder clip ${quote(clip.meta.id)} has no production media.`,
          "Replace the placeholder with an approved scene or media asset before final delivery.",
        ),
      );
    } else if (mediaClipRequiresAsset(clip.kind)) {
      findings.push(
        finding(
          "MISSING_MEDIA",
          "error",
          [clip.meta.id],
          `${titleCase(clip.kind)} clip ${quote(clip.meta.id)} does not reference an asset.`,
          "Attach an asset and an approved version to the clip.",
        ),
      );
    }
  }

  for (const [assetId, entityIds] of [...references.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!project.assets[assetId]) {
      findings.push(
        finding(
          "MISSING_MEDIA",
          "error",
          [assetId, ...[...entityIds].sort()],
          `Referenced asset ${quote(assetId)} is missing from the project media registry.`,
          "Restore the asset record or relink every scene and clip that references it.",
        ),
      );
    }
  }

  for (const [assetKey, asset] of Object.entries(project.assets).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const referenceIds = [...(references.get(assetKey) ?? [])].sort();
    const assetIds = uniqueIds([assetKey, asset.meta.id, ...referenceIds]);

    if (!asset.currentVersionId) {
      findings.push(
        finding(
          "MISSING_MEDIA",
          "error",
          assetIds,
          `Asset ${quote(assetKey)} has no current media version selected.`,
          "Select a ready or approved version, or generate the missing media.",
        ),
      );
      continue;
    }

    const version = asset.versions.find(
      (candidate) => candidate.id === asset.currentVersionId,
    );
    if (!version) {
      findings.push(
        finding(
          "MISSING_MEDIA",
          "error",
          uniqueIds([...assetIds, asset.currentVersionId]),
          `Asset ${quote(assetKey)} selects missing version ${quote(asset.currentVersionId)}.`,
          "Relink currentVersionId to an existing version or restore the missing version.",
        ),
      );
      continue;
    }

    assessMediaVersion(
      assetKey,
      asset,
      version,
      uniqueIds([...assetIds, version.id]),
      true,
      findings,
    );
  }

  for (const { clip } of clipEntries) {
    if (!clip.assetId) {
      continue;
    }
    const asset = project.assets[clip.assetId];
    if (!asset) {
      continue;
    }

    if (!clip.assetVersionId && clip.versionPolicy !== "follow-latest") {
      findings.push(
        finding(
          "MISSING_MEDIA",
          "error",
          [clip.meta.id, clip.assetId],
          `Pinned clip ${quote(clip.meta.id)} does not identify a media version.`,
          "Pin the clip to an existing approved version or switch it to follow-latest.",
        ),
      );
      continue;
    }

    const requestedVersionId =
      clip.assetVersionId ??
      (clip.versionPolicy === "follow-latest" ? asset.currentVersionId : undefined);
    if (!requestedVersionId) {
      continue;
    }
    const version = asset.versions.find(
      (candidate) => candidate.id === requestedVersionId,
    );
    if (!version) {
      findings.push(
        finding(
          "MISSING_MEDIA",
          "error",
          [clip.meta.id, clip.assetId, requestedVersionId],
          `Clip ${quote(clip.meta.id)} references missing media version ${quote(requestedVersionId)}.`,
          "Relink the clip to a version that belongs to its asset.",
        ),
      );
      continue;
    }

    // Current-version health was already reported with all known references.
    if (version.id !== asset.currentVersionId) {
      assessMediaVersion(
        clip.assetId,
        asset,
        version,
        [clip.meta.id, clip.assetId, version.id],
        false,
        findings,
      );
    }
  }
}

function assessMediaVersion(
  assetId: string,
  asset: QcAssetLike,
  version: QcAssetVersionLike,
  entityIds: readonly string[],
  includeAssetStatus: boolean,
  findings: QcFinding[],
): void {
  const failed =
    version.status === "failed" ||
    (includeAssetStatus && asset.meta.status === "failed");
  const stale =
    version.status === "stale" ||
    (includeAssetStatus && asset.meta.status === "stale");

  if (failed) {
    findings.push(
      finding(
        "FAILED_MEDIA",
        "error",
        entityIds,
        `Media ${quote(version.id)} for asset ${quote(assetId)} is failed.`,
        "Regenerate the failed version or relink consumers to a healthy approved version.",
      ),
    );
  } else if (stale) {
    findings.push(
      finding(
        "STALE_MEDIA",
        "warning",
        entityIds,
        `Media ${quote(version.id)} for asset ${quote(assetId)} is stale.`,
        "Regenerate or re-approve the asset after reviewing its upstream changes.",
      ),
    );
  } else if (["planned", "generating", "rejected"].includes(version.status)) {
    findings.push(
      finding(
        "MISSING_MEDIA",
        "error",
        entityIds,
        `Media ${quote(version.id)} for asset ${quote(assetId)} is not usable (${version.status}).`,
        "Select a ready or approved version before delivery.",
      ),
    );
  }

  if (typeof version.uri !== "string" || version.uri.trim().length === 0) {
    findings.push(
      finding(
        "MISSING_MEDIA",
        "error",
        entityIds,
        `Media version ${quote(version.id)} has no source URI.`,
        "Restore the media URI or regenerate the version.",
      ),
    );
  }
}

function checkPrimaryVideo(
  project: QcProductionProjectLike,
  tracks: readonly QcTimelineTrackLike[],
  findings: QcFinding[],
  requestedTrackId?: string,
): void {
  const primaryTrack = requestedTrackId
    ? tracks.find(
        (track) =>
          track.meta.id === requestedTrackId && track.kind === "video",
      )
    : tracks.find((track) => track.kind === "video" && track.muted !== true);

  if (!primaryTrack) {
    findings.push(
      finding(
        "MISSING_PRIMARY_VIDEO",
        "error",
        uniqueIds([project.timeline.meta.id, requestedTrackId]),
        requestedTrackId
          ? `Requested primary video track ${quote(requestedTrackId)} is unavailable.`
          : "The timeline has no unmuted primary video track.",
        "Create or unmute a video track that covers the delivery timeline.",
      ),
    );
    return;
  }

  const timelineDuration = Math.max(0, project.timeline.durationFrames);
  if (timelineDuration === 0) {
    return;
  }

  const clips = sortedClips(primaryTrack.clips).filter(
    (clip) =>
      Number.isFinite(clip.startFrame) &&
      Number.isFinite(clip.durationFrames) &&
      clip.durationFrames > 0 &&
      clip.startFrame < timelineDuration &&
      clip.startFrame + clip.durationFrames > 0,
  );
  let coveredUntil = 0;
  let coveringClipId: string | undefined;

  for (const clip of clips) {
    const start = clamp(clip.startFrame, 0, timelineDuration);
    const end = clamp(
      clip.startFrame + clip.durationFrames,
      0,
      timelineDuration,
    );
    if (end <= start) {
      continue;
    }

    if (start > coveredUntil) {
      findings.push(
        finding(
          "PRIMARY_VIDEO_GAP",
          "warning",
          uniqueIds([primaryTrack.meta.id, coveringClipId, clip.meta.id]),
          `Primary video has an uncovered interval at frames [${coveredUntil}, ${start}).`,
          "Extend, move, or insert a primary-video clip to cover the interval.",
        ),
      );
    } else if (start < coveredUntil) {
      const overlapEnd = Math.min(coveredUntil, end);
      if (overlapEnd > start) {
        findings.push(
          finding(
            "PRIMARY_VIDEO_OVERLAP",
            "warning",
            uniqueIds([
              primaryTrack.meta.id,
              coveringClipId,
              clip.meta.id,
            ]),
            `Primary video clips overlap at frames [${start}, ${overlapEnd}).`,
            "Trim or reposition the clips, or explicitly model the intended transition.",
          ),
        );
      }
    }

    if (end > coveredUntil) {
      coveredUntil = end;
      coveringClipId = clip.meta.id;
    }
  }

  if (coveredUntil < timelineDuration) {
    findings.push(
      finding(
        "PRIMARY_VIDEO_GAP",
        "warning",
        uniqueIds([primaryTrack.meta.id, coveringClipId]),
        `Primary video has an uncovered interval at frames [${coveredUntil}, ${timelineDuration}).`,
        "Extend or insert a primary-video clip through the end of the timeline.",
      ),
    );
  }
}

function checkClipBounds(
  project: QcProductionProjectLike,
  clipEntries: readonly ClipEntry[],
  findings: QcFinding[],
): void {
  const duration = project.timeline.durationFrames;
  for (const { track, clip } of clipEntries) {
    const end = clip.startFrame + clip.durationFrames;
    if (
      !Number.isSafeInteger(clip.startFrame) ||
      !Number.isSafeInteger(clip.durationFrames) ||
      clip.startFrame < 0 ||
      clip.durationFrames <= 0 ||
      !Number.isSafeInteger(end) ||
      end > duration
    ) {
      findings.push(
        finding(
          "CLIP_OUT_OF_BOUNDS",
          "error",
          [track.meta.id, clip.meta.id],
          `Clip ${quote(clip.meta.id)} occupies frames [${clip.startFrame}, ${end}) outside timeline [0, ${duration}).`,
          "Move or trim the clip so its entire positive-duration range is inside the timeline.",
        ),
      );
    }
  }
}

function checkNarrationDurations(
  project: QcProductionProjectLike,
  clipEntries: readonly ClipEntry[],
  findings: QcFinding[],
  explicitNarrationClipIds: ReadonlySet<string>,
): void {
  for (const { track, clip } of clipEntries) {
    if (!clip.assetId) {
      continue;
    }
    const asset = project.assets[clip.assetId];
    if (
      !asset ||
      !isNarrationClip(track, clip, asset, explicitNarrationClipIds)
    ) {
      continue;
    }
    const version = resolveClipVersion(clip, asset);
    if (!version || !Number.isSafeInteger(version.durationFrames)) {
      continue;
    }

    const mediaDuration = version.durationFrames as number;
    const sourceStart = Number.isSafeInteger(clip.sourceStartFrame)
      ? (clip.sourceStartFrame as number)
      : 0;
    const sourceDuration = clip.sourceDurationFrames;
    const reasons: string[] = [];

    if (Number.isSafeInteger(sourceDuration)) {
      if (clip.durationFrames !== sourceDuration) {
        reasons.push(
          `timeline duration ${clip.durationFrames} does not match explicit source duration ${sourceDuration}`,
        );
      }
      if (sourceStart + (sourceDuration as number) > mediaDuration) {
        reasons.push(
          `source range ends at ${sourceStart + (sourceDuration as number)}, beyond media duration ${mediaDuration}`,
        );
      }
    } else if (sourceStart + clip.durationFrames > mediaDuration) {
      reasons.push(
        `required source range ends at ${sourceStart + clip.durationFrames}, beyond media duration ${mediaDuration}`,
      );
    }

    if (reasons.length > 0) {
      findings.push(
        finding(
          "NARRATION_DURATION_MISMATCH",
          "error",
          [clip.meta.id, clip.assetId, version.id],
          `Narration clip ${quote(clip.meta.id)} has a duration mismatch: ${reasons.join("; ")}.`,
          "Align the clip and source ranges, or regenerate narration with sufficient duration.",
        ),
      );
    }
  }
}

function checkLockedStaleEntities(
  project: QcProductionProjectLike,
  tracks: readonly QcTimelineTrackLike[],
  findings: QcFinding[],
): void {
  const entities: KnownEntity[] = [
    ...project.script.beats.map((beat) => ({ kind: "script beat", meta: beat.meta })),
    ...project.scenes.map((scene) => ({ kind: "scene", meta: scene.meta })),
    ...Object.values(project.assets).map((asset) => ({ kind: "asset", meta: asset.meta })),
    { kind: "timeline", meta: project.timeline.meta },
    ...tracks.map((track) => ({ kind: "track", meta: track.meta })),
    ...tracks.flatMap((track) =>
      track.clips.map((clip) => ({ kind: "clip", meta: clip.meta })),
    ),
    ...project.decisions.map((decision) => ({ kind: "decision", meta: decision.meta })),
  ].sort((left, right) =>
    left.meta.id.localeCompare(right.meta.id) || left.kind.localeCompare(right.kind),
  );
  const seenIds = new Set<string>();

  for (const entity of entities) {
    if (seenIds.has(entity.meta.id)) {
      continue;
    }
    seenIds.add(entity.meta.id);
    if (entity.meta.locked && entity.meta.status === "stale") {
      findings.push(
        finding(
          "LOCKED_STALE_ENTITY",
          "error",
          [entity.meta.id],
          `Locked ${entity.kind} ${quote(entity.meta.id)} is stale and cannot be refreshed automatically.`,
          "Have the director review the upstream change, then unlock for regeneration or explicitly re-approve the entity.",
        ),
      );
    }
  }
}

function checkUnresolvedProposals(
  project: QcProductionProjectLike,
  findings: QcFinding[],
): void {
  const pending = project.decisions
    .filter(
      (decision) => decision.kind === "proposal" && decision.status === "pending",
    )
    .sort(compareEntityMeta);

  for (const proposal of pending) {
    findings.push(
      finding(
        "UNRESOLVED_PROPOSAL",
        "warning",
        [proposal.meta.id],
        `Proposal ${quote(proposal.title)} (${proposal.meta.id}) is unresolved.`,
        "Accept, reject, or supersede the proposal before final delivery.",
      ),
    );
  }
}

function checkDelivery(
  project: QcProductionProjectLike,
  findings: QcFinding[],
): void {
  const projectEntityIds = uniqueIds([
    project.projectId,
    project.timeline.meta.id,
  ]);
  const expectedSize = project.metadata.frameSize;

  if (
    project.delivery.width !== expectedSize.width ||
    project.delivery.height !== expectedSize.height
  ) {
    findings.push(
      finding(
        "DELIVERY_FRAME_SIZE_MISMATCH",
        "error",
        projectEntityIds,
        `Delivery frame size ${project.delivery.width}×${project.delivery.height} does not match project frame size ${expectedSize.width}×${expectedSize.height}.`,
        "Set delivery width and height to the canonical project frame size, or intentionally revise the project format.",
      ),
    );
  }

  if (
    project.delivery.fps !== project.metadata.fps ||
    project.delivery.fps !== project.timeline.fps
  ) {
    findings.push(
      finding(
        "DELIVERY_FPS_MISMATCH",
        "error",
        projectEntityIds,
        `Delivery fps ${project.delivery.fps} does not match project fps ${project.metadata.fps} and timeline fps ${project.timeline.fps}.`,
        "Align delivery, project, and timeline frame rates before rendering.",
      ),
    );
  }
}

function resolveClipVersion(
  clip: QcTimelineClipLike,
  asset: QcAssetLike,
): QcAssetVersionLike | undefined {
  const versionId = clip.assetVersionId ?? asset.currentVersionId;
  return versionId
    ? asset.versions.find((version) => version.id === versionId)
    : undefined;
}

function isNarrationClip(
  track: QcTimelineTrackLike,
  clip: QcTimelineClipLike,
  asset: QcAssetLike,
  explicitIds: ReadonlySet<string>,
): boolean {
  if (explicitIds.has(clip.meta.id)) {
    return true;
  }
  if (track.kind !== "audio" || asset.kind !== "audio") {
    return false;
  }
  const descriptiveText = [
    track.name,
    clip.name,
    asset.name,
    ...(asset.tags ?? []),
  ].join(" ");
  return /\b(?:narration|narrator|voiceover|voice-over|voice|dialogue|dialog|vo)\b/i.test(
    descriptiveText,
  );
}

function mediaClipRequiresAsset(kind: string): boolean {
  return ["image", "audio", "music", "video"].includes(kind);
}

function sortedTracks(
  tracks: readonly QcTimelineTrackLike[],
): QcTimelineTrackLike[] {
  return [...tracks].sort(
    (left, right) =>
      left.order - right.order || left.meta.id.localeCompare(right.meta.id),
  );
}

function sortedClips(
  clips: readonly QcTimelineClipLike[],
): QcTimelineClipLike[] {
  return [...clips].sort(
    (left, right) =>
      left.startFrame - right.startFrame ||
      left.durationFrames - right.durationFrames ||
      left.meta.id.localeCompare(right.meta.id),
  );
}

function compareEntityMeta(
  left: { meta: QcEntityMetaLike },
  right: { meta: QcEntityMetaLike },
): number {
  return left.meta.id.localeCompare(right.meta.id);
}

function finding(
  code: QcFindingCode,
  severity: QcSeverity,
  entityIds: readonly (string | undefined)[],
  message: string,
  suggestedFix: string,
): QcFinding {
  return {
    code,
    severity,
    entityIds: uniqueIds(entityIds),
    message,
    suggestedFix,
  };
}

function compareFindings(left: QcFinding, right: QcFinding): number {
  return (
    (CODE_ORDER.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
      (CODE_ORDER.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
    left.entityIds.join("\u0000").localeCompare(right.entityIds.join("\u0000")) ||
    left.message.localeCompare(right.message)
  );
}

function summarize(findings: readonly QcFinding[]): QcSummary {
  const counts: Record<QcSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  const byCode = Object.fromEntries(
    QC_FINDING_CODES.map((code) => [code, 0]),
  ) as Record<QcFindingCode, number>;

  for (const current of findings) {
    counts[current.severity] += 1;
    byCode[current.code] += 1;
  }

  return {
    total: findings.length,
    counts,
    byCode,
    passed: counts.error === 0,
  };
}

function uniqueIds(
  ids: readonly (string | undefined)[],
): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) {
      unique.add(id);
    }
  }
  return [...unique];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function titleCase(value: string): string {
  return value.length === 0
    ? "Media"
    : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

import { JobRecordSchema, RenderRecordSchema, type PersistedAssetRecord } from "@praxis/jobs";
import { createSeedProject } from "@praxis/project-schema";
import {
  RENDER_MANIFEST_COMPILER_VERSION,
  RENDER_MANIFEST_SCHEMA_VERSION,
  RenderManifestSchema,
  canonicalSerialize,
  sha256Hex,
  type RenderManifest,
} from "@praxis/render-manifest";
import { describe, expect, it } from "vitest";
import {
  runPostRenderQc,
  runPreRenderQc,
  type QcOutputObjectEvidence,
} from "./index";

const readyProject = () => {
  const project = createSeedProject();
  for (const beat of project.script.beats) {
    beat.meta.status = "approved";
    beat.meta.locked = false;
  }
  for (const scene of project.scenes) {
    scene.meta.status = "approved";
    scene.meta.locked = false;
  }
  for (const asset of Object.values(project.assets)) {
    asset.meta.status = "approved";
    asset.meta.locked = false;
    for (const version of asset.versions) version.status = "approved";
  }
  for (const track of project.timeline.tracks) {
    track.meta.status = "approved";
    track.meta.locked = false;
    for (const clip of track.clips) {
      clip.meta.status = "approved";
      clip.meta.locked = false;
    }
  }
  return project;
};

const assetRecordsFor = (project: ReturnType<typeof readyProject>): PersistedAssetRecord[] =>
  Object.values(project.assets).flatMap((asset, assetIndex) =>
    asset.versions.map((version, versionIndex) => ({
      assetId: asset.meta.id,
      assetVersionId: version.id,
      projectId: project.projectId,
      kind: asset.kind as "image" | "audio" | "music",
      objectKey: `projects/${project.projectId}/assets/sha256/${version.id}.${asset.kind === "image" ? "png" : "wav"}`,
      sha256: (assetIndex * 16 + versionIndex + 1).toString(16).padStart(64, "0"),
      mimeType: asset.kind === "image" ? "image/png" : "audio/wav",
      byteLength: 1_024 + assetIndex,
      ...(version.width ? { width: version.width } : {}),
      ...(version.height ? { height: version.height } : {}),
      ...(version.durationFrames
        ? { durationMs: Math.round((version.durationFrames / project.metadata.fps) * 1_000) }
        : {}),
      provenance: { projectRevision: project.revision },
      createdAt: version.createdAt,
    })),
  );

describe("runPreRenderQc", () => {
  it("returns a clean deterministic report for the supported canonical subset", async () => {
    const project = readyProject();
    const input = { project, assetRecords: assetRecordsFor(project) };

    const first = await runPreRenderQc(input);
    const second = await runPreRenderQc(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      phase: "pre-render",
      projectId: project.projectId,
      revision: project.revision,
      findings: [],
      summary: { total: 0, passed: true },
    });
  });

  it("blocks missing, stale, locked, and wrong-revision render inputs", async () => {
    const project = readyProject();
    project.scenes.find((scene) => scene.meta.id === "scene_03")!.meta.locked = true;
    project.assets.asset_scene_04!.meta.locked = true;
    project.assets.asset_scene_02!.meta.status = "stale";
    const records = assetRecordsFor(project).filter(
      (record) => record.assetVersionId !== "asset_scene_01_v1",
    );

    const report = await runPreRenderQc({
      project,
      assetRecords: records,
      expectedRevision: project.revision + 1,
    });
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining([
      "MISSING_MEDIA",
      "STALE_MEDIA",
      "LOCKED_REQUIRED_SCENE",
      "LOCKED_REQUIRED_ASSET",
      "RENDER_REVISION_MISMATCH",
    ]));
    expect(report.findings.find((finding) => finding.code === "STALE_MEDIA")?.severity).toBe("error");
    expect(report.summary.passed).toBe(false);
  });

  it("reports unsupported clips and transitions, visual gaps, and output encoding", async () => {
    const project = readyProject();
    const firstClip = project.timeline.tracks[0]!.clips[0]!;
    firstClip.kind = "video";
    firstClip.startFrame = 20;
    firstClip.durationFrames = 130;
    project.timeline.tracks[0]!.clips[1]!.transitionIn = "spin-9f";
    project.delivery.container = "webm";
    project.delivery.videoCodec = "vp9";
    project.delivery.audioCodec = "opus";
    project.metadata.fps = 61;
    project.timeline.fps = 61;
    project.delivery.fps = 61;

    const report = await runPreRenderQc({ project, assetRecords: assetRecordsFor(project) });
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining([
      "UNSUPPORTED_RENDER_CLIP",
      "UNSUPPORTED_RENDER_TRANSITION",
      "EMPTY_VISUAL_INTERVAL",
      "INVALID_OUTPUT_SETTINGS",
    ]));
    expect(report.summary.passed).toBe(false);
  });

  it("maps malformed timing, narration bounds, and duration mismatches without throwing", async () => {
    const project = readyProject();
    project.timeline.durationFrames = 760;
    const narration = project.timeline.tracks.find((track) => track.name === "Narration")!.clips[0]!;
    narration.startFrame = 10;
    narration.durationFrames = 750;
    const lastVisual = project.timeline.tracks[0]!.clips.at(-1)!;
    lastVisual.durationFrames = 180;
    project.timeline.tracks[0]!.clips[1]!.startFrame = -1;
    project.delivery.width = 1_921;

    const report = await runPreRenderQc({ project, assetRecords: assetRecordsFor(project) });
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining([
      "TIMELINE_DURATION_MISMATCH",
      "NARRATION_OUT_OF_BOUNDS",
      "CLIP_OUT_OF_BOUNDS",
      "INVALID_OUTPUT_SETTINGS",
    ]));
    expect(report.summary.passed).toBe(false);
  });
});

const createManifest = (): RenderManifest =>
  RenderManifestSchema.parse({
    schemaVersion: RENDER_MANIFEST_SCHEMA_VERSION,
    compilerVersion: RENDER_MANIFEST_COMPILER_VERSION,
    renderId: "render_qc_output",
    projectId: "project_qc_output",
    projectRevision: 8,
    projectSnapshotHash: "a".repeat(64),
    renderer: { name: "praxis-ffmpeg", version: "praxis-ffmpeg-1" },
    canvas: {
      width: 1920,
      height: 1080,
      fps: 30,
      durationFrames: 300,
      backgroundColor: "#000000",
    },
    assets: [
      {
        assetId: "asset_narration",
        assetVersionId: "asset_narration_v1",
        objectKey: "projects/project_qc_output/assets/sha256/narration.wav",
        sha256: "b".repeat(64),
        mimeType: "audio/wav",
        byteLength: 4_096,
        durationMs: 10_000,
      },
    ],
    clips: [
      {
        type: "text",
        clipId: "clip_title",
        trackId: "track_overlay",
        zIndex: 1,
        startFrame: 0,
        durationFrames: 300,
        opacity: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        text: "STRUCTURAL QC",
        style: {
          fontFamily: "Inter Variable",
          fontSizePx: 72,
          fontWeight: 600,
          fontStyle: "normal",
          color: "#FFFFFF",
          textAlign: "center",
          lineHeight: 1,
          letterSpacingPx: 0,
        },
      },
    ],
    audio: [
      {
        type: "narration",
        clipId: "clip_narration",
        trackId: "track_audio",
        startFrame: 0,
        durationFrames: 300,
        sourceStartFrame: 0,
        assetVersionId: "asset_narration_v1",
        gainDb: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
      },
    ],
    output: {
      kind: "preview",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
    },
  });

const cleanEvidence = (manifest: RenderManifest): QcOutputObjectEvidence => ({
  objectKey: `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.mp4`,
  exists: true,
  byteLength: 250_000,
  sha256: "c".repeat(64),
  mimeType: "video/mp4",
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  durationMs: 10_000,
  streams: [
    { kind: "video", codec: "h264", width: 1920, height: 1080, durationMs: 10_000, pixelFormat: "yuv420p" },
    { kind: "audio", codec: "aac", durationMs: 10_000 },
  ],
});

const postRenderFixture = async () => {
  const manifest = createManifest();
  const manifestHash = await sha256Hex(canonicalSerialize(manifest));
  const video = cleanEvidence(manifest);
  const poster: QcOutputObjectEvidence = {
    objectKey: `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.jpg`,
    exists: true,
    byteLength: 12_000,
    sha256: "d".repeat(64),
    mimeType: "image/jpeg",
  };
  const createdAt = "2026-08-26T20:00:00.000Z";
  const renderRecord = RenderRecordSchema.parse({
    renderId: manifest.renderId,
    projectId: manifest.projectId,
    jobId: "job_qc_output",
    projectRevision: manifest.projectRevision,
    manifestHash,
    manifestObjectKey: `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.manifest.json`,
    outputObjectKey: video.objectKey,
    posterObjectKey: poster.objectKey,
    sha256: video.sha256,
    byteLength: video.byteLength,
    width: 1920,
    height: 1080,
    durationMs: 10_000,
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    outdated: false,
    createdAt,
  });
  const jobRecord = JobRecordSchema.parse({
    jobId: "job_qc_output",
    projectId: manifest.projectId,
    idempotencyKey: "idempotency_qc_output",
    jobType: "render.preview",
    status: "succeeded",
    actor: { kind: "system", id: "system_render" },
    baseRevision: manifest.projectRevision,
    targetEntityIds: [],
    request: {},
    estimatedCostUsd: 0,
    reservedCostUsd: 0,
    settledCostUsd: 0,
    costIsEstimate: true,
    attempt: 1,
    output: {
      renderId: manifest.renderId,
      objectKey: video.objectKey,
      posterObjectKey: poster.objectKey,
      sha256: video.sha256,
      posterSha256: poster.sha256,
      mimeType: "video/mp4",
      byteLength: video.byteLength,
      width: 1920,
      height: 1080,
      durationMs: 10_000,
      attached: true,
      stale: false,
      projectRevision: manifest.projectRevision,
      metadata: { manifestSha256: manifestHash },
    },
    createdAt,
    updatedAt: createdAt,
  });
  return { manifest, video, poster, renderRecord, jobRecord };
};

describe("runPostRenderQc", () => {
  it("returns a clean deterministic report for verified output and persisted metadata", async () => {
    const input = await postRenderFixture();
    const first = await runPostRenderQc(input);
    const second = await runPostRenderQc(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      phase: "post-render",
      projectId: input.manifest.projectId,
      revision: input.manifest.projectRevision,
      findings: [],
      summary: { total: 0, passed: true },
    });
  });

  it("finds empty/non-MP4 output, stream, duration, dimension, pixel, and hash defects", async () => {
    const input = await postRenderFixture();
    const report = await runPostRenderQc({
      ...input,
      video: {
        ...input.video,
        byteLength: 0,
        sha256: undefined,
        mimeType: "application/octet-stream",
        container: "matroska,webm",
        durationMs: 12_000,
        streams: [
          { kind: "video", codec: "vp9", width: 1280, height: 720, pixelFormat: "yuv444p" },
        ],
      },
    });
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining([
      "OUTPUT_OBJECT_EMPTY",
      "OUTPUT_CONTAINER_INVALID",
      "OUTPUT_STREAM_CODEC_MISMATCH",
      "OUTPUT_DIMENSIONS_MISMATCH",
      "OUTPUT_DURATION_MISMATCH",
      "OUTPUT_PIXEL_FORMAT_MISMATCH",
      "OUTPUT_AUDIO_STREAM_MISSING",
      "OUTPUT_HASH_MISSING",
      "OUTPUT_METADATA_MISMATCH",
    ]));
    expect(report.summary.passed).toBe(false);
  });

  it("detects a missing video stream independently", async () => {
    const input = await postRenderFixture();
    const report = await runPostRenderQc({
      ...input,
      video: { ...input.video, streams: [{ kind: "audio", codec: "aac" }] },
    });
    expect(report.summary.byCode.OUTPUT_VIDEO_STREAM_MISSING).toBe(1);
  });

  it("requires the MP4 object and its persisted RenderRecord", async () => {
    const input = await postRenderFixture();
    const report = await runPostRenderQc({
      ...input,
      video: { exists: false, objectKey: input.video.objectKey },
      renderRecord: undefined,
    });
    expect(report.summary.byCode.OUTPUT_OBJECT_MISSING).toBeGreaterThan(0);
    expect(report.summary.byCode.OUTPUT_METADATA_MISSING).toBeGreaterThan(0);
  });

  it("compares persisted hashes and requires every referenced output object", async () => {
    const input = await postRenderFixture();
    const renderRecord = RenderRecordSchema.parse({
      ...input.renderRecord,
      manifestHash: "e".repeat(64),
      sha256: "f".repeat(64),
    });
    const report = await runPostRenderQc({
      ...input,
      renderRecord,
      poster: undefined,
    });
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toEqual(expect.arrayContaining([
      "OUTPUT_HASH_MISMATCH",
      "OUTPUT_METADATA_MISMATCH",
      "OUTPUT_OBJECT_MISSING",
    ]));
  });
});

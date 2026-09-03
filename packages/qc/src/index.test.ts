import { describe, expect, it } from "vitest";

import {
  runStructuralQc,
  type QcEntityMetaLike,
  type QcProductionProjectLike,
  type QcTimelineClipLike,
} from "./index";

const meta = (
  id: string,
  status = "approved",
  locked = false,
): QcEntityMetaLike => ({ id, status, locked });

const videoClip = (
  id: string,
  startFrame: number,
  durationFrames: number,
): QcTimelineClipLike => ({
  meta: meta(id),
  kind: "scene",
  name: id,
  startFrame,
  durationFrames,
  sourceStartFrame: 0,
  assetId: "asset_picture",
  assetVersionId: "asset_picture_v1",
  versionPolicy: "pinned",
});

const createProject = (): QcProductionProjectLike => ({
  projectId: "project_test",
  revision: 7,
  metadata: {
    fps: 30,
    frameSize: { width: 1920, height: 1080 },
    durationFrames: 300,
  },
  script: {
    beats: [
      {
        meta: meta("beat_01"),
        startFrame: 0,
        durationFrames: 300,
        narration: "A complete narration.",
      },
    ],
  },
  scenes: [
    {
      meta: meta("scene_01"),
      requiredAssetIds: ["asset_picture"],
    },
  ],
  assets: {
    asset_picture: {
      meta: meta("asset_picture"),
      kind: "image",
      name: "Picture",
      currentVersionId: "asset_picture_v1",
      versions: [
        {
          id: "asset_picture_v1",
          status: "approved",
          uri: "asset://picture.png",
        },
      ],
    },
    asset_narration: {
      meta: meta("asset_narration"),
      kind: "audio",
      name: "Narration",
      currentVersionId: "asset_narration_v1",
      versions: [
        {
          id: "asset_narration_v1",
          status: "approved",
          uri: "asset://narration.wav",
          durationFrames: 300,
        },
      ],
      tags: ["voice"],
    },
  },
  timeline: {
    meta: meta("timeline_main"),
    fps: 30,
    durationFrames: 300,
    tracks: [
      {
        meta: meta("track_video"),
        name: "Primary video",
        kind: "video",
        order: 0,
        muted: false,
        clips: [videoClip("clip_video_01", 0, 300)],
      },
      {
        meta: meta("track_narration"),
        name: "Narration",
        kind: "audio",
        order: 1,
        muted: false,
        clips: [
          {
            meta: meta("clip_narration"),
            kind: "audio",
            name: "Narration master",
            startFrame: 0,
            durationFrames: 300,
            sourceStartFrame: 0,
            sourceDurationFrames: 300,
            assetId: "asset_narration",
            assetVersionId: "asset_narration_v1",
            versionPolicy: "pinned",
          },
        ],
      },
    ],
  },
  decisions: [
    {
      meta: meta("decision_done"),
      kind: "proposal",
      status: "accepted",
      title: "Approved change",
    },
  ],
  delivery: { width: 1920, height: 1080, fps: 30 },
});

describe("runStructuralQc", () => {
  it("returns a clean, deterministic report for a structurally ready project", () => {
    const project = createProject();
    const first = runStructuralQc(project);
    const second = runStructuralQc(project);

    expect(first).toEqual(second);
    expect(first.findings).toEqual([]);
    expect(first.summary).toMatchObject({
      total: 0,
      counts: { error: 0, warning: 0, info: 0 },
      passed: true,
    });
  });

  it("finds missing, failed, and stale media without throwing on broken links", () => {
    const project = createProject();
    delete project.assets.asset_picture;
    project.assets.asset_narration.versions[0]!.status = "failed";
    project.assets.asset_stale = {
      meta: meta("asset_stale", "stale"),
      kind: "video",
      name: "Old plate",
      currentVersionId: "asset_stale_v1",
      versions: [
        {
          id: "asset_stale_v1",
          status: "stale",
          uri: "asset://old.mov",
        },
      ],
    };

    const report = runStructuralQc(project);
    const codes = report.findings.map((finding) => finding.code);

    expect(codes).toEqual(
      expect.arrayContaining(["MISSING_MEDIA", "FAILED_MEDIA", "STALE_MEDIA"]),
    );
    expect(report.summary.byCode.MISSING_MEDIA).toBeGreaterThan(0);
    expect(report.summary.passed).toBe(false);
    expect(
      report.findings.every(
        (finding) =>
          finding.entityIds.length > 0 && finding.suggestedFix.length > 0,
      ),
    ).toBe(true);
  });

  it("reports primary-video gaps, overlaps, and clips outside the timeline", () => {
    const project = createProject();
    project.timeline.tracks[0]!.clips = [
      videoClip("clip_a", 0, 100),
      videoClip("clip_b", 90, 100),
      videoClip("clip_c", 220, 100),
    ];

    const report = runStructuralQc(project);

    expect(report.summary.byCode.PRIMARY_VIDEO_OVERLAP).toBe(1);
    expect(report.summary.byCode.PRIMARY_VIDEO_GAP).toBe(1);
    expect(report.summary.byCode.CLIP_OUT_OF_BOUNDS).toBe(1);
    expect(
      report.findings.find((finding) => finding.code === "PRIMARY_VIDEO_GAP")
        ?.message,
    ).toContain("[190, 220)");
  });

  it("detects evidence-backed narration duration mismatches", () => {
    const project = createProject();
    const narration = project.timeline.tracks[1]!.clips[0]!;
    narration.durationFrames = 280;
    narration.sourceDurationFrames = 300;

    const report = runStructuralQc(project);
    const mismatch = report.findings.find(
      (finding) => finding.code === "NARRATION_DURATION_MISMATCH",
    );

    expect(mismatch).toMatchObject({
      severity: "error",
      entityIds: [
        "clip_narration",
        "asset_narration",
        "asset_narration_v1",
      ],
    });
    expect(mismatch?.message).toContain("280");
  });

  it("flags locked stale entities, unresolved proposals, and delivery mismatches", () => {
    const project = createProject();
    project.scenes[0]!.meta.status = "stale";
    project.scenes[0]!.meta.locked = true;
    project.decisions.push({
      meta: meta("decision_pending", "draft"),
      kind: "proposal",
      status: "pending",
      title: "Try another ending",
    });
    project.delivery = { width: 1280, height: 720, fps: 24 };

    const report = runStructuralQc(project);

    expect(report.summary.byCode.LOCKED_STALE_ENTITY).toBe(1);
    expect(report.summary.byCode.UNRESOLVED_PROPOSAL).toBe(1);
    expect(report.summary.byCode.DELIVERY_FRAME_SIZE_MISMATCH).toBe(1);
    expect(report.summary.byCode.DELIVERY_FPS_MISMATCH).toBe(1);
    expect(report.summary.counts).toEqual({ error: 3, warning: 1, info: 0 });
  });
});

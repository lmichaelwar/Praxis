import { describe, expect, it } from "vitest";
import { createSeedProject, ProductionProjectSchema } from "./index";

describe("ProductionProjectSchema", () => {
  it("creates a fresh, fully linked seeded vertical slice", () => {
    const first = createSeedProject();
    const second = createSeedProject();

    expect(ProductionProjectSchema.parse(first)).toEqual(first);
    expect(first).not.toBe(second);
    expect(first.script.beats).toHaveLength(5);
    expect(first.scenes).toHaveLength(5);
    expect(first.timeline.tracks.flatMap((track) => track.clips)).toHaveLength(8);
    expect(first.scenes[2]?.meta.locked).toBe(true);
    expect(first.scenes[3]?.meta.status).toBe("stale");
    expect(first.assets.asset_scene_04?.meta.status).toBe("stale");
    expect(first.timeline.tracks[0]?.clips[3]?.meta.status).toBe("stale");
    expect(first.timeline.tracks[3]?.name).toBe("Music");
    expect(first.decisions[0]?.status).toBe("pending");
  });

  it("rejects dangling production-graph references", () => {
    const project = createSeedProject();
    project.scenes[0]!.beatId = "beat_missing";

    const result = ProductionProjectSchema.safeParse(project);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes("Unknown script beat"))).toBe(true);
    }
  });

  it("carries bounded deterministic render fields without embedding media bytes", () => {
    const project = createSeedProject();
    const title = project.timeline.tracks[1]!.clips[0]!;
    const narration = project.timeline.tracks[2]!.clips[0]!;
    const music = project.timeline.tracks[3]!.clips[0]!;

    expect(title).toMatchObject({
      kind: "text",
      text: "THE FAX ORACLE",
      textStyle: {
        fontFamily: "Roboto Condensed Variable",
        fontSizePx: 86,
        color: "#ECE8DC",
      },
    });
    expect(narration.gainDb).toBe(0);
    expect(music.gainDb).toBe(-10);

    const version = project.assets.asset_scene_01!.versions[0]!;
    Object.assign(version, {
      objectKey: "projects/project_fax_oracle/assets/ab/asset_scene_01_v1.png",
      sha256: "a".repeat(64),
      byteLength: 42_000,
      provenance: {
        projectRevision: project.revision,
        jobId: "job_image_01",
        sourceAssetVersionIds: [],
      },
    });
    expect(ProductionProjectSchema.safeParse(project).success).toBe(true);
    expect("bytes" in version).toBe(false);
  });

  it("rejects unbounded or unsafe render metadata", () => {
    const oversizedText = createSeedProject();
    oversizedText.timeline.tracks[1]!.clips[0]!.text = "x".repeat(8_001);
    expect(ProductionProjectSchema.safeParse(oversizedText).success).toBe(false);

    const unsafeObjectKey = createSeedProject();
    unsafeObjectKey.assets.asset_scene_01!.versions[0]!.objectKey = "../outside.png";
    expect(ProductionProjectSchema.safeParse(unsafeObjectKey).success).toBe(false);

    const excessiveGain = createSeedProject();
    excessiveGain.timeline.tracks[2]!.clips[0]!.gainDb = 25;
    expect(ProductionProjectSchema.safeParse(excessiveGain).success).toBe(false);

    const gainOnText = createSeedProject();
    gainOnText.timeline.tracks[1]!.clips[0]!.gainDb = 0;
    expect(ProductionProjectSchema.safeParse(gainOnText).success).toBe(false);
  });
});

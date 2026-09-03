import { describe, expect, it } from "vitest";
import { createSeedProject } from "@praxis/project-schema";
import {
  RENDER_RESULT_SIGNING_DOMAIN,
  RenderManifestCompileError,
  RenderManifestSchema,
  RenderResultPayloadSchema,
  SignedRenderResultEnvelopeSchema,
  canonicalSerialize,
  compileRenderManifest,
  renderResultObjectKey,
  renderResultSigningInput,
  sha256Hex,
  type TrustedAssetMetadata,
} from "./index";

const materializeSeed = () => {
  const project = createSeedProject();
  for (const [assetId, asset] of Object.entries(project.assets)) {
    asset.meta.status = "approved";
    for (const version of asset.versions) {
      version.status = "approved";
      if (asset.kind === "image") {
        version.mimeType = "image/png";
        version.uri = `object://projects/test/${version.id}.png`;
      } else {
        version.mimeType = "audio/wav";
        version.uri = `object://projects/test/${version.id}.wav`;
      }
    }
    if (assetId === "asset_scene_04") asset.meta.status = "approved";
  }
  for (const scene of project.scenes) scene.meta.status = "approved";
  for (const track of project.timeline.tracks) {
    for (const clip of track.clips) clip.meta.status = "approved";
  }
  return project;
};

const recordsFor = (project: ReturnType<typeof materializeSeed>): TrustedAssetMetadata[] =>
  Object.values(project.assets).flatMap((asset) =>
    asset.versions.map((version) => ({
      assetId: asset.meta.id,
      assetVersionId: version.id,
      objectKey: `projects/${project.projectId}/assets/sha256/${version.id}.${asset.kind === "image" ? "png" : "wav"}`,
      sha256: "a".repeat(64),
      mimeType: version.mimeType,
      byteLength: 1_024,
      ...(version.width ? { width: version.width } : {}),
      ...(version.height ? { height: version.height } : {}),
      ...(version.durationFrames ? { durationMs: Math.round((version.durationFrames / project.metadata.fps) * 1_000) } : {}),
    })),
  );

describe("render manifest", () => {
  it("uses canonical key ordering and stable hashes", async () => {
    expect(canonicalSerialize({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(await sha256Hex("praxis")).toBe("d5007cc3f96992ad0c10be2fda2a18bc06d8fa1a5a1672e2f131682f47e28039");
  });

  it("compiles a deterministic, revision-bound manifest", async () => {
    const project = materializeSeed();
    const input = {
      project,
      expectedRevision: project.revision,
      renderId: "render_test",
      kind: "preview" as const,
      rendererVersion: "praxis-ffmpeg-1",
      assetRecords: recordsFor(project),
    };
    const first = await compileRenderManifest(input);
    const second = await compileRenderManifest({ ...input, assetRecords: [...input.assetRecords].reverse() });

    expect(RenderManifestSchema.parse(first.manifest)).toEqual(first.manifest);
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.sha256).toBe(second.sha256);
    expect(first.manifest.projectRevision).toBe(project.revision);
    expect(first.manifest.renderer).toEqual({ name: "praxis-ffmpeg", version: "praxis-ffmpeg-1" });
    expect(first.manifest.clips.map((clip) => clip.type)).toEqual([
      "still", "still", "still", "still", "still", "text",
    ]);
    expect(first.manifest.audio).toHaveLength(2);
    expect(first.manifest.audio.find((clip) => clip.type === "music")?.gainDb).toBe(-10);
    const title = first.manifest.clips.find((clip) => clip.type === "text");
    expect(title).toMatchObject({
      text: "THE FAX ORACLE",
      style: { fontFamily: "Roboto Condensed Variable", fontSizePx: 86, letterSpacingPx: 8 },
    });
  });

  it("rejects a stale snapshot revision", async () => {
    const project = materializeSeed();
    await expect(compileRenderManifest({
      project,
      expectedRevision: project.revision + 1,
      renderId: "render_test",
      kind: "preview",
      rendererVersion: "test",
      assetRecords: recordsFor(project),
    })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "REVISION_MISMATCH" })],
    });
  });

  it("rejects stale media, missing trusted objects, and unknown transitions", async () => {
    const project = materializeSeed();
    const sceneClip = project.timeline.tracks[0]!.clips[0]!;
    sceneClip.meta.status = "stale";
    project.timeline.tracks[0]!.clips[1]!.transitionIn = "spin-12f";

    try {
      await compileRenderManifest({
        project,
        expectedRevision: project.revision,
        renderId: "render_test",
        kind: "final",
        rendererVersion: "test",
        assetRecords: recordsFor(project).filter((record) => record.assetVersionId !== "asset_scene_03_v1"),
      });
      throw new Error("Expected manifest compilation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderManifestCompileError);
      const codes = (error as RenderManifestCompileError).issues.map((issue) => issue.code);
      expect(codes).toContain("STALE_MEDIA");
      expect(codes).toContain("UNSUPPORTED_TRANSITION");
      expect(codes).toContain("MISSING_ASSET");
    }
  });

  it("rejects signed URLs and traversal in trusted object keys", async () => {
    const project = materializeSeed();
    const record = recordsFor(project)[0]!;
    await expect(compileRenderManifest({
      project,
      expectedRevision: project.revision,
      renderId: "render_test",
      kind: "preview",
      rendererVersion: "test",
      assetRecords: [{ ...record, objectKey: "../secret.png" }],
    })).rejects.toThrow();
  });

  it("rejects trusted metadata that disagrees with canonical mirrored metadata", async () => {
    const project = materializeSeed();
    const version = project.assets.asset_scene_01!.versions[0]!;
    version.sha256 = "b".repeat(64);
    await expect(compileRenderManifest({
      project,
      expectedRevision: project.revision,
      renderId: "render_test",
      kind: "preview",
      rendererVersion: "test",
      assetRecords: recordsFor(project),
    })).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ code: "ASSET_MISMATCH" })]),
    });
  });
});

const renderResultPayload = {
  schemaVersion: "1" as const,
  jobId: "job_test",
  renderId: "render_test",
  projectId: "project_test",
  projectRevision: 7,
  manifestSha256: "a".repeat(64),
  renderer: { name: "praxis-ffmpeg" as const, version: "praxis-ffmpeg-1" },
  completedAt: "2026-08-26T20:00:00.000Z",
  video: {
    objectKey: "projects/project_test/renders/7/render_test.mp4",
    sha256: "b".repeat(64),
    byteLength: 1_024,
    mimeType: "video/mp4" as const,
    container: "mp4" as const,
    width: 1_920,
    height: 1_080,
    durationMs: 12_000,
    fps: 30,
    videoCodec: "h264" as const,
    audioCodec: "aac" as const,
    pixelFormat: "yuv420p" as const,
  },
  poster: {
    objectKey: "projects/project_test/renders/7/render_test.jpg",
    sha256: "c".repeat(64),
    byteLength: 8_192,
    mimeType: "image/jpeg" as const,
    codec: "mjpeg" as const,
    width: 1_920,
    height: 1_080,
  },
};

describe("signed render result contract", () => {
  it("parses a strict probed payload and derives its immutable object key", () => {
    expect(RenderResultPayloadSchema.parse(renderResultPayload)).toEqual(renderResultPayload);
    expect(renderResultObjectKey(renderResultPayload)).toBe(
      "projects/project_test/render-results/7/render_test.json",
    );
    expect(RenderResultPayloadSchema.safeParse({ ...renderResultPayload, ignored: true }).success).toBe(false);
  });

  it("domain-separates the canonical signing input and covers the key ID", () => {
    const input = renderResultSigningInput({ keyId: "staging-v1", payload: renderResultPayload });
    const otherKey = renderResultSigningInput({ keyId: "staging-v2", payload: renderResultPayload });

    expect(input.startsWith(`${RENDER_RESULT_SIGNING_DOMAIN}\n`)).toBe(true);
    expect(input).not.toBe(otherKey);
    expect(input).toContain('"algorithm":"hmac-sha256"');
    expect(input).toContain('"keyId":"staging-v1"');
  });

  it("requires a strict signed envelope", () => {
    const envelope = {
      schemaVersion: "1" as const,
      algorithm: "hmac-sha256" as const,
      keyId: "staging-v1",
      payload: renderResultPayload,
      signature: "A".repeat(43),
    };

    expect(SignedRenderResultEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(SignedRenderResultEnvelopeSchema.safeParse({ ...envelope, ignored: true }).success).toBe(false);
    expect(SignedRenderResultEnvelopeSchema.safeParse({ ...envelope, signature: "not-base64url" }).success).toBe(false);
  });
});

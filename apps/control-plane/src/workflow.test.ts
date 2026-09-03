import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ getContainer: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("@praxis/qc", () => ({ runPostRenderQc: vi.fn(), runPreRenderQc: vi.fn() }));
vi.mock("@praxis/jobs", () => ({}));
import {
  RENDER_MANIFEST_COMPILER_VERSION,
  RENDER_MANIFEST_SCHEMA_VERSION,
  RENDER_RESULT_SCHEMA_VERSION,
  RENDER_RESULT_SIGNATURE_ALGORITHM,
  canonicalSerialize,
  renderResultObjectKey,
  renderResultSigningInput,
  type RenderManifest,
  type RenderResultPayload,
  type SignedRenderResultEnvelope,
} from "@praxis/render-manifest";
import type { Env } from "./env";
import { recoverExistingRenderResult, renderObjectKeys } from "./workflow";

const signingSecret = "render-result-test-secret-".repeat(3);
const signingKeyId = "test-result-v1";
const jobId = "job_test";
const manifestSha256 = "a".repeat(64);
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const nonCanonicalBase64Url = (value: string): string => {
  const lastIndex = base64UrlAlphabet.indexOf(value.at(-1)!);
  return `${value.slice(0, -1)}${base64UrlAlphabet[lastIndex + 1]}`;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const manifest = (): RenderManifest => ({
  schemaVersion: RENDER_MANIFEST_SCHEMA_VERSION,
  compilerVersion: RENDER_MANIFEST_COMPILER_VERSION,
  renderId: "render_test",
  projectId: "project_test",
  projectRevision: 7,
  projectSnapshotHash: "b".repeat(64),
  renderer: { name: "praxis-ffmpeg", version: "test-renderer" },
  canvas: { width: 320, height: 180, fps: 30, durationFrames: 30, backgroundColor: "#16191C" },
  assets: [],
  clips: [],
  audio: [],
  output: { kind: "preview", container: "mp4", videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" },
});

const signedEnvelope = (
  payload: RenderResultPayload,
  secret = signingSecret,
  keyId = signingKeyId,
): SignedRenderResultEnvelope => ({
  schemaVersion: RENDER_RESULT_SCHEMA_VERSION,
  algorithm: RENDER_RESULT_SIGNATURE_ALGORITHM,
  keyId,
  payload,
  signature: createHmac("sha256", secret)
    .update(renderResultSigningInput({ keyId, payload }))
    .digest("base64url"),
});

type Stored = { bytes: Uint8Array; mimeType: string };

const fakeEnv = (objects: Map<string, Stored>, overrides: Partial<Env> = {}): Env => ({
  PRAXIS_RENDER_AUTH_SECRET: signingSecret,
  PRAXIS_RENDER_RESULT_SIGNING_SECRET: signingSecret,
  PRAXIS_RENDER_RESULT_SIGNING_KEY_ID: signingKeyId,
  MEDIA: {
    get: async (objectKey: string) => {
      const stored = objects.get(objectKey);
      if (!stored) return null;
      const bytes = Uint8Array.from(stored.bytes);
      return {
        size: bytes.byteLength,
        httpMetadata: { contentType: stored.mimeType },
        body: new Blob([bytes.buffer]).stream(),
      };
    },
  },
  ...overrides,
} as unknown as Env);

const fixture = () => {
  const renderManifest = manifest();
  const keys = renderObjectKeys(renderManifest);
  const videoBytes = new TextEncoder().encode("immutable video bytes");
  const posterBytes = new TextEncoder().encode("immutable poster bytes");
  const payload: RenderResultPayload = {
    schemaVersion: RENDER_RESULT_SCHEMA_VERSION,
    jobId,
    renderId: renderManifest.renderId,
    projectId: renderManifest.projectId,
    projectRevision: renderManifest.projectRevision,
    manifestSha256,
    renderer: renderManifest.renderer,
    completedAt: "2026-08-26T20:00:00.000Z",
    video: {
      objectKey: keys.video,
      sha256: sha256(videoBytes),
      byteLength: videoBytes.byteLength,
      mimeType: "video/mp4",
      container: "mp4",
      width: 320,
      height: 180,
      durationMs: 1_000,
      fps: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
    },
    poster: {
      objectKey: keys.poster,
      sha256: sha256(posterBytes),
      byteLength: posterBytes.byteLength,
      mimeType: "image/jpeg",
      codec: "mjpeg",
      width: 320,
      height: 180,
    },
  };
  const envelope = signedEnvelope(payload);
  const sidecarBytes = new TextEncoder().encode(canonicalSerialize(envelope));
  return { renderManifest, keys, videoBytes, posterBytes, payload, envelope, sidecarBytes };
};

describe("restart-safe signed render result recovery", () => {
  it("does not derive probe metadata from media objects when no sidecar exists", async () => {
    const { renderManifest, keys, videoBytes, posterBytes } = fixture();
    const objects = new Map<string, Stored>([
      [keys.video, { bytes: videoBytes, mimeType: "video/mp4" }],
      [keys.poster, { bytes: posterBytes, mimeType: "image/jpeg" }],
    ]);

    await expect(recoverExistingRenderResult(
      fakeEnv(objects),
      jobId,
      manifestSha256,
      renderManifest,
    )).resolves.toBeUndefined();
  });

  it("verifies the signed sidecar and rehashes both referenced R2 objects", async () => {
    const { renderManifest, keys, videoBytes, posterBytes, payload, sidecarBytes } = fixture();
    const objects = new Map<string, Stored>([
      [keys.video, { bytes: videoBytes, mimeType: "video/mp4" }],
      [keys.poster, { bytes: posterBytes, mimeType: "image/jpeg" }],
      [renderResultObjectKey(renderManifest), { bytes: sidecarBytes, mimeType: "application/json" }],
    ]);

    await expect(recoverExistingRenderResult(
      fakeEnv(objects),
      jobId,
      manifestSha256,
      renderManifest,
    )).resolves.toEqual({
      result: payload,
      sidecar: {
        objectKey: keys.result,
        sha256: sha256(sidecarBytes),
        byteLength: sidecarBytes.byteLength,
        keyId: signingKeyId,
      },
    });
  });

  it("recovers an immutable sidecar signed by an overlapping rotation key", async () => {
    const { renderManifest, keys, videoBytes, posterBytes, payload } = fixture();
    const previousKeyId = "test-result-previous-v1";
    const previousSecret = "previous-render-result-secret-".repeat(3);
    const previousEnvelope = signedEnvelope(payload, previousSecret, previousKeyId);
    const sidecarBytes = new TextEncoder().encode(canonicalSerialize(previousEnvelope));
    const objects = new Map<string, Stored>([
      [keys.video, { bytes: videoBytes, mimeType: "video/mp4" }],
      [keys.poster, { bytes: posterBytes, mimeType: "image/jpeg" }],
      [keys.result, { bytes: sidecarBytes, mimeType: "application/json" }],
    ]);

    await expect(recoverExistingRenderResult(
      fakeEnv(objects, {
        PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON: JSON.stringify({ [previousKeyId]: previousSecret }),
      }),
      jobId,
      manifestSha256,
      renderManifest,
    )).resolves.toMatchObject({
      result: payload,
      sidecar: { keyId: previousKeyId },
    });

    await expect(recoverExistingRenderResult(
      fakeEnv(objects), jobId, manifestSha256, renderManifest,
    )).rejects.toThrow(/unexpected render result signing key/i);
  });

  it("rejects signed metadata tampering and referenced-object hash mismatches", async () => {
    const { renderManifest, keys, videoBytes, posterBytes, envelope } = fixture();
    const nonCanonicalBytes = new TextEncoder().encode(canonicalSerialize({
      ...envelope,
      signature: nonCanonicalBase64Url(envelope.signature),
    }));
    const nonCanonicalObjects = new Map<string, Stored>([
      [keys.video, { bytes: videoBytes, mimeType: "video/mp4" }],
      [keys.poster, { bytes: posterBytes, mimeType: "image/jpeg" }],
      [keys.result, { bytes: nonCanonicalBytes, mimeType: "application/json" }],
    ]);
    await expect(recoverExistingRenderResult(
      fakeEnv(nonCanonicalObjects), jobId, manifestSha256, renderManifest,
    )).rejects.toThrow(/malformed render result signature/i);

    const tamperedBytes = new TextEncoder().encode(canonicalSerialize({
      ...envelope,
      payload: { ...envelope.payload, projectRevision: envelope.payload.projectRevision + 1 },
    }));
    const tamperedObjects = new Map<string, Stored>([
      [keys.video, { bytes: videoBytes, mimeType: "video/mp4" }],
      [keys.poster, { bytes: posterBytes, mimeType: "image/jpeg" }],
      [keys.result, { bytes: tamperedBytes, mimeType: "application/json" }],
    ]);
    await expect(recoverExistingRenderResult(
      fakeEnv(tamperedObjects), jobId, manifestSha256, renderManifest,
    )).rejects.toThrow(/signature/i);

    const validSidecar = new TextEncoder().encode(canonicalSerialize(envelope));
    const corruptObjects = new Map<string, Stored>([
      [keys.video, { bytes: new TextEncoder().encode("corrupt video bytes"), mimeType: "video/mp4" }],
      [keys.poster, { bytes: posterBytes, mimeType: "image/jpeg" }],
      [keys.result, { bytes: validSidecar, mimeType: "application/json" }],
    ]);
    await expect(recoverExistingRenderResult(
      fakeEnv(corruptObjects), jobId, manifestSha256, renderManifest,
    )).rejects.toThrow(/hash/i);
  });
});

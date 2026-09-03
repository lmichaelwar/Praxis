import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RENDER_MANIFEST_COMPILER_VERSION,
  RENDER_MANIFEST_SCHEMA_VERSION,
  type RenderManifest,
} from "@praxis/render-manifest";
import {
  RenderRequestSchema,
  buildFfmpegPlan,
  buildAssSubtitle,
  type RenderExecutor,
  type RenderRequest,
  type RenderResult,
} from "../src/executor";
import {
  createJobToken,
  createSignedRenderResult,
  verifyJobToken,
  verifySignedRenderResult,
} from "../src/auth";
import { hashFile, LocalObjectStore } from "../src/object-store";
import { ProcessExecutionError, runProcess } from "../src/process";
import { createRenderServer } from "../src/server";
import { loadRenderWorkerConfig } from "../src/config";

const temporaryDirectories: string[] = [];
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const nonCanonicalBase64Url = (value: string): string => {
  const lastIndex = base64UrlAlphabet.indexOf(value.at(-1)!);
  return `${value.slice(0, -1)}${base64UrlAlphabet[lastIndex + 1]}`;
};
const temporaryDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "praxis-render-worker-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const baseManifest = (): RenderManifest => ({
  schemaVersion: RENDER_MANIFEST_SCHEMA_VERSION,
  compilerVersion: RENDER_MANIFEST_COMPILER_VERSION,
  renderId: "render_test",
  projectId: "project_test",
  projectRevision: 7,
  projectSnapshotHash: "a".repeat(64),
  renderer: { name: "praxis-ffmpeg", version: "test-renderer" },
  canvas: {
    width: 320,
    height: 180,
    fps: 30,
    durationFrames: 30,
    backgroundColor: "#16191C",
  },
  assets: [],
  clips: [],
  audio: [],
  output: {
    kind: "preview",
    container: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
  },
});

const baseResult = (jobId = "job_test"): RenderResult => ({
  schemaVersion: "1",
  jobId,
  renderId: "render_test",
  projectId: "project_test",
  projectRevision: 7,
  manifestSha256: "d".repeat(64),
  renderer: { name: "praxis-ffmpeg", version: "test-renderer" },
  completedAt: "2026-08-26T20:00:00.000Z",
  video: {
    objectKey: "projects/project_test/renders/7/render_test.mp4",
    sha256: "e".repeat(64),
    byteLength: 10,
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
    objectKey: "projects/project_test/renders/7/render_test.jpg",
    sha256: "f".repeat(64),
    byteLength: 10,
    mimeType: "image/jpeg",
    codec: "mjpeg",
    width: 320,
    height: 180,
  },
});

describe("LocalObjectStore", () => {
  it("verifies input hashes and keeps output keys immutable", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source.bin");
    await writeFile(source, "immutable media");
    const hashed = await hashFile(source);
    const store = new LocalObjectStore(root);
    const stored = await store.putImmutable("projects/p/assets/sha256/test.bin", source);

    await expect(store.readVerified(stored.objectKey, hashed.sha256, hashed.byteLength, 1_024)).resolves.toMatchObject(hashed);
    expect(() => store.resolveKey("../secret")).toThrow(/safe relative key/);

    const changed = path.join(root, "changed.bin");
    await writeFile(changed, "different bytes");
    await expect(store.putImmutable(stored.objectKey, changed)).rejects.toThrow();
  });

  it("rejects symlinks that escape the configured object-store root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const source = path.join(outside, "outside.bin");
    await writeFile(source, "outside bytes");
    const hashed = await hashFile(source);
    const store = new LocalObjectStore(root);

    await symlink(source, path.join(root, "read-link.bin"));
    await expect(store.readVerified("read-link.bin", hashed.sha256, hashed.byteLength, 1_024))
      .rejects.toThrow(/escapes/);

    await symlink(outside, path.join(root, "write-link"), "dir");
    await expect(store.putImmutable("write-link/output.bin", source)).rejects.toThrow(/escapes/);
  });
});

describe("media process runner", () => {
  it("terminates child processes on cancellation and timeout", async () => {
    const controller = new AbortController();
    const cancelled = runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(cancelled).rejects.toMatchObject({ code: "PROCESS_ABORTED" });

    await expect(runProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
    })).rejects.toMatchObject({ code: "PROCESS_TIMEOUT" });
  });
});

describe("FFmpeg plan", () => {
  it("uses a fixed codec envelope and manifest-only filter vocabulary", () => {
    const manifest = baseManifest();
    manifest.assets = [
      {
        assetId: "asset_image",
        assetVersionId: "asset_image_v1",
        objectKey: "projects/project_test/assets/sha256/image.png",
        sha256: "b".repeat(64),
        mimeType: "image/png",
        byteLength: 100,
        width: 320,
        height: 180,
      },
      {
        assetId: "asset_audio",
        assetVersionId: "asset_audio_v1",
        objectKey: "projects/project_test/assets/sha256/audio.wav",
        sha256: "c".repeat(64),
        mimeType: "audio/wav",
        byteLength: 100,
        durationMs: 1_000,
      },
    ];
    manifest.clips = [
      {
        type: "still",
        clipId: "clip_image",
        trackId: "track_video",
        zIndex: 0,
        startFrame: 0,
        durationFrames: 30,
        sourceStartFrame: 0,
        assetVersionId: "asset_image_v1",
        opacity: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        transitionOut: { type: "fade-to-black", durationFrames: 5 },
      },
      {
        type: "text",
        clipId: "clip_title",
        trackId: "track_overlay",
        zIndex: 1,
        startFrame: 5,
        durationFrames: 20,
        text: "FAX ORACLE",
        opacity: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        transitionIn: { type: "fade", durationFrames: 4 },
        style: {
          fontFamily: "Inter",
          fontSizePx: 48,
          fontWeight: 700,
          fontStyle: "normal",
          color: "#ECE8DC",
          textAlign: "center",
          lineHeight: 1,
          letterSpacingPx: 0,
        },
      },
    ];
    manifest.audio = [{
      type: "narration",
      clipId: "clip_audio",
      trackId: "track_audio",
      startFrame: 0,
      durationFrames: 30,
      sourceStartFrame: 0,
      assetVersionId: "asset_audio_v1",
      gainDb: -2,
      fadeInFrames: 0,
      fadeOutFrames: 5,
    }];

    const plan = buildFfmpegPlan({
      manifest,
      assetPaths: new Map([
        ["asset_image_v1", "/tmp/assets/image.png"],
        ["asset_audio_v1", "/tmp/assets/audio.wav"],
      ]),
      subtitleFilePaths: new Map([["clip_title", "/tmp/text/title.ass"]]),
      fontPath: "/tmp/fonts/Inter.ttf",
      outputPath: "/tmp/output/render.mp4",
    });

    expect(plan.args).toContain("libx264");
    expect(plan.args).toContain("aac");
    expect(plan.args).toContain("yuv420p");
    expect(plan.args).toContain("+faststart");
    expect(plan.filterGraph).toContain("ass=filename=");
    expect(plan.filterGraph).toContain("afade=t=out");
    expect(plan.filterGraph).toContain("fade=t=out");
    expect(plan.args.join(" ")).not.toContain("bash");

    const subtitle = buildAssSubtitle(manifest.clips[1] as Extract<RenderManifest["clips"][number], { type: "text" }>, manifest);
    expect(subtitle).toContain("Style: Praxis,Inter,48");
    expect(subtitle).toContain("Dialogue: 0,0:00:00.00,9:59:59.99,Praxis");

    const adversarial = structuredClone(manifest.clips[1]) as Extract<RenderManifest["clips"][number], { type: "text" }>;
    adversarial.text = "{\\pos(0,0)}\nsecond line";
    const escaped = buildAssSubtitle(adversarial, manifest);
    expect(escaped).not.toContain("{\\pos(0,0)}\n");
    expect(escaped).toContain("\\{\\\\pos(0,0)\\}\\Nsecond line");
  });
});

const listen = async (server: http.Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
};

const authSecret = "render-test-secret-".repeat(3);
const tokenFor = (jobId: string, expiresAt = Math.floor(Date.now() / 1_000) + 60): string =>
  createJobToken(authSecret, { jobId, expiresAt });
const serverOptions = (executor: RenderExecutor) => ({
  authSecret,
  tokenMaxTtlSeconds: 300,
  maxRequestBytes: 1_000_000,
  timeoutMs: 10_000,
  executor,
});

describe("transport contract", () => {
  it("loads a dedicated render-result signing key without exposing it through transport auth", async () => {
    const names = [
      "PRAXIS_RENDER_AUTH_SECRET",
      "PRAXIS_RENDER_RESULT_SIGNING_SECRET",
      "PRAXIS_RENDER_RESULT_SIGNING_KEY_ID",
      "PRAXIS_OBJECT_STORE_ROOT",
      "PRAXIS_RENDER_TEMP_ROOT",
    ] as const;
    const original = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.PRAXIS_RENDER_AUTH_SECRET = authSecret;
      process.env.PRAXIS_RENDER_RESULT_SIGNING_SECRET = "dedicated-result-secret-".repeat(3);
      process.env.PRAXIS_RENDER_RESULT_SIGNING_KEY_ID = "staging-result-v2";
      process.env.PRAXIS_OBJECT_STORE_ROOT = await temporaryDirectory();
      process.env.PRAXIS_RENDER_TEMP_ROOT = await temporaryDirectory();
      const config = await loadRenderWorkerConfig();

      expect(config.authSecret).toBe(authSecret);
      expect(config.resultSigningSecret).toBe("dedicated-result-secret-".repeat(3));
      expect(config.resultSigningKeyId).toBe("staging-result-v2");
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses to reuse transport authentication as the result-signing domain", async () => {
    const names = ["PRAXIS_RENDER_AUTH_SECRET", "PRAXIS_RENDER_RESULT_SIGNING_SECRET"] as const;
    const original = new Map(names.map((name) => [name, process.env[name]]));
    try {
      process.env.PRAXIS_RENDER_AUTH_SECRET = authSecret;
      delete process.env.PRAXIS_RENDER_RESULT_SIGNING_SECRET;
      await expect(loadRenderWorkerConfig()).rejects.toThrow(/PRAXIS_RENDER_RESULT_SIGNING_SECRET/);
    } finally {
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("binds signed tokens to one unexpired job", () => {
    const now = 2_000_000_000;
    const token = createJobToken(authSecret, { jobId: "job_bound", expiresAt: now + 60 });
    expect(verifyJobToken({ token, secret: authSecret, expectedJobId: "job_bound", maxTtlSeconds: 300, nowSeconds: now })).toBe(true);
    expect(verifyJobToken({ token, secret: authSecret, expectedJobId: "job_other", maxTtlSeconds: 300, nowSeconds: now })).toBe(false);
    expect(verifyJobToken({ token, secret: authSecret, expectedJobId: "job_bound", maxTtlSeconds: 300, nowSeconds: now + 61 })).toBe(false);
    expect(verifyJobToken({ token: `${token}x`, secret: authSecret, expectedJobId: "job_bound", maxTtlSeconds: 300, nowSeconds: now })).toBe(false);
    const tokenParts = token.split(".");
    tokenParts[2] = nonCanonicalBase64Url(tokenParts[2]!);
    expect(verifyJobToken({ token: tokenParts.join("."), secret: authSecret, expectedJobId: "job_bound", maxTtlSeconds: 300, nowSeconds: now })).toBe(false);
  });

  it("signs the strict result envelope and rejects payload or key tampering", () => {
    const signingSecret = "result-signing-secret-".repeat(3);
    const envelope = createSignedRenderResult(signingSecret, "staging-v1", baseResult());

    expect(verifySignedRenderResult({
      envelope,
      secret: signingSecret,
      expectedKeyId: "staging-v1",
    })).toBe(true);
    expect(verifySignedRenderResult({
      envelope: { ...envelope, payload: { ...envelope.payload, projectRevision: 8 } },
      secret: signingSecret,
      expectedKeyId: "staging-v1",
    })).toBe(false);
    expect(verifySignedRenderResult({
      envelope,
      secret: signingSecret,
      expectedKeyId: "other-key",
    })).toBe(false);
    expect(verifySignedRenderResult({
      envelope: { ...envelope, signature: nonCanonicalBase64Url(envelope.signature) },
      secret: signingSecret,
      expectedKeyId: "staging-v1",
    })).toBe(false);
  });

  it("requires exact remote asset access and immutable output destinations", () => {
    const manifest = baseManifest();
    manifest.assets = [{
      assetId: "asset_image",
      assetVersionId: "asset_image_v1",
      objectKey: "projects/project_test/assets/sha256/image.png",
      sha256: "a".repeat(64),
      mimeType: "image/png",
      byteLength: 100,
    }];
    const baseRequest = { jobId: "job_remote", manifestSha256: "b".repeat(64), manifest };
    expect(RenderRequestSchema.safeParse({
      ...baseRequest,
      assetAccess: [{ assetVersionId: "asset_image_v1", getUrl: "http://127.0.0.1:9999/input" }],
      outputDestinations: {
        video: {
          objectKey: "projects/project_test/renders/7/render_test.mp4",
          putUrl: "http://127.0.0.1:9999/video",
        },
        poster: {
          objectKey: "projects/project_test/renders/7/render_test.jpg",
          putUrl: "http://127.0.0.1:9999/poster",
        },
        result: {
          objectKey: "projects/project_test/render-results/7/render_test.json",
          putUrl: "http://127.0.0.1:9999/result",
        },
      },
    }).success).toBe(true);
    expect(RenderRequestSchema.safeParse({ ...baseRequest, assetAccess: [] }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({
      ...baseRequest,
      assetAccess: [{ assetVersionId: "asset_image_v1", getUrl: "http://example.com/input" }],
    }).success).toBe(false);
  });
});

describe("render HTTP service", () => {
  it("keeps health narrow and requires bearer auth for rendering", async () => {
    const manifest = baseManifest();
    const result = baseResult();
    const executor: RenderExecutor = { execute: async () => result };
    const server = createRenderServer(serverOptions(executor));
    const baseUrl = await listen(server);
    try {
      expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
      const unauthorized = await fetch(`${baseUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: "job_test", manifestSha256: "d".repeat(64), manifest }),
      });
      expect(unauthorized.status).toBe(401);
      const wrongJobToken = await fetch(`${baseUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("job_other")}` },
        body: JSON.stringify({ jobId: "job_test", manifestSha256: "d".repeat(64), manifest }),
      });
      expect(wrongJobToken.status).toBe(401);
      const authorized = await fetch(`${baseUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${tokenFor("job_test")}` },
        body: JSON.stringify({ jobId: "job_test", manifestSha256: "d".repeat(64), manifest }),
      });
      expect(authorized.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("cancels an active render by job ID", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const executor: RenderExecutor = {
      execute: async (_request: RenderRequest, signal: AbortSignal) => {
        started();
        return await new Promise<RenderResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new ProcessExecutionError({
            code: "PROCESS_ABORTED",
            message: "cancelled",
          })), { once: true });
        });
      },
    };
    const renderToken = tokenFor("job_cancel");
    const server = createRenderServer(serverOptions(executor));
    const baseUrl = await listen(server);
    const manifest = baseManifest();
    try {
      const renderResponse = fetch(`${baseUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${renderToken}` },
        body: JSON.stringify({ jobId: "job_cancel", manifestSha256: "d".repeat(64), manifest }),
      });
      await didStart;
      const wrongJobCancellation = await fetch(`${baseUrl}/jobs/job_cancel/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokenFor("job_other")}` },
      });
      expect(wrongJobCancellation.status).toBe(401);
      const cancellation = await fetch(`${baseUrl}/jobs/job_cancel/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${renderToken}` },
      });
      expect(cancellation.status).toBe(202);
      expect((await renderResponse).status).toBe(409);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("decodes percent-encoded colon job IDs for active cancellation", async () => {
    const jobId = "job:encoded";
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const executor: RenderExecutor = {
      execute: async (_request: RenderRequest, signal: AbortSignal) => {
        started();
        return await new Promise<RenderResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new ProcessExecutionError({
            code: "PROCESS_ABORTED",
            message: "cancelled",
          })), { once: true });
        });
      },
    };
    const token = tokenFor(jobId);
    const server = createRenderServer(serverOptions(executor));
    const baseUrl = await listen(server);
    const manifest = baseManifest();
    try {
      const renderResponse = fetch(`${baseUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId, manifestSha256: "d".repeat(64), manifest }),
      });
      await didStart;

      const cancellation = await fetch(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(cancellation.status).toBe(202);
      expect(await cancellation.json()).toMatchObject({
        ok: true,
        jobId,
        status: "cancel_requested",
        active: true,
      });
      expect((await renderResponse).status).toBe(409);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("tombstones pre-dispatch cancellation and never invokes the executor", async () => {
    const jobId = "job_tombstone";
    let executionCount = 0;
    const executor: RenderExecutor = {
      execute: async () => {
        executionCount += 1;
        throw new Error("executor must not run for a tombstoned job");
      },
    };
    const token = tokenFor(jobId);
    const server = createRenderServer(serverOptions(executor));
    const baseUrl = await listen(server);
    const manifest = baseManifest();
    try {
      const cancellation = await fetch(`${baseUrl}/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(cancellation.status).toBe(202);
      expect(await cancellation.json()).toMatchObject({
        ok: true,
        jobId,
        status: "cancel_requested",
        active: false,
      });

      const renderResponse = await fetch(`${baseUrl}/render`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jobId, manifestSha256: "d".repeat(64), manifest }),
      });

      expect(renderResponse.status).toBe(409);
      expect(await renderResponse.json()).toMatchObject({
        ok: false,
        error: { code: "RENDER_CANCELLED" },
      });
      expect(executionCount).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  RENDER_MANIFEST_COMPILER_VERSION,
  RENDER_MANIFEST_SCHEMA_VERSION,
  SignedRenderResultEnvelopeSchema,
  canonicalSerialize,
  renderResultObjectKey,
  sha256Hex,
  type RenderManifest,
} from "@praxis/render-manifest";
import { loadRenderWorkerConfig } from "../src/config";
import { verifySignedRenderResult } from "../src/auth";
import { FfmpegRenderExecutor } from "../src/executor";
import { hashFile } from "../src/object-store";
import { ProcessExecutionError, runProcess } from "../src/process";

const enabled = process.env.PRAXIS_RUN_RENDER_INTEGRATION === "1";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("real FFmpeg render", () => {
  it("renders from filesystem or signed transport and uploads validated outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "praxis-real-render-"));
    roots.push(root);
    const objects = path.join(root, "objects");
    const temp = path.join(root, "temp");
    await Promise.all([mkdir(objects), mkdir(temp)]);
    process.env.PRAXIS_RENDER_AUTH_SECRET = "integration-secret".repeat(3);
    process.env.PRAXIS_RENDER_RESULT_SIGNING_SECRET = "integration-result-secret".repeat(3);
    process.env.PRAXIS_RENDER_ALLOW_STATIC_AUTH = "0";
    process.env.PRAXIS_OBJECT_STORE_ROOT = objects;
    process.env.PRAXIS_RENDER_TEMP_ROOT = temp;
    process.env.PRAXIS_RENDERER_VERSION = "integration-renderer";
    process.env.PRAXIS_FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
    process.env.PRAXIS_FONT_FAMILY = "DejaVu Sans";
    process.env.PRAXIS_ASS_FONT_FAMILY = "DejaVu Sans";
    process.env.PRAXIS_FONT_WEIGHT = "700";
    process.env.PRAXIS_FONT_STYLE = "normal";
    const config = await loadRenderWorkerConfig();

    const imageKey = "projects/project_test/assets/sha256/image.png";
    const audioKey = "projects/project_test/assets/sha256/audio.wav";
    const imagePath = path.join(objects, imageKey);
    const audioPath = path.join(objects, audioKey);
    await Promise.all([mkdir(path.dirname(imagePath), { recursive: true }), mkdir(path.dirname(audioPath), { recursive: true })]);
    await runProcess({
      command: config.ffmpegPath,
      args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xB9C5BD:s=320x180", "-frames:v", "1", imagePath],
      timeoutMs: 30_000,
    });
    await runProcess({
      command: config.ffmpegPath,
      args: ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", audioPath],
      timeoutMs: 30_000,
    });
    const [imageHash, audioHash] = await Promise.all([hashFile(imagePath), hashFile(audioPath)]);
    const manifest: RenderManifest = {
      schemaVersion: RENDER_MANIFEST_SCHEMA_VERSION,
      compilerVersion: RENDER_MANIFEST_COMPILER_VERSION,
      renderId: "render_integration",
      projectId: "project_test",
      projectRevision: 1,
      projectSnapshotHash: "a".repeat(64),
      renderer: { name: "praxis-ffmpeg", version: config.rendererVersion },
      canvas: { width: 320, height: 180, fps: 30, durationFrames: 30, backgroundColor: "#16191C" },
      assets: [
        { assetId: "asset_image", assetVersionId: "asset_image_v1", objectKey: imageKey, ...imageHash, mimeType: "image/png", width: 320, height: 180 },
        { assetId: "asset_audio", assetVersionId: "asset_audio_v1", objectKey: audioKey, ...audioHash, mimeType: "audio/wav", durationMs: 1_000 },
      ],
      clips: [
        {
          type: "still",
          clipId: "clip_image_a",
          trackId: "track_video",
          zIndex: 0,
          startFrame: 0,
          durationFrames: 15,
          sourceStartFrame: 0,
          assetVersionId: "asset_image_v1",
          opacity: 1,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        },
        {
          type: "still",
          clipId: "clip_image_b",
          trackId: "track_video",
          zIndex: 0,
          startFrame: 15,
          durationFrames: 15,
          sourceStartFrame: 0,
          assetVersionId: "asset_image_v1",
          opacity: 1,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          transitionIn: { type: "dissolve", durationFrames: 3 },
        },
        {
          type: "text",
          clipId: "clip_title",
          trackId: "track_overlay",
          zIndex: 1,
          startFrame: 3,
          durationFrames: 24,
          text: "PRAXIS",
          opacity: 1,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          transitionIn: { type: "fade", durationFrames: 3 },
          style: {
            fontFamily: "DejaVu Sans",
            fontSizePx: 42,
            fontWeight: 700,
            fontStyle: "normal",
            color: "#ECE8DC",
            textAlign: "center",
            lineHeight: 1,
            letterSpacingPx: 0,
          },
        },
      ],
      audio: [{
        type: "narration",
        clipId: "clip_audio",
        trackId: "track_audio",
        startFrame: 0,
        durationFrames: 30,
        sourceStartFrame: 0,
        assetVersionId: "asset_audio_v1",
        gainDb: 0,
        fadeInFrames: 0,
        fadeOutFrames: 0,
      }],
      output: { kind: "preview", container: "mp4", videoCodec: "h264", audioCodec: "aac", pixelFormat: "yuv420p" },
    };
    const manifestSha256 = await sha256Hex(canonicalSerialize(manifest));
    let result;
    try {
      result = await new FfmpegRenderExecutor(config).execute(
        { jobId: "job_integration", manifestSha256, manifest },
        new AbortController().signal,
      );
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        throw new Error(`${error.message}\n${error.stderr}`);
      }
      throw error;
    }

    expect(result.video.videoCodec).toBe("h264");
    expect(result.video.audioCodec).toBe("aac");
    expect(result.video.pixelFormat).toBe("yuv420p");
    expect(result.video.durationMs).toBeGreaterThanOrEqual(990);
    expect(result.poster.mimeType).toBe("image/jpeg");
    const localEnvelope = SignedRenderResultEnvelopeSchema.parse(JSON.parse(await readFile(
      path.join(objects, renderResultObjectKey(manifest)),
      "utf8",
    )));
    expect(verifySignedRenderResult({
      envelope: localEnvelope,
      secret: config.resultSigningSecret,
      expectedKeyId: config.resultSigningKeyId,
    })).toBe(true);
    expect(localEnvelope.payload).toEqual(result);

    const [imageBytes, audioBytes] = await Promise.all([readFile(imagePath), readFile(audioPath)]);
    await Promise.all([rm(imagePath), rm(audioPath)]);
    const uploads = new Map<string, { body: Buffer; headers: http.IncomingHttpHeaders }>();
    const requests: string[] = [];
    const transport = http.createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname.startsWith("/input/")) {
        const source = url.pathname.includes("audio") ? audioBytes : imageBytes;
        const body = url.pathname.includes("corrupt")
          ? Buffer.concat([source.subarray(0, source.length - 1), Buffer.from([source[source.length - 1]! ^ 0xff])])
          : source;
        response.writeHead(200, { "content-length": body.length });
        response.write(body.subarray(0, Math.floor(body.length / 2)));
        response.end(body.subarray(Math.floor(body.length / 2)));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/output/")) {
        const upload = uploads.get(url.pathname);
        if (!upload) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "content-type": upload.headers["content-type"],
          "content-length": upload.body.length,
        });
        response.end(upload.body);
        return;
      }
      if (request.method === "PUT" && url.pathname.startsWith("/output/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (uploads.has(url.pathname)) {
          response.writeHead(412);
          response.end();
          return;
        }
        uploads.set(url.pathname, { body: Buffer.concat(chunks), headers: request.headers });
        response.writeHead(200);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => transport.listen(0, "127.0.0.1", resolve));
    const address = transport.address();
    if (!address || typeof address === "string") throw new Error("Expected signed-transport listener");
    const transportUrl = `http://127.0.0.1:${address.port}`;
    const videoObjectKey = "projects/project_test/renders/1/render_integration.mp4";
    const posterObjectKey = "projects/project_test/renders/1/render_integration.jpg";
    const resultObjectKey = "projects/project_test/render-results/1/render_integration.json";
    try {
      const remoteResult = await new FfmpegRenderExecutor(config).execute({
        jobId: "job_remote_integration",
        manifestSha256,
        manifest,
        assetAccess: [
          { assetVersionId: "asset_image_v1", getUrl: `${transportUrl}/input/image?token=input-secret-a` },
          { assetVersionId: "asset_audio_v1", getUrl: `${transportUrl}/input/audio?token=input-secret-b` },
        ],
        outputDestinations: {
          video: {
            objectKey: videoObjectKey,
            putUrl: `${transportUrl}/output/video?token=output-secret-a`,
            existingObjectGetUrl: `${transportUrl}/output/video?token=verify-secret-a`,
          },
          poster: {
            objectKey: posterObjectKey,
            putUrl: `${transportUrl}/output/poster?token=output-secret-b`,
            existingObjectGetUrl: `${transportUrl}/output/poster?token=verify-secret-b`,
          },
          result: { objectKey: resultObjectKey, putUrl: `${transportUrl}/output/result?token=output-secret-c` },
        },
      }, new AbortController().signal);

      expect(requests).toEqual([
        "GET /input/image",
        "GET /input/audio",
        "PUT /output/video",
        "PUT /output/poster",
        "PUT /output/result",
      ]);
      for (const [pathname, expectedMime, metadata] of [
        ["/output/video", "video/mp4", remoteResult.video],
        ["/output/poster", "image/jpeg", remoteResult.poster],
      ] as const) {
        const upload = uploads.get(pathname)!;
        expect(upload.headers["content-type"]).toBe(expectedMime);
        expect(Number(upload.headers["content-length"])).toBe(upload.body.length);
        expect(upload.headers["if-none-match"]).toBe("*");
        expect(upload.headers["x-praxis-sha256"]).toBe(metadata.sha256);
        expect(createHash("sha256").update(upload.body).digest("hex")).toBe(metadata.sha256);
        expect(upload.body.length).toBe(metadata.byteLength);
      }
      const resultUpload = uploads.get("/output/result")!;
      expect(resultUpload.headers["content-type"]).toBe("application/json");
      expect(Number(resultUpload.headers["content-length"])).toBe(resultUpload.body.length);
      expect(resultUpload.headers["if-none-match"]).toBe("*");
      expect(resultUpload.headers["x-praxis-sha256"]).toBe(
        createHash("sha256").update(resultUpload.body).digest("hex"),
      );
      const envelope = SignedRenderResultEnvelopeSchema.parse(JSON.parse(resultUpload.body.toString("utf8")));
      expect(verifySignedRenderResult({
        envelope,
        secret: config.resultSigningSecret,
        expectedKeyId: config.resultSigningKeyId,
      })).toBe(true);
      expect(envelope.payload).toEqual(remoteResult);
      expect(JSON.stringify(remoteResult)).not.toContain("secret-");

      uploads.delete("/output/result");
      requests.length = 0;
      const replayResult = await new FfmpegRenderExecutor(config).execute({
        jobId: "job_remote_recovery",
        manifestSha256,
        manifest,
        assetAccess: [
          { assetVersionId: "asset_image_v1", getUrl: `${transportUrl}/input/image?token=recovery-input-a` },
          { assetVersionId: "asset_audio_v1", getUrl: `${transportUrl}/input/audio?token=recovery-input-b` },
        ],
        outputDestinations: {
          video: {
            objectKey: videoObjectKey,
            putUrl: `${transportUrl}/output/video?token=recovery-output-a`,
            existingObjectGetUrl: `${transportUrl}/output/video?token=recovery-verify-a`,
          },
          poster: {
            objectKey: posterObjectKey,
            putUrl: `${transportUrl}/output/poster?token=recovery-output-b`,
            existingObjectGetUrl: `${transportUrl}/output/poster?token=recovery-verify-b`,
          },
          result: { objectKey: resultObjectKey, putUrl: `${transportUrl}/output/result?token=recovery-output-c` },
        },
      }, new AbortController().signal);
      expect(requests).toEqual([
        "GET /input/image",
        "GET /input/audio",
        "PUT /output/video",
        "GET /output/video",
        "PUT /output/poster",
        "GET /output/poster",
        "PUT /output/result",
      ]);
      expect(replayResult.video).toEqual(remoteResult.video);
      expect(replayResult.poster).toEqual(remoteResult.poster);

      await expect(new FfmpegRenderExecutor(config).execute({
        jobId: "job_corrupt_download",
        manifestSha256,
        manifest,
        assetAccess: [
          { assetVersionId: "asset_image_v1", getUrl: `${transportUrl}/input/image-corrupt?token=do-not-return` },
          { assetVersionId: "asset_audio_v1", getUrl: `${transportUrl}/input/audio?token=do-not-return` },
        ],
      }, new AbortController().signal)).rejects.toThrow(/SHA-256/);
    } finally {
      await new Promise<void>((resolve, reject) => transport.close((error) => error ? reject(error) : resolve()));
    }
  }, 120_000);
});

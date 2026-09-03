import { describe, expect, it } from "vitest";
import { createSeedProject } from "@praxis/project-schema";
import type { Env } from "./env";
import { presignR2Object } from "./r2-presign";
import {
  DirectUploadFinalizeSchema,
  checksumBufferToHex,
  directUploadCommandOperations,
  persistedUploadRecord,
  sha256HexToBase64,
  verifyDirectUploadObject,
} from "./direct-upload";

const sha256 = "0123456789abcdef".repeat(4);
const checksum = Uint8Array.from(sha256.match(/../g)!.map((pair) => Number.parseInt(pair, 16))).buffer;
const expected = { sha256, mimeType: "image/png" as const, byteLength: 42 };

describe("direct upload integrity", () => {
  it("converts between the S3 base64 checksum and Praxis hexadecimal digest", () => {
    expect(sha256HexToBase64(sha256)).toBe("ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=");
    expect(checksumBufferToHex(checksum)).toBe(sha256);
  });

  it("accepts only matching R2-derived size, MIME, and SHA-256 metadata", () => {
    expect(verifyDirectUploadObject({ size: 42, httpMetadata: { contentType: "image/png" }, checksums: { sha256: checksum } }, expected))
      .toEqual({ ok: true, sha256 });
    expect(verifyDirectUploadObject({ size: 41, httpMetadata: { contentType: "image/png" }, checksums: { sha256: checksum } }, expected))
      .toMatchObject({ ok: false, code: "UPLOAD_SIZE_MISMATCH" });
    expect(verifyDirectUploadObject({ size: 42, httpMetadata: { contentType: "image/jpeg" }, checksums: { sha256: checksum } }, expected))
      .toMatchObject({ ok: false, code: "UPLOAD_MIME_MISMATCH" });
    expect(verifyDirectUploadObject({ size: 42, httpMetadata: { contentType: "image/png" }, checksums: {} }, expected))
      .toMatchObject({ ok: false, code: "UPLOAD_CHECKSUM_UNAVAILABLE", status: 422 });
    const otherChecksum = Uint8Array.from(new Uint8Array(checksum), (byte) => byte ^ 0xff).buffer;
    expect(verifyDirectUploadObject({ size: 42, httpMetadata: { contentType: "image/png" }, checksums: { sha256: otherChecksum } }, expected))
      .toMatchObject({ ok: false, code: "UPLOAD_SHA256_MISMATCH" });
  });

  it("validates media-specific finalization metadata and builds command-ready operations", () => {
    const parsed = DirectUploadFinalizeSchema.parse({
      ...expected,
      assetId: "asset_direct_card",
      assetVersionId: "asset_version_direct_card",
      kind: "image",
      name: "Direct card",
      width: 1920,
      height: 1080,
    });
    expect(() => DirectUploadFinalizeSchema.parse({ ...parsed, kind: "audio" })).toThrow();
    const project = createSeedProject();
    const record = persistedUploadRecord(
      project.projectId,
      `projects/${project.projectId}/assets/sha256/${sha256}.png`,
      parsed,
      "2026-08-26T12:00:00.000Z",
      { kind: "director", id: "director_upload_test" },
    );
    expect(record.provenance).toMatchObject({
      source: "direct-upload",
      creationActor: { kind: "director", id: "director_upload_test" },
    });
    const operations = directUploadCommandOperations(project, record, parsed.name);
    expect(operations.map((operation) => operation.type)).toEqual(["asset.create", "asset.addVersion", "asset.selectVersion"]);
    expect(operations[1]).toMatchObject({
      type: "asset.addVersion",
      version: { id: parsed.assetVersionId, sha256, byteLength: 42, status: "ready" },
    });
  });
});

describe("direct upload presigning", () => {
  it("signs create-only, MIME, and SHA-256 headers into the R2 PUT URL", async () => {
    const env = {
      R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      R2_ACCESS_KEY_ID: "test-access-key",
      R2_SECRET_ACCESS_KEY: "test-secret-key",
      R2_BUCKET_NAME: "praxis-test",
    } as Env;
    const signed = await presignR2Object(env, {
      objectKey: `projects/project_demo/assets/sha256/${sha256}.png`,
      method: "PUT",
      contentType: "image/png",
      checksumSha256: sha256,
      expiresInSeconds: 600,
    });
    expect(signed.headers).toEqual({
      "if-none-match": "*",
      "content-type": "image/png",
      "x-amz-checksum-sha256": "ASNFZ4mrze8BI0VniavN7wEjRWeJq83vASNFZ4mrze8=",
    });
    const signedHeaders = new URL(signed.url).searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
    expect(signedHeaders).toEqual(expect.arrayContaining(["content-type", "host", "if-none-match", "x-amz-checksum-sha256"]));
  });
});

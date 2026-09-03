import { PersistedAssetRecordSchema, type PersistedAssetRecord } from "@praxis/jobs";
import type { ProjectOperation } from "@praxis/commands";
import { StableIdSchema, type ProductionProject } from "@praxis/project-schema";
import { z } from "zod";

export const DirectUploadMimeTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
]);

export const DirectUploadRequestSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: DirectUploadMimeTypeSchema,
    byteLength: z.number().int().positive().max(1_073_741_824),
  })
  .strict();

export const DirectUploadFinalizeSchema = DirectUploadRequestSchema.extend({
  assetId: StableIdSchema,
  assetVersionId: StableIdSchema,
  kind: z.enum(["image", "audio", "music"]),
  name: z.string().min(1).max(160),
  width: z.number().int().positive().max(32_768).optional(),
  height: z.number().int().positive().max(32_768).optional(),
  durationMs: z.number().int().positive().max(86_400_000).optional(),
  provenance: z.record(z.unknown()).optional(),
})
  .strict()
  .superRefine((value, context) => {
    const isImage = value.mimeType.startsWith("image/");
    if ((isImage && value.kind !== "image") || (!isImage && value.kind === "image")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: isImage ? "Image uploads require kind=image" : "Audio uploads require kind=audio or kind=music",
      });
    }
    if (isImage && (value.width === undefined || value.height === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["width"],
        message: "Image uploads require width and height metadata",
      });
    }
    if (!isImage && value.durationMs === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["durationMs"],
        message: "Audio uploads require durationMs metadata",
      });
    }
  });

export type DirectUploadRequest = z.infer<typeof DirectUploadRequestSchema>;
export type DirectUploadFinalize = z.infer<typeof DirectUploadFinalizeSchema>;

const extensionByMimeType: Record<z.infer<typeof DirectUploadMimeTypeSchema>, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
};

export const directUploadObjectKey = (projectId: string, upload: Pick<DirectUploadRequest, "sha256" | "mimeType">) =>
  `projects/${projectId}/assets/sha256/${upload.sha256}.${extensionByMimeType[upload.mimeType]}`;

const hexByte = (pair: string) => Number.parseInt(pair, 16);

/** S3 checksum headers use base64 while Praxis stores lowercase hexadecimal digests. */
export const sha256HexToBase64 = (sha256: string): string => {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("INVALID_SHA256");
  let binary = "";
  for (let offset = 0; offset < sha256.length; offset += 2) binary += String.fromCharCode(hexByte(sha256.slice(offset, offset + 2)));
  return btoa(binary);
};

export const checksumBufferToHex = (checksum: ArrayBuffer): string =>
  [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

interface VerifiableR2Metadata {
  size: number;
  httpMetadata?: { contentType?: string };
  checksums?: { sha256?: ArrayBuffer };
}

export type DirectUploadVerification =
  | { ok: true; sha256: string }
  | { ok: false; status: 409 | 422; code: string; message: string };

/**
 * Verifies only metadata that R2 itself derives or validates while receiving the
 * object. Custom metadata supplied by the browser is deliberately not trusted.
 */
export const verifyDirectUploadObject = (
  object: VerifiableR2Metadata,
  expected: DirectUploadRequest,
): DirectUploadVerification => {
  if (object.size !== expected.byteLength) {
    return { ok: false, status: 409, code: "UPLOAD_SIZE_MISMATCH", message: "Stored object size does not match the initiated upload" };
  }
  if (object.httpMetadata?.contentType !== expected.mimeType) {
    return { ok: false, status: 409, code: "UPLOAD_MIME_MISMATCH", message: "Stored object MIME type does not match the initiated upload" };
  }
  if (!object.checksums?.sha256) {
    return {
      ok: false,
      status: 422,
      code: "UPLOAD_CHECKSUM_UNAVAILABLE",
      message: "R2 did not retain a verified SHA-256 checksum for this object",
    };
  }
  const sha256 = checksumBufferToHex(object.checksums.sha256);
  if (sha256 !== expected.sha256) {
    return { ok: false, status: 409, code: "UPLOAD_SHA256_MISMATCH", message: "Stored object SHA-256 does not match the initiated upload" };
  }
  return { ok: true, sha256 };
};

export const persistedUploadRecord = (
  projectId: string,
  objectKey: string,
  input: DirectUploadFinalize,
  createdAt: string,
  creationActor: { kind: "director" | "codex" | "system"; id: string; runId?: string },
): PersistedAssetRecord =>
  PersistedAssetRecordSchema.parse({
    assetId: input.assetId,
    assetVersionId: input.assetVersionId,
    projectId,
    kind: input.kind,
    objectKey,
    sha256: input.sha256,
    mimeType: input.mimeType,
    byteLength: input.byteLength,
    width: input.width,
    height: input.height,
    durationMs: input.durationMs,
    provenance: { ...input.provenance, source: "direct-upload", creationActor },
    createdAt,
  });

export const sameImmutableUploadRecord = (left: PersistedAssetRecord, right: PersistedAssetRecord): boolean =>
  left.assetId === right.assetId &&
  left.assetVersionId === right.assetVersionId &&
  left.projectId === right.projectId &&
  left.kind === right.kind &&
  left.objectKey === right.objectKey &&
  left.sha256 === right.sha256 &&
  left.mimeType === right.mimeType &&
  left.byteLength === right.byteLength &&
  left.width === right.width &&
  left.height === right.height &&
  left.durationMs === right.durationMs;

export const directUploadCommandOperations = (
  project: ProductionProject,
  record: PersistedAssetRecord,
  name: string,
): ProjectOperation[] => {
  if (record.kind !== "image" && record.kind !== "audio" && record.kind !== "music") {
    throw new Error("Unsupported direct-upload asset kind");
  }
  const existingAsset = project.assets[record.assetId];
  const existingVersion = existingAsset?.versions.find((version) => version.id === record.assetVersionId);
  const operations: ProjectOperation[] = [];
  if (!existingAsset) {
    operations.push({ type: "asset.create", asset: { id: record.assetId, kind: record.kind, name } });
  }
  if (!existingVersion) {
    const versionNumber = Math.max(0, ...(existingAsset?.versions.map((version) => version.version) ?? [])) + 1;
    operations.push({
      type: "asset.addVersion",
      assetId: record.assetId,
      version: {
        id: record.assetVersionId,
        version: versionNumber,
        status: "ready",
        uri: `/api/projects/${record.projectId}/assets/${record.assetVersionId}/access`,
        mimeType: record.mimeType,
        width: record.width,
        height: record.height,
        durationFrames: record.durationMs
          ? Math.max(1, Math.round((record.durationMs / 1_000) * project.metadata.fps))
          : undefined,
        durationMs: record.durationMs,
        createdAt: record.createdAt,
        checksum: record.sha256,
        objectKey: record.objectKey,
        sha256: record.sha256,
        byteLength: record.byteLength,
        provenance: { projectRevision: project.revision, sourceAssetVersionIds: [] },
      },
    });
  }
  if (existingAsset?.currentVersionId !== record.assetVersionId) {
    operations.push({ type: "asset.selectVersion", assetId: record.assetId, versionId: record.assetVersionId });
  }
  return operations;
};

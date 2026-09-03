import {
  ProductionProjectSchema,
  type ProductionProject,
  type TimelineClip,
} from "@praxis/project-schema";
import { z } from "zod";

export const RENDER_MANIFEST_SCHEMA_VERSION = "1" as const;
export const RENDER_MANIFEST_COMPILER_VERSION = "praxis-render-manifest/1" as const;

const IdSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9:_-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
export const ObjectKeySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((key) => !key.startsWith("/"), "objectKey must be relative")
  .refine((key) => !key.includes("://"), "objectKey cannot be a URL")
  .refine(
    (key) => key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "objectKey cannot contain empty or traversal segments",
  )
  .refine((key) => /^[A-Za-z0-9._/-]+$/.test(key), "objectKey contains unsupported characters");

export const TrustedAssetMetadataSchema = z
  .object({
    assetId: IdSchema,
    assetVersionId: IdSchema,
    projectId: IdSchema.optional(),
    kind: z.enum(["image", "audio", "music", "video", "render", "poster", "other"]).optional(),
    objectKey: ObjectKeySchema,
    sha256: Sha256Schema,
    mimeType: z.string().min(1).max(160),
    byteLength: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().positive().optional(),
    provenance: z.record(z.unknown()).optional(),
    createdAt: z.string().datetime().optional(),
  })
  .strict();
export type TrustedAssetMetadata = z.infer<typeof TrustedAssetMetadataSchema>;

export const RenderTransitionSchema = z
  .object({
    type: z.enum(["fade", "dissolve", "fade-to-black"]),
    durationFrames: z.number().int().positive().max(120),
  })
  .strict();
export type RenderTransition = z.infer<typeof RenderTransitionSchema>;

const ClipBaseSchema = z
  .object({
    clipId: IdSchema,
    trackId: IdSchema,
    zIndex: z.number().int().nonnegative(),
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
    opacity: z.number().min(0).max(1),
    transform: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        scale: z.number().positive().finite(),
        rotation: z.number().finite(),
      })
      .strict(),
    transitionIn: RenderTransitionSchema.optional(),
    transitionOut: RenderTransitionSchema.optional(),
  })
  .strict();

export const RenderStillClipSchema = ClipBaseSchema.extend({
  type: z.literal("still"),
  assetVersionId: IdSchema,
  sourceStartFrame: z.number().int().nonnegative(),
}).strict();

export const RenderTextClipSchema = ClipBaseSchema.extend({
  type: z.literal("text"),
  text: z.string().min(1).max(8_000),
  style: z
    .object({
      fontFamily: z.string().min(1).max(160).regex(/^[A-Za-z0-9 ._-]+$/),
      fontSizePx: z.number().positive().max(512),
      fontWeight: z.number().int().min(100).max(900),
      fontStyle: z.enum(["normal", "italic"]),
      color: HexColorSchema,
      backgroundColor: HexColorSchema.optional(),
      textAlign: z.enum(["left", "center", "right"]),
      lineHeight: z.number().min(0.5).max(4),
      letterSpacingPx: z.number().finite().min(-32).max(128),
    })
    .strict(),
}).strict();

export const RenderClipSchema = z.discriminatedUnion("type", [
  RenderStillClipSchema,
  RenderTextClipSchema,
]);
export type RenderClip = z.infer<typeof RenderClipSchema>;

export const RenderAudioClipSchema = z
  .object({
    type: z.enum(["narration", "music", "audio"]),
    clipId: IdSchema,
    trackId: IdSchema,
    startFrame: z.number().int().nonnegative(),
    durationFrames: z.number().int().positive(),
    sourceStartFrame: z.number().int().nonnegative(),
    assetVersionId: IdSchema,
    gainDb: z.number().finite().min(-96).max(24),
    fadeInFrames: z.number().int().nonnegative().max(120),
    fadeOutFrames: z.number().int().nonnegative().max(120),
  })
  .strict();
export type RenderAudioClip = z.infer<typeof RenderAudioClipSchema>;

export const RenderAssetSchema = z
  .object({
    assetId: IdSchema,
    assetVersionId: IdSchema,
    objectKey: ObjectKeySchema,
    sha256: Sha256Schema,
    mimeType: z.string().min(1).max(160),
    byteLength: z.number().int().positive(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().positive().optional(),
  })
  .strict();
export type RenderAsset = z.infer<typeof RenderAssetSchema>;

export const RenderManifestSchema = z
  .object({
    schemaVersion: z.literal(RENDER_MANIFEST_SCHEMA_VERSION),
    compilerVersion: z.literal(RENDER_MANIFEST_COMPILER_VERSION),
    renderId: IdSchema,
    projectId: IdSchema,
    projectRevision: z.number().int().nonnegative(),
    projectSnapshotHash: Sha256Schema,
    renderer: z
      .object({
        name: z.literal("praxis-ffmpeg"),
        version: z.string().min(1).max(120),
      })
      .strict(),
    canvas: z
      .object({
        width: z.number().int().positive().max(7_680),
        height: z.number().int().positive().max(4_320),
        fps: z.number().int().positive().max(120),
        durationFrames: z.number().int().positive().max(216_000),
        backgroundColor: HexColorSchema,
      })
      .strict(),
    assets: z.array(RenderAssetSchema).max(2_000),
    clips: z.array(RenderClipSchema).max(2_000),
    audio: z.array(RenderAudioClipSchema).max(256),
    output: z
      .object({
        kind: z.enum(["preview", "final"]),
        container: z.literal("mp4"),
        videoCodec: z.literal("h264"),
        audioCodec: z.literal("aac"),
        pixelFormat: z.literal("yuv420p"),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const versionIds = new Set(manifest.assets.map((asset) => asset.assetVersionId));
    if (versionIds.size !== manifest.assets.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets"],
        message: "Manifest asset version IDs must be unique",
      });
    }
    for (const [index, clip] of manifest.clips.entries()) {
      if (clip.type === "still" && !versionIds.has(clip.assetVersionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clips", index, "assetVersionId"],
          message: "Still clip must reference a manifest asset",
        });
      }
      if (clip.startFrame + clip.durationFrames > manifest.canvas.durationFrames) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["clips", index, "durationFrames"],
          message: "Clip extends beyond the canvas duration",
        });
      }
      for (const [name, transition] of [
        ["transitionIn", clip.transitionIn],
        ["transitionOut", clip.transitionOut],
      ] as const) {
        if (transition && transition.durationFrames > clip.durationFrames) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["clips", index, name, "durationFrames"],
            message: "Transition cannot be longer than its clip",
          });
        }
      }
    }
    for (const [index, clip] of manifest.audio.entries()) {
      if (!versionIds.has(clip.assetVersionId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audio", index, "assetVersionId"],
          message: "Audio clip must reference a manifest asset",
        });
      }
      if (clip.startFrame + clip.durationFrames > manifest.canvas.durationFrames) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audio", index, "durationFrames"],
          message: "Audio clip extends beyond the canvas duration",
        });
      }
      if (clip.fadeInFrames + clip.fadeOutFrames > clip.durationFrames) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["audio", index],
          message: "Audio fades cannot overlap beyond the clip duration",
        });
      }
    }
  });
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export const RENDER_RESULT_SCHEMA_VERSION = "1" as const;
export const RENDER_RESULT_SIGNATURE_ALGORITHM = "hmac-sha256" as const;
export const RENDER_RESULT_SIGNING_DOMAIN = "praxis-render-result/v1" as const;

const RenderResultObjectBaseSchema = z
  .object({
    objectKey: ObjectKeySchema,
    sha256: Sha256Schema,
    byteLength: z.number().int().positive(),
  })
  .strict();

/**
 * Immutable metadata emitted by the renderer after it has hashed and probed
 * the exact output files. The payload deliberately contains no signed URLs or
 * reusable credentials.
 */
export const RenderResultPayloadSchema = z
  .object({
    schemaVersion: z.literal(RENDER_RESULT_SCHEMA_VERSION),
    jobId: IdSchema,
    renderId: IdSchema,
    projectId: IdSchema,
    projectRevision: z.number().int().nonnegative(),
    manifestSha256: Sha256Schema,
    renderer: z
      .object({
        name: z.literal("praxis-ffmpeg"),
        version: z.string().min(1).max(120),
      })
      .strict(),
    completedAt: z.string().datetime({ offset: true }),
    video: RenderResultObjectBaseSchema.extend({
      mimeType: z.literal("video/mp4"),
      container: z.literal("mp4"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      durationMs: z.number().int().positive(),
      fps: z.number().positive().finite().max(120),
      videoCodec: z.literal("h264"),
      audioCodec: z.literal("aac"),
      pixelFormat: z.literal("yuv420p"),
    }).strict(),
    poster: RenderResultObjectBaseSchema.extend({
      mimeType: z.literal("image/jpeg"),
      codec: z.literal("mjpeg"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict(),
  })
  .strict();
export type RenderResultPayload = z.infer<typeof RenderResultPayloadSchema>;

const RenderResultKeyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);

export const UnsignedRenderResultEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(RENDER_RESULT_SCHEMA_VERSION),
    algorithm: z.literal(RENDER_RESULT_SIGNATURE_ALGORITHM),
    keyId: RenderResultKeyIdSchema,
    payload: RenderResultPayloadSchema,
  })
  .strict();
export type UnsignedRenderResultEnvelope = z.infer<typeof UnsignedRenderResultEnvelopeSchema>;

export const SignedRenderResultEnvelopeSchema = UnsignedRenderResultEnvelopeSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type SignedRenderResultEnvelope = z.infer<typeof SignedRenderResultEnvelopeSchema>;

export function renderResultObjectKey(input: Pick<RenderResultPayload, "projectId" | "projectRevision" | "renderId">): string {
  const identity = RenderResultPayloadSchema.pick({
    projectId: true,
    projectRevision: true,
    renderId: true,
  }).parse({
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    renderId: input.renderId,
  });
  return `projects/${identity.projectId}/render-results/${identity.projectRevision}/${identity.renderId}.json`;
}

export function renderResultSigningInput(input: {
  keyId: string;
  payload: RenderResultPayload;
}): string {
  const envelope = UnsignedRenderResultEnvelopeSchema.parse({
    schemaVersion: RENDER_RESULT_SCHEMA_VERSION,
    algorithm: RENDER_RESULT_SIGNATURE_ALGORITHM,
    keyId: input.keyId,
    payload: input.payload,
  });
  return `${RENDER_RESULT_SIGNING_DOMAIN}\n${canonicalSerialize(envelope)}`;
}

export type RenderPreflightIssueCode =
  | "REVISION_MISMATCH"
  | "UNSUPPORTED_DELIVERY"
  | "UNSUPPORTED_CLIP"
  | "UNSUPPORTED_TRANSITION"
  | "MISSING_ASSET"
  | "ASSET_MISMATCH"
  | "MEDIA_NOT_READY"
  | "STALE_MEDIA";

export interface RenderPreflightIssue {
  code: RenderPreflightIssueCode;
  message: string;
  entityId?: string;
}

export class RenderManifestCompileError extends Error {
  readonly issues: RenderPreflightIssue[];

  constructor(issues: RenderPreflightIssue[]) {
    super(issues.map((issue) => `${issue.code}: ${issue.message}`).join("\n"));
    this.name = "RenderManifestCompileError";
    this.issues = issues;
  }
}

export interface CompileRenderManifestInput {
  project: ProductionProject;
  expectedRevision: number;
  renderId: string;
  kind: "preview" | "final";
  rendererVersion: string;
  assetRecords: TrustedAssetMetadata[];
  backgroundColor?: string;
}

export interface CompiledRenderManifest {
  manifest: RenderManifest;
  canonicalJson: string;
  sha256: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalValue(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) result[key] = canonicalValue(record[key]);
    }
    return result;
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseTransition(
  value: string | undefined,
  direction: "in" | "out",
  clip: TimelineClip,
  issues: RenderPreflightIssue[],
): RenderTransition | undefined {
  if (!value) return undefined;
  const match = /^(fade|dissolve|fade-to-black)-(\d+)f$/.exec(value);
  if (!match) {
    issues.push({
      code: "UNSUPPORTED_TRANSITION",
      message: `Transition ${value} is outside the bounded renderer vocabulary`,
      entityId: clip.meta.id,
    });
    return undefined;
  }
  const type = match[1] as RenderTransition["type"];
  const durationFrames = Number(match[2]);
  const invalidDirection = (type === "dissolve" && direction !== "in") ||
    (type === "fade-to-black" && direction !== "out");
  if (invalidDirection || durationFrames < 1 || durationFrames > 120 || durationFrames > clip.durationFrames) {
    issues.push({
      code: "UNSUPPORTED_TRANSITION",
      message: `Transition ${value} is invalid for transition${direction === "in" ? "In" : "Out"}`,
      entityId: clip.meta.id,
    });
    return undefined;
  }
  return { type, durationFrames };
}

const isRejectedStatus = (status: string): boolean =>
  status === "stale" || status === "failed" || status === "rejected";

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const audioMimeTypes = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
]);

export async function compileRenderManifest(
  input: CompileRenderManifestInput,
): Promise<CompiledRenderManifest> {
  const project = ProductionProjectSchema.parse(input.project);
  const records = input.assetRecords.map((record) => TrustedAssetMetadataSchema.parse(record));
  const issues: RenderPreflightIssue[] = [];

  if (project.revision !== input.expectedRevision) {
    issues.push({
      code: "REVISION_MISMATCH",
      message: `Requested revision ${input.expectedRevision}, but the snapshot is revision ${project.revision}`,
      entityId: project.projectId,
    });
  }
  if (
    project.delivery.container !== "mp4" ||
    project.delivery.videoCodec !== "h264" ||
    project.delivery.audioCodec !== "aac"
  ) {
    issues.push({
      code: "UNSUPPORTED_DELIVERY",
      message: "The first renderer supports only H.264/AAC MP4 delivery",
      entityId: project.projectId,
    });
  }

  const recordsByVersion = new Map(records.map((record) => [record.assetVersionId, record]));
  if (recordsByVersion.size !== records.length) {
    issues.push({ code: "ASSET_MISMATCH", message: "Trusted asset records contain duplicate version IDs" });
  }
  const usedRecords = new Map<string, TrustedAssetMetadata>();
  const clips: RenderClip[] = [];
  const audio: RenderAudioClip[] = [];

  const hasSolo = project.timeline.tracks.some((track) => track.solo);
  const activeTracks = project.timeline.tracks
    .filter((track) => !track.muted && (!hasSolo || track.solo))
    .slice()
    .sort((left, right) => left.order - right.order || left.meta.id.localeCompare(right.meta.id));

  const resolveAsset = (clip: TimelineClip, expected: "image" | "audio"): TrustedAssetMetadata | undefined => {
    if (!clip.assetId || !clip.assetVersionId) {
      issues.push({
        code: "MISSING_ASSET",
        message: `${clip.kind} clip requires an explicit pinned asset version`,
        entityId: clip.meta.id,
      });
      return undefined;
    }
    const asset = project.assets[clip.assetId];
    const version = asset?.versions.find((candidate) => candidate.id === clip.assetVersionId);
    const record = recordsByVersion.get(clip.assetVersionId);
    if (!asset || !version || !record) {
      issues.push({
        code: "MISSING_ASSET",
        message: `No canonical version and trusted object metadata exist for ${clip.assetVersionId}`,
        entityId: clip.meta.id,
      });
      return undefined;
    }
    const mirroredMetadataMatches =
      (version.objectKey === undefined || version.objectKey === record.objectKey) &&
      (version.sha256 === undefined || version.sha256 === record.sha256) &&
      (version.byteLength === undefined || version.byteLength === record.byteLength) &&
      (version.width === undefined || version.width === record.width) &&
      (version.height === undefined || version.height === record.height) &&
      (version.durationMs === undefined || version.durationMs === record.durationMs);
    const recordKindMatches = record.kind === undefined ||
      (expected === "image" ? record.kind === "image" : record.kind === "audio" || record.kind === "music");
    if (
      record.assetId !== clip.assetId ||
      (record.projectId !== undefined && record.projectId !== project.projectId) ||
      !recordKindMatches ||
      !mirroredMetadataMatches
    ) {
      issues.push({
        code: "ASSET_MISMATCH",
        message: `Trusted metadata does not match canonical asset ${clip.assetVersionId}`,
        entityId: clip.meta.id,
      });
      return undefined;
    }
    if (isRejectedStatus(asset.meta.status) || version.status === "stale") {
      issues.push({
        code: "STALE_MEDIA",
        message: `Asset ${clip.assetVersionId} is stale or rejected`,
        entityId: clip.meta.id,
      });
      return undefined;
    }
    if (version.status !== "ready" && version.status !== "approved") {
      issues.push({
        code: "MEDIA_NOT_READY",
        message: `Asset ${clip.assetVersionId} is not ready`,
        entityId: clip.meta.id,
      });
      return undefined;
    }
    const acceptedMime = expected === "image" ? imageMimeTypes : audioMimeTypes;
    if (!acceptedMime.has(record.mimeType)) {
      issues.push({
        code: "UNSUPPORTED_CLIP",
        message: `${record.mimeType} is not supported for ${expected} media`,
        entityId: clip.meta.id,
      });
      return undefined;
    }
    usedRecords.set(record.assetVersionId, record);
    return record;
  };

  for (const track of activeTracks) {
    const trackClips = track.clips
      .slice()
      .sort((left, right) => left.startFrame - right.startFrame || left.meta.id.localeCompare(right.meta.id));
    for (const clip of trackClips) {
      if (isRejectedStatus(clip.meta.status)) {
        issues.push({
          code: "STALE_MEDIA",
          message: `Clip ${clip.meta.id} is stale or rejected`,
          entityId: clip.meta.id,
        });
        continue;
      }
      const transitionIn = parseTransition(clip.transitionIn, "in", clip, issues);
      const transitionOut = parseTransition(clip.transitionOut, "out", clip, issues);

      if (
        ["scene", "image", "text"].includes(clip.kind) &&
        (clip.transform.x !== 0 ||
          clip.transform.y !== 0 ||
          clip.transform.scale !== 1 ||
          clip.transform.rotation !== 0)
      ) {
        issues.push({
          code: "UNSUPPORTED_CLIP",
          message: "The first renderer supports only full-canvas visual clips and centered text overlays",
          entityId: clip.meta.id,
        });
        continue;
      }

      if (clip.kind === "scene" || clip.kind === "image") {
        if (clip.sourceStartFrame !== 0) {
          issues.push({
            code: "UNSUPPORTED_CLIP",
            message: "Still-image clips must start at source frame zero",
            entityId: clip.meta.id,
          });
          continue;
        }
        if (clip.sceneId) {
          const scene = project.scenes.find((candidate) => candidate.meta.id === clip.sceneId);
          if (scene && isRejectedStatus(scene.meta.status)) {
            issues.push({
              code: "STALE_MEDIA",
              message: `Scene ${scene.meta.id} is stale or rejected`,
              entityId: clip.meta.id,
            });
            continue;
          }
        }
        const asset = resolveAsset(clip, "image");
        if (!asset) continue;
        clips.push({
          type: "still",
          clipId: clip.meta.id,
          trackId: track.meta.id,
          zIndex: track.order,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          sourceStartFrame: clip.sourceStartFrame,
          assetVersionId: asset.assetVersionId,
          opacity: clip.opacity,
          transform: clip.transform,
          ...(transitionIn ? { transitionIn } : {}),
          ...(transitionOut ? { transitionOut } : {}),
        });
        continue;
      }

      if (clip.kind === "text") {
        if (transitionIn?.type === "dissolve" || transitionOut?.type === "dissolve") {
          issues.push({
            code: "UNSUPPORTED_TRANSITION",
            message: "Text overlays support fades, not dissolves",
            entityId: clip.meta.id,
          });
          continue;
        }
        if (!clip.text || !clip.textStyle) {
          issues.push({
            code: "UNSUPPORTED_CLIP",
            message: "Text clips require canonical text and textStyle payloads",
            entityId: clip.meta.id,
          });
          continue;
        }
        if (clip.textStyle.lineHeight !== 1) {
          issues.push({
            code: "UNSUPPORTED_CLIP",
            message: "The first text renderer supports lineHeight 1 only",
            entityId: clip.meta.id,
          });
          continue;
        }
        clips.push({
          type: "text",
          clipId: clip.meta.id,
          trackId: track.meta.id,
          zIndex: track.order,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          text: clip.text,
          opacity: clip.opacity,
          transform: clip.transform,
          style: clip.textStyle,
          ...(transitionIn ? { transitionIn } : {}),
          ...(transitionOut ? { transitionOut } : {}),
        });
        continue;
      }

      if (clip.kind === "audio" || clip.kind === "music") {
        const asset = resolveAsset(clip, "audio");
        if (!asset) continue;
        const requiredEndMs = ((clip.sourceStartFrame + clip.durationFrames) / project.timeline.fps) * 1_000;
        if (asset.durationMs !== undefined && asset.durationMs + 1_000 / project.timeline.fps < requiredEndMs) {
          issues.push({
            code: "ASSET_MISMATCH",
            message: `Audio source ${asset.assetVersionId} is shorter than the requested source range`,
            entityId: clip.meta.id,
          });
          continue;
        }
        const invalidTransition = [transitionIn, transitionOut].some(
          (transition) => transition && transition.type !== "fade",
        );
        if (invalidTransition) {
          issues.push({
            code: "UNSUPPORTED_TRANSITION",
            message: "Audio clips support only fade transitions",
            entityId: clip.meta.id,
          });
          continue;
        }
        audio.push({
          type: clip.kind === "music" ? "music" : track.name.toLowerCase().includes("narration") ? "narration" : "audio",
          clipId: clip.meta.id,
          trackId: track.meta.id,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          sourceStartFrame: clip.sourceStartFrame,
          assetVersionId: asset.assetVersionId,
          gainDb: clip.gainDb ?? 0,
          fadeInFrames: transitionIn?.durationFrames ?? 0,
          fadeOutFrames: transitionOut?.durationFrames ?? 0,
        });
        continue;
      }

      issues.push({
        code: "UNSUPPORTED_CLIP",
        message: `Clip kind ${clip.kind} is outside the first renderer subset`,
        entityId: clip.meta.id,
      });
    }
  }

  if (issues.length > 0) throw new RenderManifestCompileError(issues);

  const projectSnapshotHash = await sha256Hex(canonicalSerialize(project));
  const manifest = RenderManifestSchema.parse({
    schemaVersion: RENDER_MANIFEST_SCHEMA_VERSION,
    compilerVersion: RENDER_MANIFEST_COMPILER_VERSION,
    renderId: input.renderId,
    projectId: project.projectId,
    projectRevision: project.revision,
    projectSnapshotHash,
    renderer: { name: "praxis-ffmpeg", version: input.rendererVersion },
    canvas: {
      width: project.delivery.width,
      height: project.delivery.height,
      fps: project.delivery.fps,
      durationFrames: project.timeline.durationFrames,
      backgroundColor: input.backgroundColor ?? project.style.palette[1] ?? "#000000",
    },
    assets: Array.from(usedRecords.values())
      .sort((left, right) => left.assetVersionId.localeCompare(right.assetVersionId))
      .map((record) => ({
        assetId: record.assetId,
        assetVersionId: record.assetVersionId,
        objectKey: record.objectKey,
        sha256: record.sha256,
        mimeType: record.mimeType,
        byteLength: record.byteLength,
        ...(record.width !== undefined ? { width: record.width } : {}),
        ...(record.height !== undefined ? { height: record.height } : {}),
        ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      })),
    clips: clips.sort((left, right) =>
      left.zIndex - right.zIndex || left.startFrame - right.startFrame || left.clipId.localeCompare(right.clipId),
    ),
    audio: audio.sort((left, right) =>
      left.startFrame - right.startFrame || left.trackId.localeCompare(right.trackId) || left.clipId.localeCompare(right.clipId),
    ),
    output: {
      kind: input.kind,
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      pixelFormat: "yuv420p",
    },
  });
  const canonicalJson = canonicalSerialize(manifest);
  return { manifest, canonicalJson, sha256: await sha256Hex(canonicalJson) };
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  ObjectKeySchema,
  RenderManifestSchema,
  RenderResultPayloadSchema,
  canonicalSerialize,
  renderResultObjectKey,
  sha256Hex,
  type RenderAsset,
  type RenderClip,
  type RenderManifest,
  type RenderResultPayload,
} from "@praxis/render-manifest";
import { z } from "zod";
import type { RenderWorkerConfig } from "./config";
import { createSignedRenderResult } from "./auth";
import { hashFile, LocalObjectStore } from "./object-store";
import { ProcessExecutionError, runProcess } from "./process";

const IdSchema = z.string().min(3).max(128).regex(/^[A-Za-z][A-Za-z0-9:_-]*$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const ShortLivedUrlSchema = z.string().url().max(4_096).superRefine((value, context) => {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "host.docker.internal";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Access URLs require HTTPS or loopback HTTP" });
  }
  if (url.username || url.password || url.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Access URLs cannot contain userinfo or fragments" });
  }
});

export const AssetAccessSchema = z
  .object({
    assetVersionId: IdSchema,
    getUrl: ShortLivedUrlSchema,
  })
  .strict();
export type AssetAccess = z.infer<typeof AssetAccessSchema>;

export const OutputDestinationSchema = z
  .object({
    objectKey: ObjectKeySchema,
    putUrl: ShortLivedUrlSchema,
    existingObjectGetUrl: ShortLivedUrlSchema.optional(),
  })
  .strict();
export type OutputDestination = z.infer<typeof OutputDestinationSchema>;

export const RenderRequestSchema = z
  .object({
    jobId: IdSchema,
    manifestSha256: Sha256Schema,
    manifest: RenderManifestSchema,
    assetAccess: z.array(AssetAccessSchema).max(2_000).optional(),
    outputDestinations: z
      .object({
        video: OutputDestinationSchema,
        poster: OutputDestinationSchema,
        result: OutputDestinationSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.assetAccess !== undefined) {
      const requiredIds = new Set(request.manifest.assets.map((asset) => asset.assetVersionId));
      const suppliedIds = new Set<string>();
      for (const [index, accessEntry] of request.assetAccess.entries()) {
        if (suppliedIds.has(accessEntry.assetVersionId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["assetAccess", index, "assetVersionId"],
            message: "Asset access entries must be unique",
          });
        }
        suppliedIds.add(accessEntry.assetVersionId);
        if (!requiredIds.has(accessEntry.assetVersionId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["assetAccess", index, "assetVersionId"],
            message: "Asset access cannot reference an asset outside the manifest",
          });
        }
      }
      for (const assetVersionId of requiredIds) {
        if (!suppliedIds.has(assetVersionId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["assetAccess"],
            message: `Asset access is missing ${assetVersionId}`,
          });
        }
      }
    }
    if (request.outputDestinations) {
      const base = `projects/${request.manifest.projectId}/renders/${request.manifest.projectRevision}/${request.manifest.renderId}`;
      if (request.outputDestinations.video.objectKey !== `${base}.mp4`) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputDestinations", "video", "objectKey"],
          message: "Video destination must use the manifest's immutable revision-scoped key",
        });
      }
      if (request.outputDestinations.poster.objectKey !== `${base}.jpg`) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputDestinations", "poster", "objectKey"],
          message: "Poster destination must use the manifest's immutable revision-scoped key",
        });
      }
      const resultObjectKey = renderResultObjectKey(request.manifest);
      if (request.outputDestinations.result.objectKey !== resultObjectKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputDestinations", "result", "objectKey"],
          message: "Result destination must use the manifest's immutable revision-scoped key",
        });
      }
      if (new Set([
        request.outputDestinations.video.putUrl,
        request.outputDestinations.poster.putUrl,
        request.outputDestinations.result.putUrl,
      ]).size !== 3) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputDestinations"],
          message: "Video, poster, and result require distinct PUT destinations",
        });
      }
    }
  });
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const RenderResultSchema = RenderResultPayloadSchema;
export type RenderResult = RenderResultPayload;

export interface RenderExecutor {
  execute(request: RenderRequest, signal: AbortSignal): Promise<RenderResult>;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; size?: string; format_name?: string };
}

const seconds = (frames: number, fps: number): string => (frames / fps).toFixed(6);
const milliseconds = (frames: number, fps: number): number => Math.round((frames / fps) * 1_000);

const extensionForMime = (mimeType: string): string => {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "audio/wav":
    case "audio/x-wav": return "wav";
    case "audio/mpeg": return "mp3";
    case "audio/mp4": return "m4a";
    case "audio/aac": return "aac";
    default: throw new Error(`Unsupported asset MIME type: ${mimeType}`);
  }
};

const assertFilterPath = (value: string): string => {
  if (!/^[A-Za-z0-9_./-]+$/.test(value)) {
    throw new Error("FFmpeg filter paths may contain only safe generated path characters");
  }
  return value;
};

const assColor = (value: string, opacity: number): string => {
  const rgb = value.slice(1, 7);
  const embeddedAlpha = value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1;
  const alpha = Math.round((1 - embeddedAlpha * opacity) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  const red = rgb.slice(0, 2);
  const green = rgb.slice(2, 4);
  const blue = rgb.slice(4, 6);
  return `&H${alpha}${blue}${green}${red}`;
};

const escapeAssText = (value: string): string => value
  .replaceAll("\\", "\\\\")
  .replaceAll("{", "\\{")
  .replaceAll("}", "\\}")
  .replace(/\r\n|\r|\n/g, "\\N");

type RenderTextClip = Extract<RenderClip, { type: "text" }>;

export function buildAssSubtitle(
  clip: RenderTextClip,
  manifest: RenderManifest,
  resolvedFontFamily = clip.style.fontFamily,
): string {
  if (!/^[A-Za-z0-9 ._-]+$/.test(resolvedFontFamily)) {
    throw new Error("Resolved ASS font family contains unsupported characters");
  }
  const primaryColor = assColor(clip.style.color, clip.opacity);
  const backgroundColor = clip.style.backgroundColor
    ? assColor(clip.style.backgroundColor, clip.opacity)
    : "&HFF000000";
  const alignment = clip.style.textAlign === "left" ? 4 : clip.style.textAlign === "right" ? 6 : 5;
  const borderStyle = clip.style.backgroundColor ? 3 : 1;
  const bold = clip.style.fontWeight >= 600 ? -1 : 0;
  const italic = clip.style.fontStyle === "italic" ? -1 : 0;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${manifest.canvas.width}`,
    `PlayResY: ${manifest.canvas.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, " +
      "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, " +
      "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Praxis,${resolvedFontFamily},${clip.style.fontSizePx},${primaryColor},${primaryColor},` +
      `${backgroundColor},${backgroundColor},${bold},${italic},0,0,100,100,${clip.style.letterSpacingPx},` +
      `0,${borderStyle},0,0,${alignment},80,80,0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,0:00:00.00,9:59:59.99,Praxis,,0,0,0,,${escapeAssText(clip.text)}`,
    "",
  ].join("\n");
}

const fadeFilters = (
  clip: RenderClip,
  fps: number,
  effectiveDurationFrames: number,
): string[] => {
  const filters: string[] = [];
  if (clip.transitionIn?.type === "fade" || clip.transitionIn?.type === "dissolve") {
    filters.push(`fade=t=in:st=0:d=${seconds(clip.transitionIn.durationFrames, fps)}:alpha=1`);
  }
  if (clip.transitionOut?.type === "fade" || clip.transitionOut?.type === "fade-to-black") {
    const start = Math.max(0, effectiveDurationFrames - clip.transitionOut.durationFrames);
    filters.push(
      `fade=t=out:st=${seconds(start, fps)}:d=${seconds(clip.transitionOut.durationFrames, fps)}:alpha=1`,
    );
  }
  return filters;
};

export interface FfmpegPlanInput {
  manifest: RenderManifest;
  assetPaths: ReadonlyMap<string, string>;
  subtitleFilePaths: ReadonlyMap<string, string>;
  fontPath: string;
  outputPath: string;
}

export interface FfmpegPlan {
  args: string[];
  filterGraph: string;
}

export function buildFfmpegPlan(input: FfmpegPlanInput): FfmpegPlan {
  const { manifest } = input;
  const { fps, width, height, durationFrames } = manifest.canvas;
  const duration = seconds(durationFrames, fps);
  const args: string[] = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi",
    "-i", `color=c=${manifest.canvas.backgroundColor.replace("#", "0x")}:s=${width}x${height}:r=${fps}:d=${duration}`,
  ];
  const inputIndexes = new Map<string, number>();
  let inputIndex = 1;

  for (const clip of manifest.clips) {
    if (clip.type !== "still") continue;
    const assetPath = input.assetPaths.get(clip.assetVersionId);
    if (!assetPath) throw new Error(`No staged asset exists for ${clip.assetVersionId}`);
    args.push("-loop", "1", "-framerate", String(fps), "-i", assetPath);
    inputIndexes.set(`visual:${clip.clipId}`, inputIndex++);
  }
  for (const clip of manifest.audio) {
    const assetPath = input.assetPaths.get(clip.assetVersionId);
    if (!assetPath) throw new Error(`No staged asset exists for ${clip.assetVersionId}`);
    args.push("-i", assetPath);
    inputIndexes.set(`audio:${clip.clipId}`, inputIndex++);
  }

  const filters: string[] = ["[0:v]format=rgba[v0]"];
  let visualLabel = "v0";
  const visualClips = manifest.clips
    .slice()
    .sort((left, right) => left.zIndex - right.zIndex || left.startFrame - right.startFrame || left.clipId.localeCompare(right.clipId));

  for (const [index, clip] of visualClips.entries()) {
    const layer = `layer${index}`;
    let effectiveDurationFrames = clip.durationFrames;
    if (clip.type === "still") {
      const next = visualClips.find((candidate) =>
        candidate.type === "still" &&
        candidate.trackId === clip.trackId &&
        candidate.startFrame === clip.startFrame + clip.durationFrames &&
        candidate.transitionIn?.type === "dissolve",
      );
      if (next?.transitionIn) effectiveDurationFrames += next.transitionIn.durationFrames;
      const sourceIndex = inputIndexes.get(`visual:${clip.clipId}`);
      if (sourceIndex === undefined) throw new Error(`No FFmpeg input exists for ${clip.clipId}`);
      const chain = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        "setsar=1",
        "format=rgba",
        `trim=duration=${seconds(effectiveDurationFrames, fps)}`,
        "setpts=PTS-STARTPTS",
        `colorchannelmixer=aa=${clip.opacity.toFixed(6)}`,
        ...fadeFilters(clip, fps, effectiveDurationFrames),
        `setpts=PTS+${seconds(clip.startFrame, fps)}/TB`,
      ];
      filters.push(`[${sourceIndex}:v]${chain.join(",")}[${layer}]`);
    } else {
      const subtitlePath = assertFilterPath(input.subtitleFilePaths.get(clip.clipId) ?? "");
      const fontPath = assertFilterPath(input.fontPath);
      const fontDirectory = assertFilterPath(path.dirname(fontPath));
      const chain = [
        `color=c=black@0.0:s=${width}x${height}:r=${fps}:d=${seconds(clip.durationFrames, fps)}`,
        "format=rgba",
        `ass=filename='${subtitlePath}':fontsdir='${fontDirectory}':alpha=1`,
        ...fadeFilters(clip, fps, clip.durationFrames),
        `setpts=PTS+${seconds(clip.startFrame, fps)}/TB`,
      ];
      filters.push(`${chain.join(",")}[${layer}]`);
    }
    const nextVisual = `v${index + 1}`;
    const endFrame = clip.startFrame + effectiveDurationFrames;
    filters.push(
      `[${visualLabel}][${layer}]overlay=x=0:y=0:eof_action=pass:shortest=0:enable='between(t,${seconds(clip.startFrame, fps)},${seconds(endFrame, fps)})'[${nextVisual}]`,
    );
    visualLabel = nextVisual;
  }
  filters.push(`[${visualLabel}]format=yuv420p[vout]`);

  const audioLabels: string[] = [];
  for (const [index, clip] of manifest.audio.entries()) {
    const sourceIndex = inputIndexes.get(`audio:${clip.clipId}`);
    if (sourceIndex === undefined) throw new Error(`No FFmpeg input exists for ${clip.clipId}`);
    const chain = [
      `atrim=start=${seconds(clip.sourceStartFrame, fps)}:duration=${seconds(clip.durationFrames, fps)}`,
      "asetpts=PTS-STARTPTS",
      `volume=${clip.gainDb.toFixed(3)}dB`,
    ];
    if (clip.fadeInFrames > 0) {
      chain.push(`afade=t=in:st=0:d=${seconds(clip.fadeInFrames, fps)}`);
    }
    if (clip.fadeOutFrames > 0) {
      chain.push(
        `afade=t=out:st=${seconds(clip.durationFrames - clip.fadeOutFrames, fps)}:d=${seconds(clip.fadeOutFrames, fps)}`,
      );
    }
    const delay = milliseconds(clip.startFrame, fps);
    if (delay > 0) chain.push(`adelay=${delay}:all=1`);
    chain.push(`apad=whole_dur=${duration}`);
    const label = `a${index}`;
    filters.push(`[${sourceIndex}:a]${chain.join(",")}[${label}]`);
    audioLabels.push(`[${label}]`);
  }
  if (audioLabels.length === 0) {
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${duration}[aout]`);
  } else {
    filters.push(
      `${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=duration=${duration},aresample=48000[aout]`,
    );
  }

  const filterGraph = filters.join(";");
  args.push(
    "-filter_complex", filterGraph,
    "-map", "[vout]", "-map", "[aout]",
    "-t", duration,
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", manifest.output.kind === "preview" ? "veryfast" : "medium",
    "-crf", manifest.output.kind === "preview" ? "23" : "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    input.outputPath,
  );
  return { args, filterGraph };
}

const transferSignal = (signal: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  timeoutSignal: AbortSignal;
} => {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return { signal: AbortSignal.any([signal, timeoutSignal]), timeoutSignal };
};

const transferError = (
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  operation: string,
): ProcessExecutionError | Error => {
  if (signal.aborted) {
    return new ProcessExecutionError({ code: "PROCESS_ABORTED", message: `${operation} was cancelled` });
  }
  if (timeoutSignal.aborted) {
    return new ProcessExecutionError({ code: "PROCESS_TIMEOUT", message: `${operation} timed out` });
  }
  return new Error(`${operation} failed`);
};

async function downloadAsset(
  accessEntry: AssetAccess,
  asset: RenderAsset,
  destinationPath: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxAssetBytes: number,
): Promise<void> {
  if (asset.byteLength > maxAssetBytes) throw new Error("Remote asset exceeds the configured input limit");
  const transfer = transferSignal(signal, Math.min(timeoutMs, 60_000));
  let response: Response;
  try {
    response = await fetch(accessEntry.getUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "accept-encoding": "identity" },
      signal: transfer.signal,
    });
  } catch {
    throw transferError(signal, transfer.timeoutSignal, "Asset download");
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Asset download was rejected with HTTP ${response.status}`);
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding !== "identity") {
    await response.body.cancel().catch(() => undefined);
    throw new Error("Asset download cannot use content encoding");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== asset.byteLength || declaredBytes > maxAssetBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error("Asset download Content-Length does not match trusted metadata");
    }
  }

  const handle = await open(destinationPath, "wx", 0o600);
  const reader = response.body.getReader();
  const digest = createHash("sha256");
  let byteLength = 0;
  let complete = false;
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw transferError(signal, transfer.timeoutSignal, "Asset download");
      }
      if (result.done) break;
      const chunk = result.value;
      byteLength += chunk.byteLength;
      if (byteLength > asset.byteLength || byteLength > maxAssetBytes) {
        throw new Error("Asset download exceeded its trusted byte length");
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await handle.write(chunk, offset, chunk.byteLength - offset, null);
        if (written.bytesWritten <= 0) throw new Error("Asset download could not be staged");
        offset += written.bytesWritten;
      }
    }
    if (byteLength !== asset.byteLength) throw new Error("Asset download byte length does not match trusted metadata");
    if (digest.digest("hex") !== asset.sha256) throw new Error("Asset download SHA-256 does not match trusted metadata");
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    await handle.close();
    if (!complete) await rm(destinationPath, { force: true });
  }
}

async function uploadOutput(
  destination: OutputDestination,
  sourcePath: string,
  mimeType: "video/mp4" | "image/jpeg" | "application/json",
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ sha256: string; byteLength: number }> {
  const fileStat = await stat(sourcePath);
  if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > maxOutputBytes) {
    throw new Error("Render artifact exceeds the configured upload limit");
  }
  const hashed = await hashFile(sourcePath);
  const transfer = transferSignal(signal, Math.min(timeoutMs, 60_000));
  const source = createReadStream(sourcePath);
  let response: Response;
  try {
    response = await fetch(destination.putUrl, {
      method: "PUT",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: {
        "content-type": mimeType,
        "content-length": String(hashed.byteLength),
        "if-none-match": "*",
        "x-praxis-sha256": hashed.sha256,
      },
      body: Readable.toWeb(source),
      duplex: "half",
      signal: transfer.signal,
    } as RequestInit & { duplex: "half" });
  } catch {
    source.destroy();
    throw transferError(signal, transfer.timeoutSignal, "Output upload");
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    if ((response.status === 409 || response.status === 412) && destination.existingObjectGetUrl) {
      return verifyExistingOutput(
        destination.existingObjectGetUrl,
        mimeType,
        hashed,
        signal,
        timeoutMs,
        maxOutputBytes,
      );
    }
    throw new Error(`Output upload was rejected with HTTP ${response.status}`);
  }
  return hashed;
}

async function verifyExistingOutput(
  getUrl: string,
  mimeType: "video/mp4" | "image/jpeg" | "application/json",
  expected: { sha256: string; byteLength: number },
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ sha256: string; byteLength: number }> {
  const transfer = transferSignal(signal, Math.min(timeoutMs, 60_000));
  let response: Response;
  try {
    response = await fetch(getUrl, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "accept-encoding": "identity" },
      signal: transfer.signal,
    });
  } catch {
    throw transferError(signal, transfer.timeoutSignal, "Existing output verification");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Existing output verification was rejected with HTTP ${response.status}`);
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding !== "identity") {
    await response.body.cancel().catch(() => undefined);
    throw new Error("Existing output verification cannot use content encoding");
  }
  const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (responseMime !== mimeType) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("Existing output content type differs from the rendered artifact");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength !== expected.byteLength) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("Existing output length differs from the rendered artifact");
  }
  const digest = createHash("sha256");
  const reader = response.body.getReader();
  let byteLength = 0;
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw transferError(signal, transfer.timeoutSignal, "Existing output verification");
    }
    if (chunk.done) break;
    byteLength += chunk.value.byteLength;
    if (byteLength > expected.byteLength || byteLength > maxOutputBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Existing output exceeded the rendered artifact length");
    }
    digest.update(chunk.value);
  }
  if (byteLength !== expected.byteLength || digest.digest("hex") !== expected.sha256) {
    throw new Error("Existing immutable output differs from the rendered artifact");
  }
  return expected;
}

async function sniffMime(filePath: string, expectedMime: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    const ascii = head.toString("ascii");
    const accepted =
      (expectedMime === "image/png" && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
      (expectedMime === "image/jpeg" && head[0] === 0xff && head[1] === 0xd8) ||
      (expectedMime === "image/webp" && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") ||
      ((expectedMime === "audio/wav" || expectedMime === "audio/x-wav") && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") ||
      (expectedMime === "audio/mpeg" && (ascii.startsWith("ID3") || (head[0] === 0xff && (head[1]! & 0xe0) === 0xe0))) ||
      (expectedMime === "audio/mp4" && ascii.slice(4, 8) === "ftyp") ||
      (expectedMime === "audio/aac" && head[0] === 0xff && (head[1]! & 0xf6) === 0xf0);
    if (!accepted) throw new Error(`Media signature does not match ${expectedMime}`);
  } finally {
    await handle.close();
  }
}

const parseRate = (rate: string | undefined): number => {
  if (!rate) return 0;
  const [numerator, denominator = "1"] = rate.split("/");
  return Number(numerator) / Number(denominator);
};

async function probeMedia(
  ffprobePath: string,
  filePath: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ProbeOutput> {
  const result = await runProcess({
    command: ffprobePath,
    args: ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    signal,
    timeoutMs,
  });
  return JSON.parse(result.stdout) as ProbeOutput;
}

function validateSourceProbe(asset: RenderAsset, probe: ProbeOutput): void {
  const expectedKind = asset.mimeType.startsWith("image/") ? "video" : "audio";
  const stream = probe.streams?.find((candidate) => candidate.codec_type === expectedKind);
  if (!stream) throw new Error(`Asset ${asset.assetVersionId} has no ${expectedKind} stream`);
  if (expectedKind === "video") {
    if (asset.width !== undefined && stream.width !== asset.width) throw new Error("Image width differs from trusted metadata");
    if (asset.height !== undefined && stream.height !== asset.height) throw new Error("Image height differs from trusted metadata");
  } else if (asset.durationMs !== undefined) {
    const durationSeconds = Number(stream.duration ?? probe.format?.duration);
    if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds * 1_000 - asset.durationMs) > 100) {
      throw new Error("Audio duration differs from trusted metadata");
    }
  }
}

function validateOutputProbe(manifest: RenderManifest, probe: ProbeOutput): {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
} {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (!video || video.codec_name !== "h264") throw new Error("Rendered output is missing its H.264 video stream");
  if (!audio || audio.codec_name !== "aac") throw new Error("Rendered output is missing its AAC audio stream");
  if (!probe.format?.format_name?.split(",").some((name) => name === "mp4")) {
    throw new Error("Rendered output is not an MP4 container");
  }
  if (video.pix_fmt !== "yuv420p") throw new Error(`Rendered pixel format is ${video.pix_fmt}, not yuv420p`);
  if (video.width !== manifest.canvas.width || video.height !== manifest.canvas.height) {
    throw new Error("Rendered dimensions differ from the manifest canvas");
  }
  const actualFps = parseRate(video.avg_frame_rate ?? video.r_frame_rate);
  if (Math.abs(actualFps - manifest.canvas.fps) > 0.001) throw new Error("Rendered frame rate differs from the manifest");
  const durationSeconds = Number(probe.format?.duration ?? video.duration);
  const expectedSeconds = manifest.canvas.durationFrames / manifest.canvas.fps;
  if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - expectedSeconds) > 1 / manifest.canvas.fps + 0.01) {
    throw new Error("Rendered duration differs from the manifest by more than one frame");
  }
  return {
    durationMs: Math.round(durationSeconds * 1_000),
    width: video.width,
    height: video.height,
    fps: actualFps,
  };
}

function preflightWorker(manifest: RenderManifest, config: RenderWorkerConfig): void {
  if (manifest.renderer.version !== config.rendererVersion) {
    throw new Error(`Renderer version ${manifest.renderer.version} is not available in this worker`);
  }
  if (manifest.canvas.width > 3_840 || manifest.canvas.height > 2_160 || manifest.canvas.fps > 60) {
    throw new Error("Manifest canvas exceeds the worker's bounded 4K/60fps limit");
  }
  if (manifest.canvas.durationFrames / manifest.canvas.fps > 600) {
    throw new Error("Manifest duration exceeds the worker's ten-minute limit");
  }
  const totalBytes = manifest.assets.reduce((sum, asset) => sum + asset.byteLength, 0);
  if (totalBytes > config.maxTotalAssetBytes) throw new Error("Manifest assets exceed the total input byte limit");
  for (const clip of manifest.clips) {
    if (clip.transform.x !== 0 || clip.transform.y !== 0 || clip.transform.scale !== 1 || clip.transform.rotation !== 0) {
      throw new Error(`Clip ${clip.clipId} uses transforms outside the first render-worker subset`);
    }
    if (clip.type === "text") {
      if (clip.style.lineHeight !== 1) {
        throw new Error(`Text clip ${clip.clipId} uses unsupported lineHeight ${clip.style.lineHeight}`);
      }
      if (
        clip.style.fontFamily !== config.fontFamily ||
        clip.style.fontWeight !== config.fontWeight ||
        clip.style.fontStyle !== config.fontStyle
      ) {
        throw new Error(
          `Text clip ${clip.clipId} requires ${clip.style.fontFamily} ${clip.style.fontWeight} ${clip.style.fontStyle}, ` +
          `but this renderer image provides ${config.fontFamily} ${config.fontWeight} ${config.fontStyle}`,
        );
      }
    }
  }
  const visualByTrack = new Map<string, RenderClip[]>();
  for (const clip of manifest.clips) {
    const list = visualByTrack.get(clip.trackId) ?? [];
    list.push(clip);
    visualByTrack.set(clip.trackId, list);
  }
  for (const clips of visualByTrack.values()) {
    clips.sort((left, right) => left.startFrame - right.startFrame);
    for (const [index, clip] of clips.entries()) {
      if (clip.transitionIn?.type === "dissolve") {
        const previous = clips[index - 1];
        if (!previous || previous.type !== "still" || clip.type !== "still" || previous.startFrame + previous.durationFrames !== clip.startFrame) {
          throw new Error(`Dissolve on ${clip.clipId} requires an adjacent still-image predecessor`);
        }
      }
    }
  }
}

export class FfmpegRenderExecutor implements RenderExecutor {
  readonly config: RenderWorkerConfig;
  readonly objectStore: LocalObjectStore;

  constructor(config: RenderWorkerConfig, objectStore = new LocalObjectStore(config.objectStoreRoot)) {
    this.config = config;
    this.objectStore = objectStore;
  }

  async execute(rawRequest: RenderRequest, signal: AbortSignal): Promise<RenderResult> {
    const request = RenderRequestSchema.parse(rawRequest);
    const manifest = request.manifest;
    const manifestHash = await sha256Hex(canonicalSerialize(manifest));
    if (manifestHash !== request.manifestSha256) throw new Error("Manifest SHA-256 does not match its canonical JSON");
    preflightWorker(manifest, this.config);
    if (manifest.clips.some((clip) => clip.type === "text")) await access(this.config.fontPath);

    await mkdir(this.config.tempRoot, { recursive: true });
    const jobDirectory = await mkdtemp(path.join(this.config.tempRoot, `praxis-${request.jobId}-`));

    try {
      const assetsDirectory = path.join(jobDirectory, "assets");
      const textDirectory = path.join(jobDirectory, "text");
      await Promise.all([mkdir(assetsDirectory), mkdir(textDirectory)]);
      const outputPath = path.join(jobDirectory, "render.mp4");
      const posterPath = path.join(jobDirectory, "poster.jpg");

      const assetPaths = new Map<string, string>();
      const accessByVersion = request.assetAccess === undefined
        ? undefined
        : new Map(request.assetAccess.map((entry) => [entry.assetVersionId, entry]));
      for (const asset of manifest.assets) {
        if (signal.aborted) throw new ProcessExecutionError({ code: "PROCESS_ABORTED", message: "Render cancelled" });
        const stagedPath = path.join(assetsDirectory, `${asset.assetVersionId}.${extensionForMime(asset.mimeType)}`);
        if (accessByVersion) {
          const accessEntry = accessByVersion.get(asset.assetVersionId);
          if (!accessEntry) throw new Error(`Missing remote access for ${asset.assetVersionId}`);
          await downloadAsset(
            accessEntry,
            asset,
            stagedPath,
            signal,
            this.config.timeoutMs,
            this.config.maxAssetBytes,
          );
        } else {
          const verified = await this.objectStore.readVerified(
            asset.objectKey,
            asset.sha256,
            asset.byteLength,
            this.config.maxAssetBytes,
          );
          await copyFile(verified.path, stagedPath);
        }
        await sniffMime(stagedPath, asset.mimeType);
        const probe = await probeMedia(this.config.ffprobePath, stagedPath, signal, Math.min(this.config.timeoutMs, 30_000));
        validateSourceProbe(asset, probe);
        assetPaths.set(asset.assetVersionId, stagedPath);
      }

      const subtitleFilePaths = new Map<string, string>();
      for (const clip of manifest.clips) {
        if (clip.type !== "text") continue;
        const subtitlePath = path.join(textDirectory, `${clip.clipId}.ass`);
        await writeFile(subtitlePath, buildAssSubtitle(clip, manifest, this.config.assFontFamily), {
          encoding: "utf8",
          mode: 0o600,
        });
        subtitleFilePaths.set(clip.clipId, subtitlePath);
      }

      const plan = buildFfmpegPlan({
        manifest,
        assetPaths,
        subtitleFilePaths,
        fontPath: this.config.fontPath,
        outputPath,
      });
      await runProcess({
        command: this.config.ffmpegPath,
        args: plan.args,
        signal,
        timeoutMs: this.config.timeoutMs,
      });
      const outputProbe = await probeMedia(this.config.ffprobePath, outputPath, signal, 30_000);
      const videoMetadata = validateOutputProbe(manifest, outputProbe);

      const posterFrame = Math.min(
        manifest.canvas.durationFrames - 1,
        Math.max(0, Math.round(manifest.canvas.durationFrames / 2)),
      );
      await runProcess({
        command: this.config.ffmpegPath,
        args: [
          "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
          "-ss", seconds(posterFrame, manifest.canvas.fps),
          "-i", outputPath,
          "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "2",
          posterPath,
        ],
        signal,
        timeoutMs: 30_000,
      });
      const posterProbe = await probeMedia(this.config.ffprobePath, posterPath, signal, 30_000);
      const posterStream = posterProbe.streams?.find((stream) => stream.codec_type === "video");
      if (!posterStream?.width || !posterStream.height || posterStream.codec_name !== "mjpeg") {
        throw new Error("Poster image could not be validated as JPEG");
      }

      const videoObjectKey = `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.mp4`;
      const posterObjectKey = `projects/${manifest.projectId}/renders/${manifest.projectRevision}/${manifest.renderId}.jpg`;
      const resultObjectKey = renderResultObjectKey(manifest);
      let videoObject: { objectKey: string; sha256: string; byteLength: number };
      let posterObject: { objectKey: string; sha256: string; byteLength: number };
      if (request.outputDestinations) {
        const videoHash = await uploadOutput(
          request.outputDestinations.video,
          outputPath,
          "video/mp4",
          signal,
          this.config.timeoutMs,
          this.config.maxOutputBytes,
        );
        const posterHash = await uploadOutput(
          request.outputDestinations.poster,
          posterPath,
          "image/jpeg",
          signal,
          this.config.timeoutMs,
          this.config.maxOutputBytes,
        );
        videoObject = { objectKey: request.outputDestinations.video.objectKey, ...videoHash };
        posterObject = { objectKey: request.outputDestinations.poster.objectKey, ...posterHash };
      } else {
        [videoObject, posterObject] = await Promise.all([
          this.objectStore.putImmutable(videoObjectKey, outputPath),
          this.objectStore.putImmutable(posterObjectKey, posterPath),
        ]);
      }
      const result = RenderResultSchema.parse({
        schemaVersion: "1",
        jobId: request.jobId,
        renderId: manifest.renderId,
        projectId: manifest.projectId,
        projectRevision: manifest.projectRevision,
        manifestSha256: request.manifestSha256,
        renderer: manifest.renderer,
        completedAt: new Date().toISOString(),
        video: {
          objectKey: videoObject.objectKey,
          sha256: videoObject.sha256,
          byteLength: videoObject.byteLength,
          mimeType: "video/mp4",
          container: "mp4",
          ...videoMetadata,
          videoCodec: "h264" as const,
          audioCodec: "aac" as const,
          pixelFormat: "yuv420p" as const,
        },
        poster: {
          objectKey: posterObject.objectKey,
          sha256: posterObject.sha256,
          byteLength: posterObject.byteLength,
          mimeType: "image/jpeg",
          codec: "mjpeg",
          width: posterStream.width,
          height: posterStream.height,
        },
      });
      const envelope = createSignedRenderResult(
        this.config.resultSigningSecret,
        this.config.resultSigningKeyId,
        result,
      );
      const resultPath = path.join(jobDirectory, "render-result.json");
      await writeFile(resultPath, canonicalSerialize(envelope), { encoding: "utf8", mode: 0o600 });
      if (request.outputDestinations) {
        await uploadOutput(
          request.outputDestinations.result,
          resultPath,
          "application/json",
          signal,
          this.config.timeoutMs,
          65_536,
        );
      } else {
        await this.objectStore.putImmutable(resultObjectKey, resultPath);
      }
      return result;
    } finally {
      await rm(jobDirectory, { recursive: true, force: true });
    }
  }
}

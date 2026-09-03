import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

export interface RenderWorkerConfig {
  port: number;
  authSecret: string;
  resultSigningSecret: string;
  resultSigningKeyId: string;
  allowStaticAuth: boolean;
  staticAuthToken?: string;
  tokenMaxTtlSeconds: number;
  objectStoreRoot: string;
  tempRoot: string;
  timeoutMs: number;
  maxRequestBytes: number;
  maxAssetBytes: number;
  maxTotalAssetBytes: number;
  maxOutputBytes: number;
  rendererVersion: string;
  ffmpegPath: string;
  ffprobePath: string;
  fontPath: string;
  fontFamily: string;
  assFontFamily: string;
  fontWeight: number;
  fontStyle: "normal" | "italic";
}

const integerEnv = (name: string, fallback: number, minimum: number, maximum: number): number => {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const resolveStaticBinary = async (
  environmentName: string,
  packageName: "ffmpeg-static" | "ffprobe-static",
  systemName: string,
): Promise<string> => {
  const findExecutable = async (candidate: string): Promise<string | undefined> => {
    const candidates = path.isAbsolute(candidate) || candidate.includes(path.sep)
      ? [path.resolve(candidate)]
      : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, candidate));
    for (const executable of candidates) {
      try {
        await access(executable, constants.X_OK);
        return executable;
      } catch {
        // Continue through the bounded PATH candidates.
      }
    }
    return undefined;
  };

  const configured = process.env[environmentName];
  if (configured) {
    const executable = await findExecutable(configured);
    if (!executable) throw new Error(`${environmentName} does not name an executable file`);
    return executable;
  }
  try {
    if (packageName === "ffmpeg-static") {
      const module = await import("ffmpeg-static");
      const staticPath = module.default;
      if (typeof staticPath === "string") {
        const executable = await findExecutable(staticPath);
        if (executable) return executable;
      }
    } else {
      const module = await import("ffprobe-static");
      if (module.default?.path) {
        const executable = await findExecutable(module.default.path);
        if (executable) return executable;
      }
    }
  } catch {
    // A system binary remains a supported deployment option.
  }
  const executable = await findExecutable(systemName);
  if (!executable) {
    throw new Error(`No executable ${systemName} binary is available; install the static package or set ${environmentName}`);
  }
  return executable;
};

export async function loadRenderWorkerConfig(): Promise<RenderWorkerConfig> {
  const authSecret = process.env.PRAXIS_RENDER_AUTH_SECRET ?? "";
  if (authSecret.length < 32) {
    throw new Error("PRAXIS_RENDER_AUTH_SECRET must contain at least 32 characters");
  }
  const resultSigningSecret = process.env.PRAXIS_RENDER_RESULT_SIGNING_SECRET ?? "";
  if (resultSigningSecret.length < 32) {
    throw new Error("PRAXIS_RENDER_RESULT_SIGNING_SECRET must contain at least 32 characters");
  }
  const resultSigningKeyId = process.env.PRAXIS_RENDER_RESULT_SIGNING_KEY_ID ?? "praxis-render-result-v1";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(resultSigningKeyId)) {
    throw new Error("PRAXIS_RENDER_RESULT_SIGNING_KEY_ID contains unsupported characters");
  }
  const allowStaticAuth = process.env.PRAXIS_RENDER_ALLOW_STATIC_AUTH === "1";
  const staticAuthToken = process.env.PRAXIS_RENDER_AUTH_TOKEN;
  if (allowStaticAuth && process.env.NODE_ENV === "production") {
    throw new Error("Static render auth is disabled when NODE_ENV=production");
  }
  if (allowStaticAuth && (!staticAuthToken || staticAuthToken.length < 32)) {
    throw new Error("Static auth requires PRAXIS_RENDER_AUTH_TOKEN with at least 32 characters");
  }
  const objectStoreRoot = path.resolve(process.env.PRAXIS_OBJECT_STORE_ROOT ?? "/tmp/praxis-object-store");
  const tempRoot = path.resolve(process.env.PRAXIS_RENDER_TEMP_ROOT ?? "/tmp/praxis-render-jobs");
  await Promise.all([mkdir(objectStoreRoot, { recursive: true }), mkdir(tempRoot, { recursive: true })]);
  const ffmpegPath = await resolveStaticBinary("PRAXIS_FFMPEG_PATH", "ffmpeg-static", "ffmpeg");
  const ffprobePath = await resolveStaticBinary("PRAXIS_FFPROBE_PATH", "ffprobe-static", "ffprobe");
  const fontPath = path.resolve(process.env.PRAXIS_FONT_PATH ??
    "/usr/share/fonts/truetype/roboto/unhinted/RobotoCondensed-Bold.ttf");
  const fontStyle = process.env.PRAXIS_FONT_STYLE ?? "normal";
  if (fontStyle !== "normal" && fontStyle !== "italic") {
    throw new Error("PRAXIS_FONT_STYLE must be normal or italic");
  }
  const fontFamily = process.env.PRAXIS_FONT_FAMILY ?? "Roboto Condensed Variable";
  const assFontFamily = process.env.PRAXIS_ASS_FONT_FAMILY ?? "Roboto Condensed";
  const fontWeight = integerEnv("PRAXIS_FONT_WEIGHT", 700, 100, 900);
  if (fontWeight !== 400 && fontWeight !== 700) {
    throw new Error("PRAXIS_FONT_WEIGHT must be 400 or 700 for the bounded ASS renderer");
  }
  const safeFontFamily = /^[A-Za-z0-9 ._-]+$/;
  if (!safeFontFamily.test(fontFamily) || !safeFontFamily.test(assFontFamily)) {
    throw new Error("Configured font family names contain unsupported characters");
  }

  return {
    port: integerEnv("PRAXIS_RENDER_PORT", 8790, 1, 65_535),
    authSecret,
    resultSigningSecret,
    resultSigningKeyId,
    allowStaticAuth,
    ...(allowStaticAuth && staticAuthToken ? { staticAuthToken } : {}),
    tokenMaxTtlSeconds: integerEnv("PRAXIS_RENDER_TOKEN_MAX_TTL_SECONDS", 900, 30, 3_600),
    objectStoreRoot,
    tempRoot,
    timeoutMs: integerEnv("PRAXIS_RENDER_TIMEOUT_MS", 180_000, 1_000, 3_600_000),
    maxRequestBytes: integerEnv("PRAXIS_RENDER_MAX_REQUEST_BYTES", 2_097_152, 1_024, 16_777_216),
    maxAssetBytes: integerEnv("PRAXIS_RENDER_MAX_ASSET_BYTES", 104_857_600, 1_024, 2_147_483_647),
    maxTotalAssetBytes: integerEnv("PRAXIS_RENDER_MAX_TOTAL_ASSET_BYTES", 524_288_000, 1_024, 4_294_967_295),
    maxOutputBytes: integerEnv("PRAXIS_RENDER_MAX_OUTPUT_BYTES", 1_073_741_824, 1_024, 4_294_967_295),
    rendererVersion: process.env.PRAXIS_RENDERER_VERSION ?? "praxis-ffmpeg-1",
    ffmpegPath,
    ffprobePath,
    fontPath,
    fontFamily,
    assFontFamily,
    fontWeight,
    fontStyle,
  };
}

import { z } from "zod";
import type { Env } from "./env";
import { requireMediaBinding } from "./media-binding";

const text = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const RenderUploadGrantSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(3).max(128),
    jobId: z.string().min(3).max(128),
    part: z.enum(["video", "poster", "result"]),
    objectKey: z.string().min(1).max(1_024),
    mimeType: z.enum(["video/mp4", "image/jpeg", "application/json"]),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((grant, context) => {
    const expectedMime = grant.part === "video"
      ? "video/mp4"
      : grant.part === "poster"
        ? "image/jpeg"
        : "application/json";
    if (grant.mimeType !== expectedMime) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mimeType"],
        message: `${grant.part} uploads require ${expectedMime}`,
      });
    }
  });
export type RenderUploadGrant = z.infer<typeof RenderUploadGrantSchema>;

const RenderInputGrantSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(3).max(128),
    jobId: z.string().min(3).max(128),
    assetVersionId: z.string().min(3).max(128),
    objectKey: z.string().min(1).max(1_024),
    sha256: Sha256Schema,
    byteLength: z.number().int().positive().max(1_073_741_824),
    mimeType: z.string().min(1).max(160),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type RenderInputGrant = z.infer<typeof RenderInputGrantSchema>;

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Malformed render upload grant");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new Error("Malformed render upload grant");
  return bytes;
};

const importSecret = (secret: string) => {
  if (secret.length < 32) throw new Error("Render signing secret must contain at least 32 characters");
  return crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

export async function mintRenderUploadGrant(grantInput: RenderUploadGrant, secret: string): Promise<string> {
  const grant = RenderUploadGrantSchema.parse(grantInput);
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Cannot mint an expired render upload grant");
  const payload = encodeBase64Url(text.encode(JSON.stringify(grant)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await importSecret(secret), text.encode(payload)));
  return `${payload}.${encodeBase64Url(signature)}`;
}

export async function verifyRenderUploadGrant(token: string, secret: string): Promise<RenderUploadGrant> {
  if (token.length > 8_192) throw new Error("Render upload grant is too large");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed render upload grant");
  const [payload, encodedSignature] = parts as [string, string];
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importSecret(secret),
    new Uint8Array(decodeBase64Url(encodedSignature)).buffer,
    text.encode(payload),
  );
  if (!valid) throw new Error("Invalid render upload grant");
  const grant = RenderUploadGrantSchema.parse(JSON.parse(decoder.decode(decodeBase64Url(payload))));
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Render upload grant has expired");
  return grant;
}

const signPayload = async (payload: string, secret: string) =>
  encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", await importSecret(secret), text.encode(payload))));

const verifyPayload = async (payload: string, signature: string, secret: string) =>
  crypto.subtle.verify(
    "HMAC",
    await importSecret(secret),
    new Uint8Array(decodeBase64Url(signature)).buffer,
    text.encode(payload),
  );

export async function mintRenderInputGrant(grantInput: RenderInputGrant, secret: string): Promise<string> {
  const grant = RenderInputGrantSchema.parse(grantInput);
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Cannot mint an expired render input grant");
  const payload = encodeBase64Url(text.encode(JSON.stringify(grant)));
  return `${payload}.${await signPayload(payload, secret)}`;
}

export async function verifyRenderInputGrant(token: string, secret: string): Promise<RenderInputGrant> {
  if (token.length > 8_192) throw new Error("Render input grant is too large");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed render input grant");
  const [payload, signature] = parts as [string, string];
  if (!(await verifyPayload(payload, signature, secret))) throw new Error("Invalid render input grant");
  const grant = RenderInputGrantSchema.parse(JSON.parse(decoder.decode(decodeBase64Url(payload))));
  if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error("Render input grant has expired");
  return grant;
}

export async function mintRenderJobToken(jobId: string, secret: string, ttlSeconds = 600): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1_000) + Math.min(900, Math.max(30, ttlSeconds));
  const payload = encodeBase64Url(text.encode(JSON.stringify({ jobId, expiresAt })));
  const signingInput = `v1.${payload}`;
  return `${signingInput}.${await signPayload(signingInput, secret)}`;
}

export async function handleLocalRenderInput(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return Response.json({ code: "METHOD_NOT_ALLOWED", message: "Render inputs use GET" }, { status: 405 });
  const token = new URL(request.url).searchParams.get("grant") ?? "";
  let grant: RenderInputGrant;
  try {
    grant = await verifyRenderInputGrant(token, env.PRAXIS_CAPABILITY_SIGNING_SECRET);
  } catch (error) {
    return Response.json(
      { code: "INVALID_RENDER_INPUT_GRANT", message: error instanceof Error ? error.message : "Invalid render input grant" },
      { status: 401 },
    );
  }
  const object = await requireMediaBinding(env).get(grant.objectKey);
  if (!object?.body) return Response.json({ code: "OBJECT_NOT_FOUND", message: "Immutable render input is missing" }, { status: 404 });
  if (object.size !== grant.byteLength || (object.customMetadata?.sha256 && object.customMetadata.sha256 !== grant.sha256)) {
    return Response.json({ code: "OBJECT_METADATA_MISMATCH", message: "Immutable render input metadata does not match its grant" }, { status: 409 });
  }
  const headers = new Headers({
    "content-type": grant.mimeType,
    "content-length": String(grant.byteLength),
    "x-praxis-sha256": grant.sha256,
    "cache-control": "private, no-store",
  });
  return new Response(object.body, { headers });
}

export async function handleLocalRenderUpload(request: Request, env: Env): Promise<Response> {
  if (request.method !== "PUT") return Response.json({ code: "METHOD_NOT_ALLOWED", message: "Render outputs use PUT" }, { status: 405 });
  const url = new URL(request.url);
  const token = url.searchParams.get("grant") ?? "";
  let grant: RenderUploadGrant;
  try {
    grant = await verifyRenderUploadGrant(token, env.PRAXIS_CAPABILITY_SIGNING_SECRET);
  } catch (error) {
    return Response.json(
      { code: "INVALID_RENDER_UPLOAD_GRANT", message: error instanceof Error ? error.message : "Invalid render upload grant" },
      { status: 401 },
    );
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== grant.mimeType) {
    return Response.json({ code: "INVALID_RENDER_CONTENT_TYPE", message: `Expected ${grant.mimeType}` }, { status: 415 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? Number.NaN);
  const maxBytes = grant.part === "video"
    ? 1_073_741_824
    : grant.part === "poster"
      ? 26_214_400
      : 65_536;
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0 || declaredLength > maxBytes) {
    return Response.json({ code: "INVALID_RENDER_CONTENT_LENGTH", message: "A bounded positive Content-Length is required" }, { status: 413 });
  }
  const sha256 = request.headers.get("x-praxis-sha256") ?? "";
  if (!Sha256Schema.safeParse(sha256).success) {
    return Response.json({ code: "INVALID_RENDER_SHA256", message: "x-praxis-sha256 must be a lowercase SHA-256 digest" }, { status: 400 });
  }
  if (request.headers.get("if-none-match") !== "*") {
    return Response.json({ code: "CREATE_ONLY_REQUIRED", message: "Render output uploads require If-None-Match: *" }, { status: 428 });
  }
  if (!request.body) return Response.json({ code: "EMPTY_RENDER_OUTPUT", message: "Render output body is required" }, { status: 400 });

  const media = requireMediaBinding(env);
  const existing = await media.head(grant.objectKey);
  if (existing) {
    const compatible = existing.size === declaredLength &&
      existing.customMetadata?.sha256 === sha256 &&
      existing.customMetadata?.jobId === grant.jobId &&
      existing.customMetadata?.part === grant.part;
    return compatible
      ? Response.json({ ok: true, idempotentReplay: true, objectKey: grant.objectKey }, { status: 200 })
      : Response.json({ code: "RENDER_OBJECT_IMMUTABLE", message: "Render destination already contains different bytes" }, { status: 409 });
  }

  const result = await media.put(grant.objectKey, request.body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: grant.mimeType },
    customMetadata: {
      projectId: grant.projectId,
      jobId: grant.jobId,
      part: grant.part,
      sha256,
    },
    sha256,
  });
  if (!result) {
    const raced = await media.head(grant.objectKey);
    const compatible = raced?.size === declaredLength &&
      raced.customMetadata?.sha256 === sha256 &&
      raced.customMetadata?.jobId === grant.jobId &&
      raced.customMetadata?.part === grant.part;
    return compatible
      ? Response.json({ ok: true, idempotentReplay: true, objectKey: grant.objectKey }, { status: 200 })
      : Response.json({ code: "RENDER_OBJECT_IMMUTABLE", message: "Render destination was committed concurrently" }, { status: 409 });
  }
  const stored = await media.head(grant.objectKey);
  if (!stored || stored.size !== declaredLength) {
    return Response.json({ code: "RENDER_UPLOAD_INCOMPLETE", message: "Stored output length did not match the upload" }, { status: 502 });
  }
  return Response.json({ ok: true, idempotentReplay: false, objectKey: grant.objectKey }, { status: 201 });
}

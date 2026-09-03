import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  RENDER_RESULT_SCHEMA_VERSION,
  RENDER_RESULT_SIGNATURE_ALGORITHM,
  RenderResultPayloadSchema,
  SignedRenderResultEnvelopeSchema,
  renderResultSigningInput,
  type RenderResultPayload,
  type SignedRenderResultEnvelope,
} from "@praxis/render-manifest";
import { z } from "zod";

const JobIdSchema = z.string().min(3).max(128).regex(/^[A-Za-z][A-Za-z0-9:_-]*$/);

export const JobTokenPayloadSchema = z
  .object({
    jobId: JobIdSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type JobTokenPayload = z.infer<typeof JobTokenPayloadSchema>;

const signingInput = (encodedPayload: string): string => `v1.${encodedPayload}`;

const decodeCanonicalBase64Url = (value: string): Buffer | undefined => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : undefined;
};

export function createJobToken(secret: string, payloadInput: JobTokenPayload): string {
  if (secret.length < 32) throw new Error("Render auth secret must contain at least 32 characters");
  const payload = JobTokenPayloadSchema.parse(payloadInput);
  const encodedPayload = Buffer.from(JSON.stringify({
    jobId: payload.jobId,
    expiresAt: payload.expiresAt,
  }), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(signingInput(encodedPayload)).digest("base64url");
  return `${signingInput(encodedPayload)}.${signature}`;
}

export function verifyJobToken(options: {
  token: string;
  secret: string;
  expectedJobId: string;
  maxTtlSeconds: number;
  nowSeconds?: number;
}): boolean {
  if (options.token.length > 2_048 || options.secret.length < 32) return false;
  const parts = options.token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const encodedPayload = parts[1]!;
  const encodedSignature = parts[2]!;
  const decodedPayload = decodeCanonicalBase64Url(encodedPayload);
  const providedSignature = decodeCanonicalBase64Url(encodedSignature);
  if (!decodedPayload || !providedSignature) return false;

  const expectedSignature = createHmac("sha256", options.secret)
    .update(signingInput(encodedPayload))
    .digest();
  if (providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) {
    return false;
  }

  let payload: JobTokenPayload;
  try {
    payload = JobTokenPayloadSchema.parse(JSON.parse(decodedPayload.toString("utf8")));
  } catch {
    return false;
  }
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  return payload.jobId === options.expectedJobId &&
    payload.expiresAt > nowSeconds &&
    payload.expiresAt <= nowSeconds + options.maxTtlSeconds;
}

export function staticTokenMatches(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function createSignedRenderResult(
  secret: string,
  keyId: string,
  payloadInput: RenderResultPayload,
): SignedRenderResultEnvelope {
  if (secret.length < 32) throw new Error("Render result signing secret must contain at least 32 characters");
  const payload = RenderResultPayloadSchema.parse(payloadInput);
  const signature = createHmac("sha256", secret)
    .update(renderResultSigningInput({ keyId, payload }))
    .digest("base64url");
  return SignedRenderResultEnvelopeSchema.parse({
    schemaVersion: RENDER_RESULT_SCHEMA_VERSION,
    algorithm: RENDER_RESULT_SIGNATURE_ALGORITHM,
    keyId,
    payload,
    signature,
  });
}

export function verifySignedRenderResult(options: {
  envelope: unknown;
  secret: string;
  expectedKeyId?: string;
}): boolean {
  if (options.secret.length < 32) return false;
  const parsed = SignedRenderResultEnvelopeSchema.safeParse(options.envelope);
  if (!parsed.success) return false;
  if (options.expectedKeyId !== undefined && parsed.data.keyId !== options.expectedKeyId) return false;
  const expected = createHmac("sha256", options.secret)
    .update(renderResultSigningInput({ keyId: parsed.data.keyId, payload: parsed.data.payload }))
    .digest();
  const provided = decodeCanonicalBase64Url(parsed.data.signature);
  if (!provided) return false;
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

import { CapabilityScopeSchema, type CapabilityScope } from "@praxis/agent-runs";
import { StableIdSchema, type ProductionProject } from "@praxis/project-schema";
import { z } from "zod";
import type { AuthenticatedActor, Env } from "./env";
import { accessMutationOriginAllowed } from "./access-auth";
import { browserSessionFromRequest, verifyBrowserSession } from "./browser-session";
import { stableJson } from "./json";

export { CapabilityScopeSchema } from "@praxis/agent-runs";
export type { CapabilityScope } from "@praxis/agent-runs";

export const PraxisCapabilitySchema = z
  .object({
    subject: z.string().min(1).max(160),
    projectId: StableIdSchema,
    runId: StableIdSchema.optional(),
    scopes: z.array(CapabilityScopeSchema).min(1).max(12),
    maxSpendUsd: z.number().nonnegative().finite().optional(),
    deniedEntityIds: z.array(StableIdSchema).max(256).optional(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PraxisCapability = z.infer<typeof PraxisCapabilitySchema>;

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Malformed capability token");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Malformed capability token");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64Url(bytes) !== value) throw new Error("Malformed capability token");
  return bytes;
};

const text = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const constantTimeEqual = (left: ArrayBuffer, right: ArrayBuffer): boolean => {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
};

const importSecret = (secret: string) => {
  if (secret.length < 32) throw new Error("Capability signing secret must contain at least 32 characters");
  return crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

export const mintCapability = async (capabilityInput: PraxisCapability, secret: string): Promise<string> => {
  const capability = PraxisCapabilitySchema.parse(capabilityInput);
  if (Date.parse(capability.expiresAt) <= Date.now()) throw new Error("Cannot mint an already-expired capability");
  const header = encodeBase64Url(text.encode(JSON.stringify({ alg: "HS256", typ: "PRAXIS-CAP", v: 1 })));
  const payload = encodeBase64Url(text.encode(JSON.stringify(capability)));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await importSecret(secret), text.encode(signingInput)));
  return `${signingInput}.${encodeBase64Url(signature)}`;
};

export const verifyCapability = async (token: string, secret: string): Promise<PraxisCapability> => {
  if (token.length > 16_384) throw new Error("Capability token is too large");
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("Malformed capability token");
  const [headerPart, payloadPart, signaturePart] = segments as [string, string, string];
  const header = JSON.parse(decoder.decode(decodeBase64Url(headerPart))) as Record<string, unknown>;
  if (header.alg !== "HS256" || header.typ !== "PRAXIS-CAP" || header.v !== 1) throw new Error("Unsupported capability token");
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importSecret(secret),
    new Uint8Array(decodeBase64Url(signaturePart)).buffer,
    text.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("Invalid capability signature");
  const capability = PraxisCapabilitySchema.parse(JSON.parse(decoder.decode(decodeBase64Url(payloadPart))));
  if (Date.parse(capability.expiresAt) <= Date.now()) throw new Error("Capability has expired");
  return capability;
};

export interface AuthenticationResult {
  ok: true;
  actor: AuthenticatedActor;
}

export interface AuthenticationFailure {
  ok: false;
  status: 401 | 403;
  code: "AUTH_REQUIRED" | "AUTH_INVALID" | "CAPABILITY_SCOPE_DENIED" | "CAPABILITY_PROJECT_DENIED";
  message: string;
}

export const authenticate = async (
  request: Request,
  env: Env,
  options: { projectId?: string; scope?: CapabilityScope; ownerOnly?: boolean } = {},
): Promise<AuthenticationResult | AuthenticationFailure> => {
  const authMode = env.PRAXIS_AUTH_MODE ?? "development_owner";
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    if (authMode !== "cloudflare_access") {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", message: "A bearer owner or capability token is required" };
    }
    if (!env.PRAXIS_BROWSER_SESSION_SIGNING_SECRET) {
      return { ok: false, status: 401, code: "AUTH_INVALID", message: "Browser session authentication is not configured" };
    }
    try {
      const token = browserSessionFromRequest(request);
      if (!token) throw new Error("Browser session is required");
      const session = await verifyBrowserSession(token, env.PRAXIS_BROWSER_SESSION_SIGNING_SECRET);
      if (!accessMutationOriginAllowed(request, env.PRAXIS_ALLOWED_ORIGIN)) {
        return { ok: false, status: 403, code: "AUTH_INVALID", message: "Browser mutation origin is not trusted" };
      }
      return {
        ok: true,
        actor: {
          kind: "director",
          id: `access:${session.subject}`,
          deniedEntityIds: [],
          scopes: CapabilityScopeSchema.options,
          owner: true,
          authentication: "cloudflare_access",
        },
      };
    } catch {
      return { ok: false, status: 401, code: "AUTH_INVALID", message: "Cloudflare Access application session is invalid" };
    }
  }
  const token = header.slice(7);
  if (!token || token.length > 16_384) return { ok: false, status: 401, code: "AUTH_INVALID", message: "Invalid bearer token" };
  const ownerTokenMatches = async () => {
    const [provided, expected] = await Promise.all([
      crypto.subtle.digest("SHA-256", text.encode(token)),
      crypto.subtle.digest("SHA-256", text.encode(env.PRAXIS_OWNER_TOKEN)),
    ]);
    return constantTimeEqual(provided, expected);
  };
  if (authMode === "development_owner" && await ownerTokenMatches()) {
    return {
      ok: true,
      actor: {
        kind: "director",
        id: "owner",
        deniedEntityIds: [],
        scopes: CapabilityScopeSchema.options,
        owner: true,
        authentication: "owner_token",
      },
    };
  }
  if (options.ownerOnly) return { ok: false, status: 403, code: "CAPABILITY_SCOPE_DENIED", message: "Owner authority is required" };
  let capability: PraxisCapability;
  try {
    capability = await verifyCapability(token, env.PRAXIS_CAPABILITY_SIGNING_SECRET);
  } catch (error) {
    return { ok: false, status: 401, code: "AUTH_INVALID", message: error instanceof Error ? error.message : "Invalid capability" };
  }
  if (options.projectId && capability.projectId !== options.projectId) {
    return { ok: false, status: 403, code: "CAPABILITY_PROJECT_DENIED", message: "Capability does not grant access to this project" };
  }
  if (options.scope && !capability.scopes.includes(options.scope)) {
    return { ok: false, status: 403, code: "CAPABILITY_SCOPE_DENIED", message: `Capability lacks ${options.scope}` };
  }
  return {
    ok: true,
    actor: {
      kind: "codex",
      id: capability.subject,
      runId: capability.runId,
      capabilityMaxSpendUsd: capability.maxSpendUsd,
      deniedEntityIds: capability.deniedEntityIds ?? [],
      scopes: capability.scopes,
      owner: false,
      authentication: "capability",
    },
  };
};

const collectOperationEntityIds = (value: unknown, key = ""): string[] => {
  if (typeof value === "string" && (key.endsWith("Id") || key === "id")) return [value];
  if (Array.isArray(value)) {
    if (key.endsWith("Ids")) return value.filter((item): item is string => typeof item === "string");
    return value.flatMap((item) => collectOperationEntityIds(item));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, child]) => collectOperationEntityIds(child, childKey));
};

export const deniedCommandEntities = (operations: unknown[], deniedEntityIds: string[]): string[] => {
  if (!deniedEntityIds.length) return [];
  const denied = new Set(deniedEntityIds);
  return [...new Set(operations.flatMap((operation) => collectOperationEntityIds(operation)).filter((id) => denied.has(id)))];
};

/**
 * Materializes the authorization-visible state of every canonical entity. Parent
 * entities intentionally include their children: mutating a clip also mutates its
 * containing track and timeline document. The project ID represents the complete
 * canonical snapshot, so denying it denies every project mutation.
 */
const projectEntityState = (project: ProductionProject): Map<string, string> => {
  const entities = new Map<string, string>();
  const add = (id: string, value: unknown) => entities.set(id, stableJson(value));

  add(project.projectId, project);
  for (const beat of project.script.beats) add(beat.meta.id, beat);
  for (const scene of project.scenes) add(scene.meta.id, scene);
  for (const asset of Object.values(project.assets)) {
    add(asset.meta.id, asset);
    for (const version of asset.versions) add(version.id, version);
  }
  add(project.timeline.meta.id, project.timeline);
  for (const track of project.timeline.tracks) {
    add(track.meta.id, track);
    for (const clip of track.clips) add(clip.meta.id, clip);
  }
  for (const decision of project.decisions) add(decision.meta.id, decision);
  for (const checkpoint of project.checkpoints) add(checkpoint.id, checkpoint);
  for (const [stage, state] of Object.entries(project.stages)) add(`stage:${stage}`, state);

  return entities;
};

/** Returns denied entities whose canonical representation changes, appears, or disappears. */
export const deniedProjectMutationEntities = (
  before: ProductionProject,
  after: ProductionProject,
  deniedEntityIds: string[],
): string[] => {
  if (!deniedEntityIds.length) return [];
  const beforeState = projectEntityState(before);
  const afterState = projectEntityState(after);
  return [...new Set(deniedEntityIds)]
    .filter((id) => beforeState.has(id) || afterState.has(id))
    .filter((id) => beforeState.get(id) !== afterState.get(id))
    .sort();
};

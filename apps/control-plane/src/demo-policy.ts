export const PRAXIS_DEMO_PROJECT_ID = "project_fax_oracle";

export type DemoApiDecision = "allow" | "forbidden" | "not_found";

const PROJECT_PREFIX = `/api/projects/${PRAXIS_DEMO_PROJECT_ID}`;
const stableId = "[A-Za-z][A-Za-z0-9:_-]{2,127}";
const checkpointRestorePath = new RegExp(`^${PROJECT_PREFIX}/checkpoints/${stableId}/restore$`, "u");

const allowedReads = new Set([
  PROJECT_PREFIX,
  `${PROJECT_PREFIX}/events`,
]);

const allowedMutations = new Set([
  `${PROJECT_PREFIX}/commands`,
  `${PROJECT_PREFIX}/undo`,
  `${PROJECT_PREFIX}/redo`,
  `${PROJECT_PREFIX}/checkpoints`,
]);

export function classifyDemoApiRequest(request: Request): DemoApiDecision {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && (pathname === "/health" || allowedReads.has(pathname))) {
    return "allow";
  }
  if (request.method === "POST" && (allowedMutations.has(pathname) || checkpointRestorePath.test(pathname))) {
    return "allow";
  }
  if (pathname === "/api/projects" || pathname.startsWith(`${PROJECT_PREFIX}/`)) return "forbidden";
  if (pathname.startsWith("/api/projects/")) return "forbidden";
  if (pathname.startsWith("/api/") || pathname.startsWith("/auth/") || pathname.startsWith("/internal/")) {
    return "not_found";
  }
  return "not_found";
}

export function demoMutationOriginAllowed(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

const fixedLengthEqual = (left: ArrayBuffer, right: ArrayBuffer): boolean => {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
};

const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

export async function demoBasicAuthorizationValid(
  request: Request,
  expectedUsername: string,
  expectedPassword: string,
): Promise<boolean> {
  if (!expectedUsername || expectedUsername.length > 128 || expectedPassword.length < 32) return false;
  const header = request.headers.get("authorization");
  if (!header || header.length > 1_024 || !header.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(header.slice(6)), (character) => character.charCodeAt(0)),
    );
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const providedUsername = decoded.slice(0, separator);
  const providedPassword = decoded.slice(separator + 1);
  const [providedUsernameDigest, expectedUsernameDigest, providedPasswordDigest, expectedPasswordDigest] = await Promise.all([
    digest(providedUsername),
    digest(expectedUsername),
    digest(providedPassword),
    digest(expectedPassword),
  ]);
  return fixedLengthEqual(providedUsernameDigest, expectedUsernameDigest)
    && fixedLengthEqual(providedPasswordDigest, expectedPasswordDigest);
}

export async function deriveDemoInternalOwnerSecret(secret: string): Promise<string> {
  const derived = new Uint8Array(await digest(`praxis-demo-internal-owner-v1\u0000${secret}`));
  return [...derived].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

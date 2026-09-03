export const PRAXIS_DEMO_PROJECT_ID = "project_fax_oracle";
export const PRAXIS_DEMO_LOGIN_PATH = "/login";
export const PRAXIS_DEMO_LOGIN_CSRF_COOKIE = "praxis_demo_login_csrf";
export const PRAXIS_DEMO_LOGIN_CSRF_MAX_AGE_SECONDS = 10 * 60;
export const PRAXIS_DEMO_SESSION_COOKIE = "praxis_demo_session";
export const PRAXIS_DEMO_SESSION_MAX_AGE_SECONDS = 4 * 60 * 60;
export const PRAXIS_DEMO_LOGIN_MAX_BODY_BYTES = 2_048;

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

const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

const configuredCredentialsValid = (username: string, password: string): boolean =>
  username.length > 0 && username.length <= 128 && password.length >= 32 && password.length <= 512;

async function constantTimeTextEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  const subtle: SubtleCrypto & {
    timingSafeEqual?: (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => boolean;
  } = crypto.subtle;
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(leftDigest, rightDigest);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < Math.max(leftBytes.byteLength, rightBytes.byteLength); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header || header.length > 4_096) return undefined;
  let value: string | undefined;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    if (value !== undefined) return undefined;
    value = segment.slice(separator + 1).trim();
  }
  return value;
}

export function createDemoLoginCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function demoLoginCsrfCookie(token: string): string {
  return `${PRAXIS_DEMO_LOGIN_CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PRAXIS_DEMO_LOGIN_CSRF_MAX_AGE_SECONDS}; Secure`;
}

export function expiredDemoLoginCsrfCookie(): string {
  return `${PRAXIS_DEMO_LOGIN_CSRF_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure`;
}

export async function demoLoginCsrfValid(request: Request, providedToken: string): Promise<boolean> {
  const cookieToken = cookieValue(request, PRAXIS_DEMO_LOGIN_CSRF_COOKIE) ?? "";
  const equal = await constantTimeTextEqual(providedToken, cookieToken);
  return /^[a-f0-9]{64}$/u.test(providedToken) && /^[a-f0-9]{64}$/u.test(cookieToken) && equal;
}

export async function demoCredentialsValid(
  providedUsername: string,
  providedPassword: string,
  expectedUsername: string,
  expectedPassword: string,
): Promise<boolean> {
  if (!configuredCredentialsValid(expectedUsername, expectedPassword)) return false;
  if (providedUsername.length > 128 || providedPassword.length > 512) return false;
  const [usernameValid, passwordValid] = await Promise.all([
    constantTimeTextEqual(providedUsername, expectedUsername),
    constantTimeTextEqual(providedPassword, expectedPassword),
  ]);
  return usernameValid && passwordValid;
}

export async function demoBasicAuthorizationValid(
  request: Request,
  expectedUsername: string,
  expectedPassword: string,
): Promise<boolean> {
  if (!configuredCredentialsValid(expectedUsername, expectedPassword)) return false;
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
  return demoCredentialsValid(providedUsername, providedPassword, expectedUsername, expectedPassword);
}

export async function deriveDemoInternalOwnerSecret(secret: string): Promise<string> {
  const derived = new Uint8Array(await digest(`praxis-demo-internal-owner-v1\u0000${secret}`));
  return [...derived].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveDemoSessionValue(username: string, password: string): Promise<string> {
  const derived = new Uint8Array(await digest(`praxis-demo-browser-session-v1\u0000${username}\u0000${password}`));
  return [...derived].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function demoSessionAuthorizationValid(
  request: Request,
  expectedUsername: string,
  expectedPassword: string,
): Promise<boolean> {
  if (!configuredCredentialsValid(expectedUsername, expectedPassword)) return false;
  const provided = cookieValue(request, PRAXIS_DEMO_SESSION_COOKIE);
  if (!provided || !/^[a-f0-9]{64}$/u.test(provided)) return false;
  return constantTimeTextEqual(provided, await deriveDemoSessionValue(expectedUsername, expectedPassword));
}

export async function demoSessionCookie(
  username: string,
  password: string,
): Promise<string> {
  const value = await deriveDemoSessionValue(username, password);
  return `${PRAXIS_DEMO_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PRAXIS_DEMO_SESSION_MAX_AGE_SECONDS}; Secure`;
}

export type DemoLoginCredentialsResult =
  | { ok: true; username: string; password: string; csrfToken: string }
  | { ok: false; status: 400 | 413 | 415 };

export async function readDemoLoginCredentials(request: Request): Promise<DemoLoginCredentialsResult> {
  const mediaType = (request.headers.get("content-type")?.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (mediaType !== "application/x-www-form-urlencoded") return { ok: false, status: 415 };
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { ok: false, status: 400 };
    if (length > PRAXIS_DEMO_LOGIN_MAX_BODY_BYTES) return { ok: false, status: 413 };
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const reader = request.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > PRAXIS_DEMO_LOGIN_MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(chunk.value);
    }
  }
  const encoded = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
  } catch {
    return { ok: false, status: 400 };
  }
  const form = new URLSearchParams(body);
  const usernames = form.getAll("username");
  const passwords = form.getAll("password");
  const csrfTokens = form.getAll("csrf_token");
  if ([...form.keys()].some((key) => key !== "username" && key !== "password" && key !== "csrf_token")) {
    return { ok: false, status: 400 };
  }
  if (usernames.length !== 1 || passwords.length !== 1 || csrfTokens.length > 1) return { ok: false, status: 400 };
  const username = usernames[0]!;
  const password = passwords[0]!;
  const csrfToken = csrfTokens[0] ?? "";
  if (!username || username.length > 128 || !password || password.length > 512) return { ok: false, status: 400 };
  return { ok: true, username, password, csrfToken };
}

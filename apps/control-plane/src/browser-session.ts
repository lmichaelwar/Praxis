import { z } from "zod";

const text = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const PRAXIS_SESSION_COOKIE = "__Host-praxis_session";

const BrowserSessionSchema = z
  .object({
    version: z.literal(1),
    subject: z.string().min(1).max(256),
    email: z.string().email(),
    issuedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Malformed browser session");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error("Malformed browser session");
  return bytes;
};

const importSecret = (secret: string) => {
  if (secret.length < 32) throw new Error("Browser session signing secret must contain at least 32 characters");
  return crypto.subtle.importKey("raw", text.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

export const mintBrowserSession = async (sessionInput: BrowserSession, secret: string): Promise<string> => {
  const session = BrowserSessionSchema.parse(sessionInput);
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("Cannot mint an expired browser session");
  const payload = base64Url(text.encode(JSON.stringify(session)));
  const signingInput = `praxis-browser-session.v1.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await importSecret(secret), text.encode(signingInput)));
  return `${payload}.${base64Url(signature)}`;
};

export const verifyBrowserSession = async (token: string, secret: string): Promise<BrowserSession> => {
  if (token.length > 8_192) throw new Error("Browser session is too large");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Malformed browser session");
  const [payload, encodedSignature] = parts as [string, string];
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importSecret(secret),
    new Uint8Array(decodeBase64Url(encodedSignature)).buffer,
    text.encode(`praxis-browser-session.v1.${payload}`),
  );
  if (!valid) throw new Error("Invalid browser session signature");
  const session = BrowserSessionSchema.parse(JSON.parse(decoder.decode(decodeBase64Url(payload))));
  if (Date.parse(session.expiresAt) <= Date.now()) throw new Error("Browser session has expired");
  return session;
};

export const browserSessionFromRequest = (request: Request): string | undefined => {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const segment of cookie.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== PRAXIS_SESSION_COOKIE) continue;
    const token = segment.slice(separator + 1).trim();
    return token || undefined;
  }
  return undefined;
};

export const browserSessionCookie = (token: string, maxAgeSeconds: number): string =>
  `${PRAXIS_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;

export const expiredBrowserSessionCookie = (): string =>
  `${PRAXIS_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

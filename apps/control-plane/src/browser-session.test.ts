import { describe, expect, it, vi } from "vitest";
import {
  browserSessionCookie,
  browserSessionFromRequest,
  expiredBrowserSessionCookie,
  mintBrowserSession,
  PRAXIS_SESSION_COOKIE,
  verifyBrowserSession,
} from "./browser-session";

const secret = "browser-session-test-secret-that-is-long-enough";
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const nonCanonicalSignature = (token: string): string => {
  const parts = token.split(".");
  const signature = parts.at(-1)!;
  const lastIndex = base64UrlAlphabet.indexOf(signature.at(-1)!);
  parts[parts.length - 1] = `${signature.slice(0, -1)}${base64UrlAlphabet[lastIndex + 1]}`;
  return parts.join(".");
};

describe("Praxis browser sessions", () => {
  it("round-trips a signed, expiring director identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const session = {
      version: 1 as const,
      subject: "director-1",
      email: "director@example.com",
      issuedAt: "2026-08-26T12:00:00.000Z",
      expiresAt: "2026-08-26T13:00:00.000Z",
    };
    const token = await mintBrowserSession(session, secret);
    await expect(verifyBrowserSession(token, secret)).resolves.toEqual(session);
    const [payload, signature] = token.split(".") as [string, string];
    const first = signature[0] === "A" ? "B" : "A";
    await expect(verifyBrowserSession(`${payload}.${first}${signature.slice(1)}`, secret)).rejects.toThrow("signature");
    await expect(verifyBrowserSession(nonCanonicalSignature(token), secret)).rejects.toThrow("Malformed");
    vi.setSystemTime(new Date("2026-08-26T13:00:01.000Z"));
    await expect(verifyBrowserSession(token, secret)).rejects.toThrow("expired");
    vi.useRealTimers();
  });

  it("uses a host-only secure HttpOnly Strict cookie", () => {
    const header = browserSessionCookie("signed-token", 3_600);
    expect(header).toContain(`${PRAXIS_SESSION_COOKIE}=signed-token`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).not.toContain("Domain=");
    expect(expiredBrowserSessionCookie()).toContain("Max-Age=0");
    expect(browserSessionFromRequest(new Request("https://studio.example/api", {
      headers: { cookie: `other=value; ${PRAXIS_SESSION_COOKIE}=signed-token` },
    }))).toBe("signed-token");
  });
});

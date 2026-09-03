import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessMutationOriginAllowed, verifyAccessIdentity } from "./access-auth";

const teamDomain = "https://praxis-test.cloudflareaccess.com";
const audience = "praxis-staging-audience";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare Access browser authentication", () => {
  it("verifies the RS256 signature, issuer, audience, and browser identity", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const token = await new SignJWT({
      type: "app",
      sub: "director-identity",
      email: "director@example.com",
    })
      .setProtectedHeader({ alg: "RS256", kid: "access-key-1" })
      .setIssuer(teamDomain)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      keys: [{ ...publicJwk, kid: "access-key-1", alg: "RS256", use: "sig" }],
    })));

    await expect(verifyAccessIdentity(new Request("https://studio.example/api", {
      headers: { "cf-access-jwt-assertion": token },
    }), { teamDomain, audience })).resolves.toEqual({
      id: "director-identity",
      email: "director@example.com",
    });
  });

  it("rejects a token for another Access application", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const token = await new SignJWT({ type: "app", sub: "director", email: "director@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "access-key-2" })
      .setIssuer(teamDomain)
      .setAudience("another-application")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      keys: [{ ...publicJwk, kid: "access-key-2", alg: "RS256", use: "sig" }],
    })));

    await expect(verifyAccessIdentity(new Request("https://studio.example/api", {
      headers: { "cf-access-jwt-assertion": token },
    }), { teamDomain, audience })).rejects.toThrow();
  });

  it("requires same-origin browser mutations while allowing reads", () => {
    expect(accessMutationOriginAllowed(new Request("https://studio.example/api", {
      method: "POST",
      headers: { origin: "https://studio.example" },
    }))).toBe(true);
    expect(accessMutationOriginAllowed(new Request("https://studio.example/api", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }))).toBe(false);
    expect(accessMutationOriginAllowed(new Request("https://studio.example/api"))).toBe(true);
  });
});

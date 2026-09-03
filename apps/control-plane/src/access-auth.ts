import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const AccessIdentitySchema = z
  .object({
    type: z.literal("app"),
    sub: z.string(),
    email: z.string().email(),
  })
  .passthrough();

export interface AccessIdentity {
  id: string;
  email: string;
}

const normalizedTeamDomain = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Cloudflare Access team domain must be a credential-free HTTPS origin");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Cloudflare Access team domain cannot contain a path");
  }
  return url.origin;
};

/**
 * Verifies the application JWT injected by Cloudflare Access. Merely trusting
 * the assertion header would allow identity spoofing if an alternate route ever
 * reached the Worker without passing through the Access policy.
 */
export const verifyAccessIdentity = async (
  request: Request,
  configuration: { teamDomain: string; audience: string },
): Promise<AccessIdentity> => {
  if (!configuration.audience) throw new Error("Cloudflare Access audience is not configured");
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16_384) throw new Error("Cloudflare Access application JWT is required");

  const issuer = normalizedTeamDomain(configuration.teamDomain);
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const verified = await jwtVerify(token, jwks, {
    issuer,
    audience: configuration.audience,
    algorithms: ["RS256"],
  });
  const payload = AccessIdentitySchema.parse(verified.payload);
  if (!payload.sub) throw new Error("Cloudflare Access browser identity is missing its subject");
  return { id: payload.sub, email: payload.email };
};

/** Cookie-backed browser mutations must originate from the protected Studio. */
export const accessMutationOriginAllowed = (
  request: Request,
  configuredOrigin?: string,
): boolean => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const expected = configuredOrigin ?? new URL(request.url).origin;
  try {
    return new URL(origin).origin === new URL(expected).origin;
  } catch {
    return false;
  }
};

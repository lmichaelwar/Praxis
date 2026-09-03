import { AgentClaimTicketClaimsSchema, type AgentClaimTicketClaims } from "@praxis/agent-runs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Malformed AgentRun claim ticket");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Malformed AgentRun claim ticket");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new Error("Malformed AgentRun claim ticket");
  return bytes;
};

const importSecret = (secret: string) => {
  if (secret.length < 32) throw new Error("AgentRun claim signing secret must contain at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
};

export const claimTicketDigest = async (ticket: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(ticket)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const mintAgentClaimTicket = async (
  claimsInput: AgentClaimTicketClaims,
  secret: string,
): Promise<string> => {
  const claims = AgentClaimTicketClaimsSchema.parse(claimsInput);
  if (Date.parse(claims.expiresAt) <= Date.now()) throw new Error("Cannot mint an expired AgentRun claim ticket");
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "PRAXIS-CLAIM", v: 1 })));
  const payload = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await importSecret(secret), encoder.encode(signingInput)));
  return `${signingInput}.${encodeBase64Url(signature)}`;
};

export const verifyAgentClaimTicket = async (
  ticket: string,
  secret: string,
): Promise<AgentClaimTicketClaims> => {
  if (ticket.length > 16_384) throw new Error("AgentRun claim ticket is too large");
  const segments = ticket.split(".");
  if (segments.length !== 3) throw new Error("Malformed AgentRun claim ticket");
  const [headerPart, payloadPart, signaturePart] = segments as [string, string, string];
  const header = JSON.parse(decoder.decode(decodeBase64Url(headerPart))) as Record<string, unknown>;
  if (header.alg !== "HS256" || header.typ !== "PRAXIS-CLAIM" || header.v !== 1) {
    throw new Error("Unsupported AgentRun claim ticket");
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importSecret(secret),
    new Uint8Array(decodeBase64Url(signaturePart)).buffer,
    encoder.encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw new Error("Invalid AgentRun claim ticket signature");
  const claims = AgentClaimTicketClaimsSchema.parse(JSON.parse(decoder.decode(decodeBase64Url(payloadPart))));
  if (Date.parse(claims.expiresAt) <= Date.now()) throw new Error("AgentRun claim ticket has expired");
  return claims;
};

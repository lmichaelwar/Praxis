import { describe, expect, it } from "vitest";
import { claimTicketDigest, mintAgentClaimTicket, verifyAgentClaimTicket } from "./agent-claim-ticket";

const secret = "claim-secret-with-at-least-thirty-two-characters";
const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const nonCanonicalSignature = (token: string): string => {
  const parts = token.split(".");
  const signature = parts.at(-1)!;
  const lastIndex = base64UrlAlphabet.indexOf(signature.at(-1)!);
  parts[parts.length - 1] = `${signature.slice(0, -1)}${base64UrlAlphabet[lastIndex + 1]}`;
  return parts.join(".");
};

describe("AgentRun claim tickets", () => {
  it("round-trips signed, project-bound claims and exposes only a digest for persistence", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const ticket = await mintAgentClaimTicket({
      version: 1,
      ticketId: "ticket_123",
      projectId: "project_123",
      runId: "run_123",
      expiresAt,
    }, secret);

    await expect(verifyAgentClaimTicket(ticket, secret)).resolves.toEqual({
      version: 1,
      ticketId: "ticket_123",
      projectId: "project_123",
      runId: "run_123",
      expiresAt,
    });
    await expect(claimTicketDigest(ticket)).resolves.toMatch(/^[a-f0-9]{64}$/u);
    expect(await claimTicketDigest(ticket)).not.toContain(ticket);
  });

  it("rejects tampering and expired claims", async () => {
    const ticket = await mintAgentClaimTicket({
      version: 1,
      ticketId: "ticket_123",
      projectId: "project_123",
      runId: "run_123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, secret);
    const [header, payload, signature] = ticket.split(".") as [string, string, string];
    const first = signature[0] === "A" ? "B" : "A";
    await expect(verifyAgentClaimTicket(`${header}.${payload}.${first}${signature.slice(1)}`, secret)).rejects.toThrow();
    await expect(verifyAgentClaimTicket(nonCanonicalSignature(ticket), secret)).rejects.toThrow("Malformed");
    await expect(mintAgentClaimTicket({
      version: 1,
      ticketId: "ticket_123",
      projectId: "project_123",
      runId: "run_123",
      expiresAt: new Date(Date.now() - 1).toISOString(),
    }, secret)).rejects.toThrow("expired");
  });
});

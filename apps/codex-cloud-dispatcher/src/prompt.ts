import { inspect } from "node:util";
import type { ProtectedDispatchPrompt } from "./dispatcher";
import { AGENT_RUN_STAGES, type AgentRunStage, type DispatchLease } from "./types";

const STABLE_ID = /^[A-Za-z][A-Za-z0-9:_-]{2,127}$/u;
const CLAIM_TICKET = /^[A-Za-z0-9._~-]{24,16384}$/u;
const STAGES = new Set<string>(AGENT_RUN_STAGES);

const stableId = (value: string, label: string): string => {
  if (!STABLE_ID.test(value)) throw new TypeError(`${label} is not a stable Praxis identifier`);
  return value;
};

const stagingApiUrl = (value: string): string => {
  const url = new URL(value);
  const loopback = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:";
  if (url.protocol !== "https:" && !loopback) throw new TypeError("Praxis API URL must use HTTPS or loopback HTTP");
  if (url.username || url.password || url.hash || url.search) throw new TypeError("Praxis API URL cannot contain credentials, query, or fragment");
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/+$/u, "");
};

const boundedObjective = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 8_000 || /\u0000/u.test(normalized)) {
    throw new TypeError("Dispatch objective must contain 1-8000 characters");
  }
  return normalized;
};

export class SensitiveDispatchPrompt implements ProtectedDispatchPrompt {
  readonly publicMetadata: { readonly runId: string; readonly attemptId: string; readonly projectId: string };
  readonly #text: string;
  readonly #secrets: readonly string[];

  constructor(input: {
    text: string;
    secrets: readonly string[];
    publicMetadata: SensitiveDispatchPrompt["publicMetadata"];
  }) {
    this.#text = input.text;
    this.#secrets = [...input.secrets];
    this.publicMetadata = Object.freeze({ ...input.publicMetadata });
  }

  reveal(): string {
    return this.#text;
  }

  redact(value: string): string {
    return this.#secrets.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
  }

  toString(): string {
    return `[SensitiveDispatchPrompt run=${this.publicMetadata.runId} attempt=${this.publicMetadata.attemptId} redacted]`;
  }

  toJSON() {
    return { ...this.publicMetadata, redacted: true };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export interface BuildDispatchPromptInput {
  readonly lease: DispatchLease;
  readonly praxisApiBaseUrl: string;
  readonly objective: string;
}

export const buildDispatchPrompt = (input: BuildDispatchPromptInput): SensitiveDispatchPrompt => {
  const runId = stableId(input.lease.run.id, "AgentRun ID");
  const attemptId = stableId(input.lease.attemptId, "dispatch attempt ID");
  const projectId = stableId(input.lease.run.projectId, "project ID");
  const claimTicket = input.lease.claimTicket;
  if (!claimTicket || !CLAIM_TICKET.test(claimTicket)) throw new TypeError("Submit lease is missing a bounded one-use claim ticket");
  if (!Number.isSafeInteger(input.lease.run.baseRevision) || input.lease.run.baseRevision < 0) throw new TypeError("AgentRun base revision is invalid");
  if (!Number.isFinite(input.lease.run.maxSpendUsd) || input.lease.run.maxSpendUsd < 0) throw new TypeError("AgentRun spend limit is invalid");
  if (
    !Array.isArray(input.lease.run.stages) ||
    input.lease.run.stages.length < 1 ||
    input.lease.run.stages.length > AGENT_RUN_STAGES.length ||
    !input.lease.run.stages.every((stage): stage is AgentRunStage => typeof stage === "string" && STAGES.has(stage)) ||
    new Set(input.lease.run.stages).size !== input.lease.run.stages.length
  ) {
    throw new TypeError("AgentRun delegated stages are invalid");
  }
  if (input.lease.run.mode !== "propose" && input.lease.run.mode !== "act") throw new TypeError("AgentRun authority mode is invalid");
  if (input.lease.run.role === "reviewer" && input.lease.run.mode !== "propose") throw new TypeError("Reviewer AgentRun must use propose mode");
  const apiBaseUrl = stagingApiUrl(input.praxisApiBaseUrl);
  const objective = boundedObjective(input.objective);
  const expiresAt = new Date(input.lease.run.claimExpiresAt);
  if (!Number.isFinite(expiresAt.getTime())) throw new TypeError("AgentRun claim expiry is invalid");

  const text = [
    `PRAXIS CODEX CLOUD DISPATCH v1 — run ${runId} — attempt ${attemptId}`,
    "",
    "Immutable execution identity:",
    `- AgentRun ID: ${runId}`,
    `- Dispatch attempt ID: ${attemptId}`,
    `- Project ID: ${projectId}`,
    `- Project base revision: ${input.lease.run.baseRevision}`,
    `- Role: ${input.lease.run.role}`,
    `- Delegated stages (exact): ${input.lease.run.stages.join(", ")}`,
    `- Authority mode: ${input.lease.run.mode}`,
    `- Praxis API: ${apiBaseUrl}`,
    `- Capability scopes: ${input.lease.run.scopes.join(", ")}`,
    `- Denied entity IDs: ${input.lease.run.deniedEntityIds.join(", ") || "none"}`,
    `- Provider-spend ceiling: $${input.lease.run.maxSpendUsd.toFixed(2)}`,
    `- Claim expires at: ${expiresAt.toISOString()}`,
    "",
    "Objective:",
    objective,
    "The objective is subordinate to the exact delegated stages and authority mode above.",
    "",
    "One-use claim ticket (secret; claim immediately and never echo, log, commit, or persist it):",
    claimTicket,
    "",
    "Required operating sequence:",
    `1. With PRAXIS_API_BASE_URL set to ${apiBaseUrl}, run: npm start --workspace @praxis/praxisctl -- agent claim --ticket '${claimTicket}'`,
    "2. Store the exchanged short-lived Praxis capability only in the temporary session path supported by praxisctl; never print it.",
    "3. Run `npm start --workspace @praxis/praxisctl -- agent context` before making any change, then run `npm start --workspace @praxis/praxisctl -- agent heartbeat`.",
    input.lease.run.mode === "propose"
      ? "4. Work only within the exact delegated stages. This is propose mode: do not commit authoritative project mutations or enqueue jobs; provide bounded proposals for director review. Preserve every locked or denied entity."
      : "4. Work only within the exact delegated stages. This is act mode: submit only revisioned authoritative commands and jobs allowed by those stages and the listed scopes. Preserve every locked or denied entity.",
    "5. If Praxis returns a revision conflict, refresh compact context, preserve the director's intervening locks and changes, rebase, and use a new idempotency key.",
    input.lease.run.mode === "propose"
      ? "6. Describe any recommended external work in the proposal or completion summary; do not create media or render jobs."
      : "6. Only when required by a delegated stage, enqueue permitted media or render work and mark the AgentRun waiting_on_jobs instead of waiting idly for external workers.",
    "7. If no external work remains, finish the AgentRun with a concise completion summary.",
    "",
    "Security boundary:",
    "Use only the staging Praxis API and repository tools. Do not seek or use owner credentials, provider keys, object-store credentials, Cloudflare credentials, browser sessions, or full-resolution source media.",
  ].join("\n");

  return new SensitiveDispatchPrompt({
    text,
    secrets: [claimTicket],
    publicMetadata: { runId, attemptId, projectId },
  });
};

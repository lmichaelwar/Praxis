import { createHash } from "node:crypto";
import {
  AGENT_RUN_STAGES,
  CAPABILITY_SCOPES,
  type AgentRunStage,
  type AgentRunStatus,
  type CapabilityScope,
  type DispatchAttemptResult,
  type DispatchLease,
  type DispatchableAgentRun,
  type ReconciliationCandidate,
} from "./types";

const MAX_RESPONSE_BYTES = 1_000_000;
const STABLE_ID = /^[A-Za-z][A-Za-z0-9:_-]{2,127}$/u;
const RUN_STATUSES = new Set<AgentRunStatus>([
  "created",
  "dispatching",
  "claimed",
  "working",
  "waiting_on_jobs",
  "completed",
  "failed",
  "cancelled",
  "dispatch_unknown",
]);
const SCOPES = new Set<string>(CAPABILITY_SCOPES);
const STAGES = new Set<string>(AGENT_RUN_STAGES);

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DispatchControlPlane {
  readonly publicBaseUrl: string;
  leaseNext(signal?: AbortSignal): Promise<DispatchLease | null>;
  listReconciliationCandidates(signal?: AbortSignal): Promise<readonly ReconciliationCandidate[]>;
  recordResult(
    runId: string,
    attemptId: string,
    result: DispatchAttemptResult,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class PraxisDispatchApiError extends Error {
  readonly status?: number;
  readonly code: string;

  constructor(input: { code: string; message: string; status?: number; cause?: unknown }) {
    super(input.message, { cause: input.cause });
    this.name = "PraxisDispatchApiError";
    this.code = input.code;
    this.status = input.status;
  }
}

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: `${label} was not an object` });
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, label: string, maximum = 2_048): string => {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: `${label} was invalid` });
  }
  return value;
};

const stableId = (value: unknown, label: string): string => {
  const parsed = string(value, label, 128);
  if (!STABLE_ID.test(parsed)) throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: `${label} was invalid` });
  return parsed;
};

const optionalString = (value: unknown, label: string, maximum = 4_096): string | undefined =>
  value === undefined || value === null ? undefined : string(value, label, maximum);

const isoDate = (value: unknown, label: string): string => {
  const parsed = string(value, label, 128);
  const timestamp = Date.parse(parsed);
  if (!Number.isFinite(timestamp)) throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: `${label} was invalid` });
  return new Date(timestamp).toISOString();
};

const optionalIsoDate = (value: unknown, label: string): string | undefined =>
  value === undefined || value === null ? undefined : isoDate(value, label);

const optionalHttpsUrl = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const parsed = new URL(string(value, label, 4_096));
  if (parsed.protocol !== "https:") throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: `${label} was not HTTPS` });
  if (parsed.username || parsed.password) throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: `${label} contained credentials` });
  return parsed.toString();
};

const parseRun = (value: unknown): DispatchableAgentRun => {
  const raw = record(value, "AgentRun");
  const status = string(raw.status, "AgentRun status", 64) as AgentRunStatus;
  if (!RUN_STATUSES.has(status)) throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun status was invalid" });
  if (raw.role !== "producer-editor" && raw.role !== "reviewer") {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun role was invalid" });
  }
  if (raw.mode !== "propose" && raw.mode !== "act") {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun mode was invalid" });
  }
  if (raw.role === "reviewer" && raw.mode !== "propose") {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "Reviewer AgentRun mode was invalid" });
  }
  if (
    !Array.isArray(raw.stages) ||
    raw.stages.length < 1 ||
    raw.stages.length > AGENT_RUN_STAGES.length ||
    !raw.stages.every((stage): stage is AgentRunStage => typeof stage === "string" && STAGES.has(stage)) ||
    new Set(raw.stages).size !== raw.stages.length
  ) {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun stages were invalid" });
  }
  if (!Number.isSafeInteger(raw.baseRevision) || (raw.baseRevision as number) < 0) {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun base revision was invalid" });
  }
  if (typeof raw.maxSpendUsd !== "number" || !Number.isFinite(raw.maxSpendUsd) || raw.maxSpendUsd < 0) {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun spend limit was invalid" });
  }
  if (!Array.isArray(raw.scopes) || !raw.scopes.every((scope): scope is CapabilityScope => typeof scope === "string" && SCOPES.has(scope))) {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun scopes were invalid" });
  }
  if (!Array.isArray(raw.deniedEntityIds)) {
    throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "AgentRun denied entities were invalid" });
  }
  const deniedEntityIds = raw.deniedEntityIds.map((id) => stableId(id, "denied entity ID"));
  return {
    id: stableId(raw.id, "AgentRun ID"),
    projectId: stableId(raw.projectId, "AgentRun project ID"),
    baseRevision: raw.baseRevision as number,
    role: raw.role,
    stages: raw.stages,
    mode: raw.mode,
    status,
    scopes: raw.scopes,
    deniedEntityIds,
    maxSpendUsd: raw.maxSpendUsd,
    claimExpiresAt: isoDate(raw.claimExpiresAt, "AgentRun claim expiry"),
    ...(optionalIsoDate(raw.leaseExpiresAt, "AgentRun lease expiry") ? { leaseExpiresAt: optionalIsoDate(raw.leaseExpiresAt, "AgentRun lease expiry") } : {}),
    ...(optionalString(raw.codexTaskId, "Codex task ID", 512) ? { codexTaskId: optionalString(raw.codexTaskId, "Codex task ID", 512) } : {}),
    ...(optionalHttpsUrl(raw.codexTaskUrl, "Codex task URL") ? { codexTaskUrl: optionalHttpsUrl(raw.codexTaskUrl, "Codex task URL") } : {}),
    ...(optionalIsoDate(raw.lastHeartbeatAt, "AgentRun heartbeat") ? { lastHeartbeatAt: optionalIsoDate(raw.lastHeartbeatAt, "AgentRun heartbeat") } : {}),
    ...(optionalString(raw.completionSummary, "AgentRun completion summary", 4_000) ? { completionSummary: optionalString(raw.completionSummary, "AgentRun completion summary", 4_000) } : {}),
  };
};

const parseCandidate = (value: unknown): ReconciliationCandidate => {
  const raw = record(value, "dispatch reconciliation entry");
  return {
    run: parseRun(raw.run),
    attemptId: stableId(raw.dispatchAttemptId, "dispatch attempt ID"),
  };
};

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value);
  const loopback = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:";
  if (url.protocol !== "https:" && !loopback) throw new TypeError("Praxis dispatcher API must use HTTPS or loopback HTTP");
  if (url.username || url.password || url.search || url.hash) throw new TypeError("Praxis dispatcher API URL cannot contain credentials, query, or fragment");
  url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/api$/u, "");
  return url.toString().replace(/\/+$/u, "");
};

const resultAction = (outcome: DispatchAttemptResult["outcome"]): "record_task" | "mark_unknown" | "mark_failed" =>
  outcome === "dispatched" ? "record_task" : outcome === "dispatch_unknown" ? "mark_unknown" : "mark_failed";

type DispatchResultPayload =
  | { readonly action: "record_task"; readonly codexTaskId: string; readonly codexTaskUrl?: string }
  | { readonly action: "mark_unknown"; readonly errorCode?: string; readonly errorMessage: string }
  | { readonly action: "mark_failed"; readonly errorCode: string; readonly errorMessage: string };

const resultPayload = (result: DispatchAttemptResult): DispatchResultPayload => {
  const action = resultAction(result.outcome);
  if (action === "record_task") {
    if (!result.codexTaskId) throw new TypeError("A dispatched result requires a Codex task ID");
    return {
      action,
      codexTaskId: result.codexTaskId,
      ...(result.codexTaskUrl ? { codexTaskUrl: result.codexTaskUrl } : {}),
    };
  }
  if (action === "mark_unknown") {
    return {
      action,
      ...(result.reasonCode ? { errorCode: result.reasonCode } : {}),
      errorMessage: "Codex Cloud submission could not be correlated unambiguously",
    };
  }
  return {
    action,
    errorCode: result.reasonCode,
    errorMessage: "Codex Cloud task was not submitted",
  };
};

const idempotencyKey = (runId: string, attemptId: string, payload: DispatchResultPayload): string =>
  `dispatch-result-${createHash("sha256")
    .update(JSON.stringify([runId, attemptId, payload]))
    .digest("hex")
    .slice(0, 32)}`;

export interface PraxisDispatchClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly dispatcherId: string;
  readonly leaseSeconds?: number;
  readonly fetch?: FetchLike;
}

export class PraxisDispatchClient implements DispatchControlPlane {
  readonly publicBaseUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly dispatcherId: string;
  private readonly leaseSeconds: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: PraxisDispatchClientOptions) {
    this.publicBaseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.token.length < 32 || options.token.length > 16_384) throw new TypeError("Praxis dispatcher token length is invalid");
    this.token = options.token;
    if (!STABLE_ID.test(options.projectId)) throw new TypeError("Praxis project ID is invalid");
    if (!STABLE_ID.test(options.dispatcherId)) throw new TypeError("Praxis dispatcher ID is invalid");
    this.projectId = options.projectId;
    this.dispatcherId = options.dispatcherId;
    this.leaseSeconds = options.leaseSeconds ?? 600;
    if (!Number.isSafeInteger(this.leaseSeconds) || this.leaseSeconds < 60 || this.leaseSeconds > 1_800) {
      throw new TypeError("Dispatcher lease must be between 60 and 1800 seconds");
    }
    this.fetchImpl = (options.fetch ?? globalThis.fetch).bind(globalThis) as FetchLike;
  }

  private endpoint(path: string): string {
    return `${this.publicBaseUrl}/${path.replace(/^\/+/, "")}`;
  }

  private async request(path: string, init: RequestInit): Promise<{ response: Response; value?: unknown }> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint(path), { ...init, headers, redirect: "error" });
    } catch (cause) {
      throw new PraxisDispatchApiError({ code: "NETWORK_ERROR", message: "Praxis dispatch API could not be reached", cause });
    }
    if (response.status === 204) return { response };
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_RESPONSE_BYTES) throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "Praxis dispatch API response was too large", status: response.status });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "Praxis dispatch API response was too large", status: response.status });
    let value: unknown;
    try {
      value = text ? JSON.parse(text) as unknown : undefined;
    } catch (cause) {
      throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "Praxis dispatch API returned invalid JSON", status: response.status, cause });
    }
    if (!response.ok) {
      const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const code = typeof body.code === "string" && /^[A-Z0-9_]{2,80}$/u.test(body.code) ? body.code : `HTTP_${response.status}`;
      throw new PraxisDispatchApiError({ code, message: "Praxis dispatch API rejected the request", status: response.status });
    }
    return { response, value };
  }

  async leaseNext(signal?: AbortSignal): Promise<DispatchLease | null> {
    const { response, value } = await this.request("internal/agent-dispatch/lease", {
      method: "POST",
      signal,
      body: JSON.stringify({
        projectId: this.projectId,
        dispatcherId: this.dispatcherId,
        leaseSeconds: this.leaseSeconds,
      }),
    });
    if (response.status === 204) return null;
    const raw = record(value, "dispatch lease response");
    return {
      mode: "submit",
      run: parseRun(raw.run),
      attemptId: stableId(raw.dispatchAttemptId, "dispatch attempt ID"),
      claimTicket: string(raw.claimTicket, "claim ticket", 16_384),
    };
  }

  async listReconciliationCandidates(signal?: AbortSignal): Promise<readonly ReconciliationCandidate[]> {
    const query = new URLSearchParams({
      projectId: this.projectId,
      statuses: "dispatching,dispatch_unknown,claimed,working,waiting_on_jobs,completed,failed,cancelled",
    });
    const { value } = await this.request(`internal/agent-dispatch/runs?${query}`, { method: "GET", signal });
    const raw = record(value, "dispatch reconciliation response");
    if (!Array.isArray(raw.runs)) throw new PraxisDispatchApiError({ code: "INVALID_RESPONSE", message: "Dispatch reconciliation response omitted runs" });
    return raw.runs.map(parseCandidate);
  }

  async recordResult(
    runIdValue: string,
    attemptIdValue: string,
    result: DispatchAttemptResult,
    signal?: AbortSignal,
  ): Promise<void> {
    const runId = stableId(runIdValue, "AgentRun ID");
    const attemptId = stableId(attemptIdValue, "dispatch attempt ID");
    const payload = resultPayload(result);
    await this.request(`internal/agent-dispatch/runs/${encodeURIComponent(runId)}/result`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        projectId: this.projectId,
        dispatchAttemptId: attemptId,
        idempotencyKey: idempotencyKey(runId, attemptId, payload),
        ...payload,
      }),
    });
  }
}

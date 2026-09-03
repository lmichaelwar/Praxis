// Node's runtime type stripper requires explicit TypeScript extensions.
// @ts-expect-error -- the workspace compiler intentionally leaves TS source un-emitted.
import { PraxisApiError, PraxisConflictError, PraxisEventStreamError, PraxisNetworkError } from "./errors.ts";
import type {
  ApiErrorBody,
  ApplyCommandRequest,
  AgentRunContextResponse,
  AgentRunListResponse,
  AgentRunResponse,
  BrowserSessionResponse,
  CancelAgentRunRequest,
  ClaimAgentRunRequest,
  ClaimAgentRunResponse,
  CommandCommitResponse,
  CreateAgentRunRequest,
  CreateCheckpointRequest,
  CreateCheckpointResponse,
  CreateJobRequest,
  CreateProjectRequest,
  FetchLike,
  FinishAgentRunRequest,
  HeartbeatAgentRunRequest,
  HeartbeatAgentRunResponse,
  JobListResponse,
  JobResponse,
  PraxisRemoteClientOptions,
  ProjectEvent,
  ProjectEventSubscription,
  ProjectHydrationResponse,
  RequestOptions,
  RestoreCheckpointRequest,
  RevisionMutationRequest,
  SubscribeProjectEventsOptions,
} from "./types";

const MAX_ERROR_BODY_LENGTH = 64 * 1024;

function normalizeApiRoot(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError("Praxis API base URL must be an absolute HTTP(S) URL.", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Praxis API base URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new TypeError("Praxis API credentials must not be embedded in the base URL.");
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/api") ? path : `${path}/api`;
  return url.toString().replace(/\/+$/, "");
}

function encodePath(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_ERROR_BODY_LENGTH && !response.ok) {
    return { code: `HTTP_${response.status}`, message: "Praxis API returned an oversized error body." };
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (!response.ok) {
      return { code: `HTTP_${response.status}`, message: "Praxis API returned a non-JSON error response." };
    }
    throw new PraxisApiError(response.status, {
      code: "INVALID_RESPONSE",
      message: "Praxis API returned a non-JSON success response.",
    }, error);
  }
}

function apiError(status: number, body: unknown): PraxisApiError {
  const details = isRecord(body) ? body as ApiErrorBody : {};
  if (status === 409 || details.code === "REVISION_CONFLICT") {
    return new PraxisConflictError(status, details);
  }
  return new PraxisApiError(status, details);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (
    typeof error === "object" && error !== null && "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function waitForReconnect(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface ParsedSseFrame {
  id?: string;
  event?: string;
  data?: string;
  retry?: number;
}

function parseSseFrame(rawFrame: string): ParsedSseFrame | null {
  const frame: { id?: string; event?: string; data: string[]; retry?: number } = { data: [] };
  for (const rawLine of rawFrame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") frame.id = value;
    if (field === "event") frame.event = value;
    if (field === "data") frame.data.push(value);
    if (field === "retry" && /^\d+$/.test(value)) frame.retry = Number(value);
  }
  if (!frame.id && !frame.event && frame.data.length === 0 && frame.retry === undefined) return null;
  return {
    ...(frame.id === undefined ? {} : { id: frame.id }),
    ...(frame.event === undefined ? {} : { event: frame.event }),
    ...(frame.data.length === 0 ? {} : { data: frame.data.join("\n") }),
    ...(frame.retry === undefined ? {} : { retry: frame.retry }),
  };
}

function projectEvent(frame: ParsedSseFrame): ProjectEvent | null {
  if (!frame.data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data) as unknown;
  } catch (error) {
    throw new PraxisEventStreamError("Praxis event stream returned malformed JSON.", error);
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    throw new PraxisEventStreamError("Praxis event stream returned an invalid event object.");
  }
  const idSequence = frame.id && /^\d+$/.test(frame.id) ? Number(frame.id) : undefined;
  const sequence = typeof parsed.sequence === "number" ? parsed.sequence : idSequence;
  if (!Number.isSafeInteger(sequence) || (sequence ?? -1) < 0) {
    throw new PraxisEventStreamError("Praxis event is missing a non-negative sequence number.");
  }
  return { ...parsed, sequence } as ProjectEvent;
}

export class PraxisRemoteClient {
  readonly apiRoot: string;
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;
  private readonly refreshBrowserSessionOnUnauthorized: boolean;
  private browserSessionRefresh?: Promise<BrowserSessionResponse>;

  constructor(options: PraxisRemoteClientOptions) {
    this.apiRoot = normalizeApiRoot(options.baseUrl);
    this.token = options.token?.trim() || undefined;
    this.refreshBrowserSessionOnUnauthorized = options.refreshBrowserSessionOnUnauthorized ?? false;
    const candidate = options.fetch ?? globalThis.fetch;
    if (typeof candidate !== "function") {
      throw new TypeError("PraxisRemoteClient requires a Fetch-compatible implementation.");
    }
    this.fetchImpl = candidate.bind(globalThis) as FetchLike;
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    return headers;
  }

  private endpoint(path: string): string {
    return `${this.apiRoot}/${path.replace(/^\/+/, "")}`;
  }

  private applicationEndpoint(path: string): string {
    const applicationRoot = this.apiRoot.endsWith("/api")
      ? this.apiRoot.slice(0, -4)
      : this.apiRoot;
    return `${applicationRoot}/${path.replace(/^\/+/, "")}`;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    options: RequestOptions = {},
    includeAuthorization = true,
  ): Promise<T> {
    const headers = includeAuthorization ? this.headers() : this.headersWithoutAuthorization();
    const init: RequestInit = {
      method,
      headers,
      signal: options.signal,
      credentials: "include",
    };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchWithBrowserSessionRetry(
        this.endpoint(path),
        init,
        includeAuthorization && !this.token,
      );
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      if (error instanceof PraxisApiError || error instanceof PraxisNetworkError) throw error;
      throw new PraxisNetworkError(error);
    }
    const parsed = await responseBody(response);
    if (!response.ok) throw apiError(response.status, parsed);
    return parsed as T;
  }

  private headersWithoutAuthorization(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    return headers;
  }

  private async ensureBrowserSession(): Promise<BrowserSessionResponse> {
    if (!this.browserSessionRefresh) {
      this.browserSessionRefresh = this.createBrowserSession().finally(() => {
        this.browserSessionRefresh = undefined;
      });
    }
    return this.browserSessionRefresh;
  }

  private async fetchWithBrowserSessionRetry(
    input: string,
    init: RequestInit,
    allowRefresh: boolean,
  ): Promise<Response> {
    const response = await this.fetchImpl(input, init);
    if (
      response.status !== 401 ||
      !allowRefresh ||
      !this.refreshBrowserSessionOnUnauthorized
    ) {
      return response;
    }
    await this.ensureBrowserSession();
    return this.fetchImpl(input, init);
  }

  async createBrowserSession(options: RequestOptions = {}): Promise<BrowserSessionResponse> {
    const headers = this.headersWithoutAuthorization({ "content-type": "application/json" });
    let response: Response;
    try {
      response = await this.fetchImpl(this.applicationEndpoint("auth/session"), {
        method: "POST",
        headers,
        body: "{}",
        signal: options.signal,
        credentials: "include",
      });
    } catch (error) {
      if (isAbortError(error, options.signal)) throw error;
      throw new PraxisNetworkError(error);
    }
    const parsed = await responseBody(response);
    if (!response.ok) throw apiError(response.status, parsed);
    return parsed as BrowserSessionResponse;
  }

  getProject(projectId: string, options?: RequestOptions): Promise<ProjectHydrationResponse> {
    return this.request("GET", `projects/${encodePath(projectId, "projectId")}`, undefined, options);
  }

  createProject(request: CreateProjectRequest, options?: RequestOptions): Promise<ProjectHydrationResponse> {
    return this.request("POST", "projects", request, options);
  }

  applyCommand(
    projectId: string,
    command: ApplyCommandRequest,
    options?: RequestOptions,
  ): Promise<CommandCommitResponse> {
    return this.request("POST", `projects/${encodePath(projectId, "projectId")}/commands`, command, options);
  }

  undoProject(
    projectId: string,
    request: RevisionMutationRequest,
    options?: RequestOptions,
  ): Promise<CommandCommitResponse> {
    return this.request("POST", `projects/${encodePath(projectId, "projectId")}/undo`, request, options);
  }

  redoProject(
    projectId: string,
    request: RevisionMutationRequest,
    options?: RequestOptions,
  ): Promise<CommandCommitResponse> {
    return this.request("POST", `projects/${encodePath(projectId, "projectId")}/redo`, request, options);
  }

  createCheckpoint(
    projectId: string,
    request: CreateCheckpointRequest,
    options?: RequestOptions,
  ): Promise<CreateCheckpointResponse> {
    return this.request("POST", `projects/${encodePath(projectId, "projectId")}/checkpoints`, request, options);
  }

  restoreCheckpoint(
    projectId: string,
    checkpointId: string,
    request: RestoreCheckpointRequest,
    options?: RequestOptions,
  ): Promise<CommandCommitResponse> {
    return this.request(
      "POST",
      `projects/${encodePath(projectId, "projectId")}/checkpoints/${encodePath(checkpointId, "checkpointId")}/restore`,
      request,
      options,
    );
  }

  listJobs(projectId: string, options?: RequestOptions): Promise<JobListResponse> {
    return this.request("GET", `projects/${encodePath(projectId, "projectId")}/jobs`, undefined, options);
  }

  createJob(
    projectId: string,
    request: CreateJobRequest,
    options?: RequestOptions,
  ): Promise<JobResponse> {
    return this.request("POST", `projects/${encodePath(projectId, "projectId")}/jobs`, request, options);
  }

  getJob(projectId: string, jobId: string, options?: RequestOptions): Promise<JobResponse> {
    return this.request(
      "GET",
      `projects/${encodePath(projectId, "projectId")}/jobs/${encodePath(jobId, "jobId")}`,
      undefined,
      options,
    );
  }

  cancelJob(projectId: string, jobId: string, options?: RequestOptions): Promise<JobResponse> {
    return this.request(
      "POST",
      `projects/${encodePath(projectId, "projectId")}/jobs/${encodePath(jobId, "jobId")}/cancel`,
      {},
      options,
    );
  }

  createAgentRun(
    projectId: string,
    request: CreateAgentRunRequest,
    options?: RequestOptions,
  ): Promise<AgentRunResponse> {
    return this.request(
      "POST",
      `projects/${encodePath(projectId, "projectId")}/agent-runs`,
      request,
      options,
    );
  }

  listAgentRuns(projectId: string, options?: RequestOptions): Promise<AgentRunListResponse> {
    return this.request(
      "GET",
      `projects/${encodePath(projectId, "projectId")}/agent-runs`,
      undefined,
      options,
    );
  }

  getAgentRun(projectId: string, runId: string, options?: RequestOptions): Promise<AgentRunResponse> {
    return this.request(
      "GET",
      `projects/${encodePath(projectId, "projectId")}/agent-runs/${encodePath(runId, "runId")}`,
      undefined,
      options,
    );
  }

  getAgentRunContext(
    projectId: string,
    runId: string,
    options?: RequestOptions,
  ): Promise<AgentRunContextResponse> {
    return this.request(
      "GET",
      `projects/${encodePath(projectId, "projectId")}/agent-runs/${encodePath(runId, "runId")}/context`,
      undefined,
      options,
    );
  }

  claimAgentRun(
    request: ClaimAgentRunRequest,
    options?: RequestOptions,
  ): Promise<ClaimAgentRunResponse> {
    return this.request("POST", "agent-runs/claim", request, options, false);
  }

  heartbeatAgentRun(
    projectId: string,
    runId: string,
    request: HeartbeatAgentRunRequest,
    options?: RequestOptions,
  ): Promise<HeartbeatAgentRunResponse> {
    return this.request(
      "POST",
      `projects/${encodePath(projectId, "projectId")}/agent-runs/${encodePath(runId, "runId")}/heartbeat`,
      request,
      options,
    );
  }

  finishAgentRun(
    projectId: string,
    runId: string,
    request: FinishAgentRunRequest,
    options?: RequestOptions,
  ): Promise<AgentRunResponse> {
    return this.request(
      "POST",
      `projects/${encodePath(projectId, "projectId")}/agent-runs/${encodePath(runId, "runId")}/finish`,
      request,
      options,
    );
  }

  cancelAgentRun(
    projectId: string,
    runId: string,
    request: CancelAgentRunRequest,
    options?: RequestOptions,
  ): Promise<AgentRunResponse> {
    return this.request(
      "POST",
      `projects/${encodePath(projectId, "projectId")}/agent-runs/${encodePath(runId, "runId")}/cancel`,
      request,
      options,
    );
  }

  assetAccessUrl(projectId: string, assetVersionId: string): string {
    return this.endpoint(
      `projects/${encodePath(projectId, "projectId")}/assets/${encodePath(assetVersionId, "assetVersionId")}/access`,
    );
  }

  subscribeProjectEvents(
    projectId: string,
    options: SubscribeProjectEventsOptions,
  ): ProjectEventSubscription {
    const controller = new AbortController();
    let lastSequence = options.afterSequence ?? 0;
    let reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 1_000);
    const reconnect = options.reconnect ?? true;
    const parentAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) parentAbort();
    else options.signal?.addEventListener("abort", parentAbort, { once: true });

    const consume = async (response: Response) => {
      if (!response.body) {
        throw new PraxisEventStreamError("Praxis event stream response has no body.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const rawFrame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const frame = parseSseFrame(rawFrame);
            if (frame?.retry !== undefined) reconnectDelayMs = frame.retry;
            const event = frame ? projectEvent(frame) : null;
            if (event && event.sequence > lastSequence) {
              if (event.sequence > lastSequence + 1) {
                await options.onGap?.({
                  lastSequence,
                  expectedSequence: lastSequence + 1,
                  receivedSequence: event.sequence,
                });
              }
              lastSequence = event.sequence;
              await options.onEvent(event);
            }
            boundary = buffer.indexOf("\n\n");
          }
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    };

    const done = (async () => {
      try {
        while (!controller.signal.aborted) {
          const query = new URLSearchParams({ afterSequence: String(lastSequence) });
          const headers = this.headers({
            accept: "text/event-stream",
            "cache-control": "no-cache",
            ...(lastSequence > 0 ? { "last-event-id": String(lastSequence) } : {}),
          });
          try {
            const response = await this.fetchWithBrowserSessionRetry(
              this.endpoint(`projects/${encodePath(projectId, "projectId")}/events?${query}`),
              { method: "GET", headers, signal: controller.signal, credentials: "include" },
              !this.token,
            );
            if (!response.ok) throw apiError(response.status, await responseBody(response));
            await consume(response);
            if (!reconnect) return;
          } catch (error) {
            if (isAbortError(error, controller.signal)) return;
            const surfaced = error instanceof Error ? error : new PraxisEventStreamError("Praxis event stream failed.", error);
            await options.onError?.(surfaced);
            if (!reconnect) throw surfaced;
          }
          try {
            await waitForReconnect(reconnectDelayMs, controller.signal);
          } catch (error) {
            if (isAbortError(error, controller.signal)) return;
            throw error;
          }
        }
      } finally {
        options.signal?.removeEventListener("abort", parentAbort);
      }
    })();

    return {
      signal: controller.signal,
      done,
      close(reason?: unknown) {
        if (!controller.signal.aborted) controller.abort(reason);
      },
      getLastSequence: () => lastSequence,
    };
  }
}

export const createPraxisRemoteClient = (options: PraxisRemoteClientOptions) =>
  new PraxisRemoteClient(options);

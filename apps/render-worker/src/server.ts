import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { staticTokenMatches, verifyJobToken } from "./auth";
import { ProcessExecutionError } from "./process";
import {
  RenderRequestSchema,
  type RenderExecutor,
} from "./executor";

export interface RenderServerOptions {
  authSecret: string;
  tokenMaxTtlSeconds: number;
  allowStaticAuth?: boolean;
  staticAuthToken?: string;
  maxRequestBytes: number;
  timeoutMs: number;
  executor: RenderExecutor;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
};

const isAuthorized = (
  request: IncomingMessage,
  expectedJobId: string,
  options: RenderServerOptions,
): boolean => {
  const authorization = request.headers.authorization ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (
    options.allowStaticAuth &&
    options.staticAuthToken &&
    staticTokenMatches(provided, options.staticAuthToken)
  ) {
    return true;
  }
  return verifyJobToken({
    token: provided,
    secret: options.authSecret,
    expectedJobId,
    maxTtlSeconds: options.tokenMaxTtlSeconds,
  });
};

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Request body must be application/json");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", `Request exceeds ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", `Request exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

interface ActiveJob {
  controller: AbortController;
  timedOut: boolean;
}

export function createRenderServer(options: RenderServerOptions): http.Server {
  const activeJobs = new Map<string, ActiveJob>();
  const cancellationTombstones = new Map<string, number>();

  const pruneCancellationTombstones = () => {
    const now = Date.now();
    for (const [jobId, expiresAt] of cancellationTombstones) {
      if (expiresAt <= now) cancellationTombstones.delete(jobId);
    }
  };

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://render-worker.local");
      pruneCancellationTombstones();
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "praxis-render-worker", activeJobs: activeJobs.size });
        return;
      }
      if (request.method === "POST" && url.pathname === "/render") {
        const parsed = RenderRequestSchema.parse(await readJson(request, options.maxRequestBytes));
        if (!isAuthorized(request, parsed.jobId, options)) {
          throw new HttpError(401, "UNAUTHORIZED", "A valid job-scoped render token is required");
        }
        if (cancellationTombstones.has(parsed.jobId)) {
          throw new HttpError(409, "RENDER_CANCELLED", `Render job ${parsed.jobId} was cancelled before dispatch`);
        }
        if (activeJobs.has(parsed.jobId)) {
          throw new HttpError(409, "JOB_ALREADY_RUNNING", `Render job ${parsed.jobId} is already running`);
        }
        const controller = new AbortController();
        const active: ActiveJob = { controller, timedOut: false };
        activeJobs.set(parsed.jobId, active);
        const timeout = setTimeout(() => {
          active.timedOut = true;
          controller.abort(new Error("Render request timed out"));
        }, options.timeoutMs);
        timeout.unref();
        const onRequestAborted = () => controller.abort(new Error("Caller disconnected"));
        const onResponseClosed = () => {
          if (!response.writableEnded) controller.abort(new Error("Caller disconnected"));
        };
        request.once("aborted", onRequestAborted);
        response.once("close", onResponseClosed);
        try {
          const result = await options.executor.execute(parsed, controller.signal);
          sendJson(response, 200, { ok: true, result });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new HttpError(
              active.timedOut ? 504 : 409,
              active.timedOut ? "RENDER_TIMEOUT" : "RENDER_CANCELLED",
              active.timedOut ? "Render exceeded its job timeout" : "Render was cancelled",
            );
          }
          throw error;
        } finally {
          clearTimeout(timeout);
          request.removeListener("aborted", onRequestAborted);
          response.removeListener("close", onResponseClosed);
          activeJobs.delete(parsed.jobId);
        }
        return;
      }

      const cancelMatch = /^\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelMatch) {
        let jobId: string;
        try {
          jobId = decodeURIComponent(cancelMatch[1]!);
        } catch {
          throw new HttpError(400, "INVALID_JOB_ID", "Render job ID is malformed");
        }
        if (!/^[A-Za-z][A-Za-z0-9:_-]{2,127}$/.test(jobId)) {
          throw new HttpError(400, "INVALID_JOB_ID", "Render job ID is invalid");
        }
        if (!isAuthorized(request, jobId, options)) {
          throw new HttpError(401, "UNAUTHORIZED", "A valid job-scoped render token is required");
        }
        const active = activeJobs.get(jobId);
        cancellationTombstones.set(jobId, Date.now() + options.tokenMaxTtlSeconds * 1_000);
        active?.controller.abort(new Error("Cancellation requested"));
        sendJson(response, 202, { ok: true, jobId, status: "cancel_requested", active: Boolean(active) });
        return;
      }

      throw new HttpError(404, "NOT_FOUND", "Render-worker route not found");
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } });
      } else if (error instanceof ZodError) {
        sendJson(response, 400, {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "Render request failed schema validation",
            issues: error.issues.slice(0, 25).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          },
        });
      } else if (error instanceof ProcessExecutionError) {
        const status = error.code === "PROCESS_TIMEOUT" ? 504 : error.code === "PROCESS_ABORTED" ? 409 : 422;
        sendJson(response, status, { ok: false, error: { code: error.code, message: error.message } });
      } else {
        const message = error instanceof Error ? error.message : "Render failed";
        sendJson(response, 422, { ok: false, error: { code: "RENDER_FAILED", message } });
      }
    }
  });
}

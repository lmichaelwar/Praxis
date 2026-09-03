import path from "node:path";
import type {
  CloudTaskDispatcher,
  CloudTaskSubmission,
  ProtectedDispatchPrompt,
} from "./dispatcher";
import { CloudDispatcherError } from "./dispatcher";
import { ProcessRunError, SpawnProcessRunner, type ProcessRunner } from "./process-runner";
import type { CloudTask, CloudTaskPage } from "./types";

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_LIST_LIMIT = 20;

const SAFE_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
]);

const nonEmpty = (value: unknown, label: string, maximum = 2_048): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: `Codex Cloud returned an invalid ${label}`,
    });
  }
  return value;
};

const optionalString = (value: unknown, label: string, maximum = 4_096): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return nonEmpty(value, label, maximum);
};

const taskUrl = (value: unknown): string => {
  const raw = nonEmpty(value, "task URL", 4_096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud returned a malformed task URL",
      cause,
    });
  }
  if (parsed.protocol !== "https:") {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud returned a non-HTTPS task URL",
    });
  }
  if (parsed.username || parsed.password) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud returned a task URL containing credentials",
    });
  }
  return parsed.toString();
};

const normalizeUpdatedAt = (value: unknown): string => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return new Date(milliseconds).toISOString();
  }
  const raw = nonEmpty(value, "updated_at", 128);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud returned an invalid updated_at timestamp",
    });
  }
  return new Date(timestamp).toISOString();
};

const parseTask = (value: unknown): CloudTask => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud task entry is not an object",
    });
  }
  const raw = value as Record<string, unknown>;
  const attemptTotal = raw.attempt_total;
  if (attemptTotal !== undefined && (!Number.isSafeInteger(attemptTotal) || (attemptTotal as number) < 0)) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud returned an invalid attempt_total",
    });
  }
  if (raw.is_review !== undefined && typeof raw.is_review !== "boolean") {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud returned an invalid is_review flag",
    });
  }
  return {
    id: nonEmpty(raw.id, "task ID", 512),
    url: taskUrl(raw.url),
    title: optionalString(raw.title, "task title") ?? "",
    status: nonEmpty(raw.status, "task status", 128),
    updatedAt: normalizeUpdatedAt(raw.updated_at),
    environmentId: nonEmpty(raw.environment_id, "environment ID", 512),
    ...(optionalString(raw.environment_label, "environment label", 512) ? {
      environmentLabel: optionalString(raw.environment_label, "environment label", 512),
    } : {}),
    ...(optionalString(raw.summary, "task summary", 8_192) ? {
      summary: optionalString(raw.summary, "task summary", 8_192),
    } : {}),
    ...(typeof raw.is_review === "boolean" ? { isReview: raw.is_review } : {}),
    ...(typeof attemptTotal === "number" ? { attemptTotal } : {}),
  };
};

export const parseCloudTaskPage = (text: string): CloudTaskPage => {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_JSON",
      operation: "list",
      message: "Codex Cloud list output was not valid JSON",
      cause,
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud list output was not an object",
    });
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.tasks)) {
    throw new CloudDispatcherError({
      code: "INVALID_CLOUD_RESPONSE",
      operation: "list",
      message: "Codex Cloud list output omitted tasks",
    });
  }
  const cursor = optionalString(raw.cursor, "pagination cursor", 4_096);
  return {
    tasks: raw.tasks.map(parseTask),
    ...(cursor ? { cursor } : {}),
  };
};

export const constrainedCodexEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> => Object.fromEntries(
  Object.entries(source).filter((entry): entry is [string, string] =>
    SAFE_ENVIRONMENT_KEYS.has(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0),
);

const safeCliValue = (value: string, label: string, maximum = 1_024): string => {
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded value without control characters`);
  }
  return value;
};

const identityFromExecOutput = (output: string): { taskId?: string; taskUrl?: string } => {
  const urls = [...output.matchAll(/https:\/\/[^\s<>"']+/gu)]
    .map((match) => match[0]!.replace(/[),.;]+$/u, ""))
    .filter((candidate) => {
      try {
        const url = new URL(candidate);
        return !url.username && !url.password && /\/(?:codex\/)?tasks?\//u.test(url.pathname);
      } catch {
        return false;
      }
    });
  const uniqueUrls = [...new Set(urls)];
  if (uniqueUrls.length !== 1) return {};
  const url = new URL(uniqueUrls[0]!);
  const segments = url.pathname.split("/").filter(Boolean);
  const taskIndex = segments.findIndex((segment) => segment === "task" || segment === "tasks");
  const id = taskIndex >= 0 ? segments[taskIndex + 1] : undefined;
  if (!id || !/^[A-Za-z0-9_-]{3,512}$/u.test(id)) return { taskUrl: url.toString() };
  return { taskId: id, taskUrl: url.toString() };
};

export interface CodexCloudCliDispatcherOptions {
  readonly environmentId: string;
  readonly repositoryRoot: string;
  readonly branch?: string;
  readonly executable?: string;
  readonly processRunner?: ProcessRunner;
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly execTimeoutMs?: number;
  readonly listTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly now?: () => Date;
}

export class CodexCloudCliDispatcher implements CloudTaskDispatcher {
  private readonly environmentId: string;
  private readonly repositoryRoot: string;
  private readonly branch?: string;
  private readonly executable: string;
  private readonly runner: ProcessRunner;
  private readonly environment: Record<string, string>;
  private readonly execTimeoutMs: number;
  private readonly listTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly now: () => Date;

  constructor(options: CodexCloudCliDispatcherOptions) {
    this.environmentId = safeCliValue(options.environmentId, "Codex environment ID");
    this.repositoryRoot = path.resolve(options.repositoryRoot);
    this.branch = options.branch ? safeCliValue(options.branch, "Git branch") : undefined;
    this.executable = safeCliValue(options.executable ?? "codex", "Codex executable");
    this.runner = options.processRunner ?? new SpawnProcessRunner();
    this.environment = constrainedCodexEnvironment(options.processEnvironment ?? process.env);
    this.execTimeoutMs = options.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  async listTasks(input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  } = {}): Promise<CloudTaskPage> {
    const limit = input.limit ?? DEFAULT_LIST_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new TypeError("Codex list limit must be between 1 and 20");
    const args = ["cloud", "list", "--env", this.environmentId, "--json", "--limit", String(limit)];
    if (input.cursor) args.push("--cursor", safeCliValue(input.cursor, "Codex pagination cursor", 4_096));
    let result;
    try {
      result = await this.runner.run({
        command: this.executable,
        args,
        cwd: this.repositoryRoot,
        env: this.environment,
        shell: false,
        timeoutMs: this.listTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        signal: input.signal,
      });
    } catch (cause) {
      throw new CloudDispatcherError({
        code: cause instanceof ProcessRunError ? cause.code : "CLOUD_LIST_PROCESS_FAILED",
        operation: "list",
        message: "Codex Cloud task listing failed",
        cause,
      });
    }
    if (result.exitCode !== 0) {
      throw new CloudDispatcherError({
        code: "CLOUD_LIST_REJECTED",
        operation: "list",
        message: `Codex Cloud task listing exited with status ${result.exitCode}`,
      });
    }
    return parseCloudTaskPage(result.stdout);
  }

  async submit(input: {
    readonly prompt: ProtectedDispatchPrompt;
    readonly signal?: AbortSignal;
  }): Promise<CloudTaskSubmission> {
    const prompt = input.prompt.reveal();
    const args = ["cloud", "exec", "--env", this.environmentId, "--attempts", "1"];
    if (this.branch) args.push("--branch", this.branch);
    args.push(prompt);
    let result;
    try {
      result = await this.runner.run({
        command: this.executable,
        args,
        cwd: this.repositoryRoot,
        env: this.environment,
        shell: false,
        timeoutMs: this.execTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        signal: input.signal,
      });
    } catch (cause) {
      throw new CloudDispatcherError({
        code: cause instanceof ProcessRunError ? cause.code : "CLOUD_EXEC_PROCESS_FAILED",
        operation: "exec",
        message: "Codex Cloud submission process failed",
        submissionMayHaveOccurred: cause instanceof ProcessRunError && cause.processStarted,
        cause,
      });
    }
    if (result.exitCode !== 0) {
      throw new CloudDispatcherError({
        code: "CLOUD_EXEC_REJECTED",
        operation: "exec",
        message: `Codex Cloud rejected task submission with status ${result.exitCode}`,
        submissionMayHaveOccurred: false,
      });
    }
    const identity = identityFromExecOutput(`${result.stdout}\n${result.stderr}`);
    return {
      submittedAt: this.now().toISOString(),
      ...(identity.taskId ? { taskId: identity.taskId } : {}),
      ...(identity.taskUrl ? { taskUrl: identity.taskUrl } : {}),
    };
  }
}

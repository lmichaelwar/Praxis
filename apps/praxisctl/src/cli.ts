import {
  chmod as chmodOnDisk,
  mkdir as mkdirOnDisk,
  readFile as readFileFromDisk,
  rename as renameOnDisk,
  unlink as unlinkOnDisk,
  writeFile as writeFileToDisk,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  PraxisApiError,
  PraxisConflictError,
  PraxisRemoteClient,
  type ApplyCommandRequest,
  type CreateJobRequest,
  type FetchLike,
  type JsonValue,
  type ClaimAgentRunResponse,
  type HeartbeatAgentRunResponse,
} from "@praxis/remote-client";

export const PRAXISCTL_EXIT = {
  success: 0,
  usage: 2,
  authentication: 3,
  notFound: 4,
  conflict: 5,
  validation: 6,
  unavailable: 7,
  aborted: 130,
} as const;

interface WritableLike {
  write(chunk: string): unknown;
}

export interface PraxisCliIo {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
}

export interface PraxisCliDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly io?: PraxisCliIo;
  readonly fetch?: FetchLike;
  readonly readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readonly writeFile?: (
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ) => Promise<void>;
  readonly mkdir?: (
    path: string,
    options: { recursive: true; mode: number },
  ) => Promise<unknown>;
  readonly chmod?: (path: string, mode: number) => Promise<void>;
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly unlink?: (path: string) => Promise<void>;
  readonly cwd?: () => string;
  readonly createId?: () => string;
}

interface AgentSessionFile {
  readonly version: 1;
  readonly apiRoot: string;
  readonly projectId: string;
  readonly runId: string;
  readonly capabilityToken: string;
  readonly expiresAt: string;
}

interface ParsedArguments {
  readonly words: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

class CliUsageError extends Error {
  readonly code = "USAGE";

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const defaultIo: PraxisCliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

const BOOLEAN_FLAGS = new Set(["help", "pretty"]);

function parseArguments(argv: readonly string[]): ParsedArguments {
  const words: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = token.slice(2, equals < 0 ? undefined : equals);
    if (!name) throw new CliUsageError("Empty option name.");
    if (BOOLEAN_FLAGS.has(name)) {
      if (equals >= 0) throw new CliUsageError(`--${name} does not accept a value.`);
      switches.add(name);
      continue;
    }
    const value = equals >= 0 ? token.slice(equals + 1) : argv[index + 1];
    if (!value || (equals < 0 && value.startsWith("--"))) {
      throw new CliUsageError(`--${name} requires a value.`);
    }
    if (values.has(name)) throw new CliUsageError(`--${name} may only be provided once.`);
    values.set(name, value);
    if (equals < 0) index += 1;
  }
  return { words, values, switches };
}

function required(arguments_: ParsedArguments, name: string): string {
  const value = arguments_.values.get(name);
  if (!value) throw new CliUsageError(`--${name} is required.`);
  return value;
}

function integer(arguments_: ParsedArguments, name: string): number {
  const raw = required(arguments_, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CliUsageError(`--${name} must be a non-negative integer.`);
  }
  return value;
}

function assertNoUnknownOptions(arguments_: ParsedArguments, allowed: readonly string[]): void {
  const allowedSet = new Set([...allowed, "pretty", "help"]);
  for (const name of arguments_.values.keys()) {
    if (!allowedSet.has(name)) throw new CliUsageError(`Unknown option --${name}.`);
  }
  for (const name of arguments_.switches) {
    if (!allowedSet.has(name)) throw new CliUsageError(`Unknown option --${name}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile(
  path: string,
  readFile: (path: string, encoding: "utf8") => Promise<string>,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new CliUsageError(`Could not read JSON file ${JSON.stringify(path)}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliUsageError(`File ${JSON.stringify(path)} is not valid JSON: ${error instanceof Error ? error.message : "parse failure"}`);
  }
  if (!isRecord(parsed)) throw new CliUsageError(`File ${JSON.stringify(path)} must contain a JSON object.`);
  return parsed;
}

function generatedId(prefix: string, createId: () => string): string {
  return `${prefix}_${createId().replaceAll("-", "")}`;
}

function helpDocument() {
  return {
    name: "praxisctl",
    usage: "praxisctl <resource> <action> [options]",
    environment: [
      "PRAXIS_API_BASE_URL",
      "PRAXIS_CAPABILITY_TOKEN (preferred) or PRAXIS_OWNER_TOKEN",
      "PRAXIS_AGENT_SESSION_FILE (defaults to an owner-only OS runtime directory)",
    ],
    commands: [
      "project get --project <id>",
      "project undo --project <id> --base-revision <n> [--idempotency-key <key>]",
      "project redo --project <id> --base-revision <n> [--idempotency-key <key>]",
      "command apply --project <id> --file <command.json>",
      "checkpoint create --project <id> --base-revision <n> --label <text> [--idempotency-key <key>]",
      "checkpoint restore --project <id> --checkpoint <id> --base-revision <n> [--idempotency-key <key>]",
      "job list --project <id>",
      "job create --project <id> --file <job.json>",
      "job status --project <id> --job <id>",
      "job cancel --project <id> --job <id>",
      "agent claim --ticket <one-use-ticket> [--session-file <path>]",
      "agent context [--session-file <path>]",
      "agent heartbeat [--idempotency-key <key>] [--session-file <path>]",
      "agent finish --status <waiting_on_jobs|completed|failed> [--summary <text>] [--error-code <code>] [--error-message <text>] [--idempotency-key <key>] [--session-file <path>]",
    ],
    output: "JSON is written to stdout on success and stderr on failure.",
  };
}

function safeJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function redact(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => secret ? text.replaceAll(secret, "[REDACTED]") : text, value);
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /(?:ticket|token|authorization)/i.test(key)
        ? "[REDACTED]"
        : redact(entry, secrets),
    ]));
  }
  return value;
}

function sessionFilePath(
  arguments_: ParsedArguments,
  env: Readonly<Record<string, string | undefined>>,
  cwd: () => string,
): string {
  const configured = arguments_.values.get("session-file") ?? env.PRAXIS_AGENT_SESSION_FILE;
  if (configured) return resolve(cwd(), configured);
  const runtimeRoot = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeRoot) return resolve(runtimeRoot, "praxis", "agent-session.json");
  const userSuffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return resolve(tmpdir(), `praxis-${userSuffix}`, "agent-session.json");
}

function parseAgentSession(value: Record<string, unknown>, path: string): AgentSessionFile {
  if (
    value.version !== 1 ||
    typeof value.apiRoot !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.capabilityToken !== "string" ||
    value.capabilityToken.length < 32 ||
    typeof value.expiresAt !== "string"
  ) {
    throw new CliUsageError(`Agent session file ${JSON.stringify(path)} is invalid.`);
  }
  return value as unknown as AgentSessionFile;
}

async function readAgentSession(
  path: string,
  readFile: (path: string, encoding: "utf8") => Promise<string>,
): Promise<AgentSessionFile> {
  return parseAgentSession(await readJsonFile(path, readFile), path);
}

async function persistAgentSession(
  path: string,
  apiRoot: string,
  granted: ClaimAgentRunResponse | HeartbeatAgentRunResponse,
  temporaryId: string,
  writeFile: NonNullable<PraxisCliDependencies["writeFile"]>,
  mkdir: NonNullable<PraxisCliDependencies["mkdir"]>,
  chmod: NonNullable<PraxisCliDependencies["chmod"]>,
  rename: NonNullable<PraxisCliDependencies["rename"]>,
  unlink: NonNullable<PraxisCliDependencies["unlink"]>,
): Promise<void> {
  if (granted.capabilityToken.length < 32) {
    throw new Error("AgentRun capability token was shorter than the server security minimum.");
  }
  const session: AgentSessionFile = {
    version: 1,
    apiRoot,
    projectId: granted.run.projectId,
    runId: granted.run.id,
    capabilityToken: granted.capabilityToken,
    expiresAt: granted.expiresAt,
  };
  const directory = dirname(path);
  const suffix = temporaryId.replace(/[^A-Za-z0-9]/gu, "").slice(0, 64) || "session";
  const temporaryPath = `${path}.${suffix}.tmp`;
  let temporaryCreated = false;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    temporaryCreated = true;
    // writeFile's mode is creation-only; force an existing temp path back to owner-only.
    await chmod(temporaryPath, 0o600);
    // Same-directory rename replaces a stale file or symlink atomically without following it.
    await rename(temporaryPath, path);
    temporaryCreated = false;
    await chmod(path, 0o600);
  } catch (error) {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function writeJson(
  stream: WritableLike,
  value: unknown,
  pretty: boolean,
  secrets: readonly string[],
): void {
  stream.write(`${JSON.stringify(redact(safeJson(value), secrets), null, pretty ? 2 : undefined)}\n`);
}

function errorExit(error: unknown): number {
  if (error instanceof CliUsageError) return PRAXISCTL_EXIT.usage;
  if (error instanceof PraxisConflictError) return PRAXISCTL_EXIT.conflict;
  if (error instanceof PraxisApiError) {
    if (error.status === 401 || error.status === 403) return PRAXISCTL_EXIT.authentication;
    if (error.status === 404) return PRAXISCTL_EXIT.notFound;
    if (error.status === 400 || error.status === 422) return PRAXISCTL_EXIT.validation;
    if (error.code === "NETWORK_ERROR") return PRAXISCTL_EXIT.unavailable;
    return PRAXISCTL_EXIT.unavailable;
  }
  if (typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError") {
    return PRAXISCTL_EXIT.aborted;
  }
  return PRAXISCTL_EXIT.unavailable;
}

function errorDocument(error: unknown) {
  if (error instanceof PraxisConflictError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        expectedRevision: error.expectedRevision,
        currentRevision: error.currentRevision,
        changedEntityIds: error.changedEntityIds,
        lockedEntityIds: error.lockedEntityIds,
        retryable: error.retryable,
      },
    };
  }
  if (error instanceof PraxisApiError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        requestId: error.requestId,
        retryable: error.retryable,
      },
    };
  }
  if (error instanceof CliUsageError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "praxisctl failed.",
    },
  };
}

async function execute(
  arguments_: ParsedArguments,
  client: PraxisRemoteClient,
  readFile: (path: string, encoding: "utf8") => Promise<string>,
  createId: () => string,
  agentSession: AgentSessionFile | undefined,
  saveAgentSession: (granted: ClaimAgentRunResponse | HeartbeatAgentRunResponse) => Promise<string>,
): Promise<unknown> {
  const [resource, action, ...extraWords] = arguments_.words;
  if (!resource || !action || extraWords.length > 0) {
    throw new CliUsageError("Expected exactly one resource and one action. Use --help for command syntax.");
  }
  if (resource === "agent" && action === "claim") {
    assertNoUnknownOptions(arguments_, ["ticket", "session-file"]);
    const claimed = await client.claimAgentRun({ ticket: required(arguments_, "ticket") });
    const path = await saveAgentSession(claimed);
    return {
      run: claimed.run,
      expiresAt: claimed.expiresAt,
      sessionFile: path,
    };
  }

  if (resource === "agent" && action === "context") {
    assertNoUnknownOptions(arguments_, ["session-file"]);
    if (!agentSession) throw new CliUsageError("An AgentRun session is required. Run agent claim first.");
    return client.getAgentRunContext(agentSession.projectId, agentSession.runId);
  }

  if (resource === "agent" && action === "heartbeat") {
    assertNoUnknownOptions(arguments_, ["idempotency-key", "session-file"]);
    if (!agentSession) throw new CliUsageError("An AgentRun session is required. Run agent claim first.");
    const heartbeat = await client.heartbeatAgentRun(agentSession.projectId, agentSession.runId, {
      idempotencyKey: arguments_.values.get("idempotency-key") ?? generatedId("heartbeat", createId),
    });
    if (
      heartbeat.run.id !== agentSession.runId ||
      heartbeat.run.projectId !== agentSession.projectId ||
      !heartbeat.capabilityToken ||
      !heartbeat.expiresAt ||
      heartbeat.run.leaseExpiresAt !== heartbeat.expiresAt
    ) {
      throw new Error("AgentRun heartbeat did not return a matching rotated capability lease.");
    }
    const path = await saveAgentSession(heartbeat);
    return {
      run: heartbeat.run,
      eventSequence: heartbeat.eventSequence,
      idempotentReplay: heartbeat.idempotentReplay,
      expiresAt: heartbeat.expiresAt,
      sessionFile: path,
    };
  }

  if (resource === "agent" && action === "finish") {
    assertNoUnknownOptions(arguments_, [
      "status",
      "summary",
      "error-code",
      "error-message",
      "idempotency-key",
      "session-file",
    ]);
    if (!agentSession) throw new CliUsageError("An AgentRun session is required. Run agent claim first.");
    const status = required(arguments_, "status");
    if (status !== "waiting_on_jobs" && status !== "completed" && status !== "failed") {
      throw new CliUsageError("--status must be waiting_on_jobs, completed, or failed.");
    }
    if (status !== "failed" && (arguments_.values.has("error-code") || arguments_.values.has("error-message"))) {
      throw new CliUsageError("--error-code and --error-message are only valid with --status failed.");
    }
    return client.finishAgentRun(agentSession.projectId, agentSession.runId, {
      idempotencyKey: arguments_.values.get("idempotency-key") ?? generatedId("finish", createId),
      status,
      completionSummary: arguments_.values.get("summary"),
      errorCode: arguments_.values.get("error-code"),
      errorMessage: arguments_.values.get("error-message"),
    });
  }

  const projectId = required(arguments_, "project");
  if (agentSession && projectId !== agentSession.projectId) {
    throw new CliUsageError("The requested project does not match the claimed AgentRun session.");
  }

  if (resource === "project" && action === "get") {
    assertNoUnknownOptions(arguments_, ["project"]);
    return client.getProject(projectId);
  }

  if (resource === "command" && action === "apply") {
    assertNoUnknownOptions(arguments_, ["project", "file"]);
    const command = await readJsonFile(required(arguments_, "file"), readFile);
    return client.applyCommand(projectId, command as ApplyCommandRequest);
  }

  if (resource === "job" && action === "create") {
    assertNoUnknownOptions(arguments_, ["project", "file"]);
    const job = await readJsonFile(required(arguments_, "file"), readFile);
    return client.createJob(projectId, job as unknown as CreateJobRequest);
  }

  if (resource === "job" && action === "list") {
    assertNoUnknownOptions(arguments_, ["project"]);
    return client.listJobs(projectId);
  }

  if (resource === "job" && action === "status") {
    assertNoUnknownOptions(arguments_, ["project", "job"]);
    return client.getJob(projectId, required(arguments_, "job"));
  }

  if (resource === "job" && action === "cancel") {
    assertNoUnknownOptions(arguments_, ["project", "job"]);
    return client.cancelJob(projectId, required(arguments_, "job"));
  }

  if (resource === "project" && (action === "undo" || action === "redo")) {
    assertNoUnknownOptions(arguments_, ["project", "base-revision", "idempotency-key"]);
    const request = {
      baseRevision: integer(arguments_, "base-revision"),
      idempotencyKey: arguments_.values.get("idempotency-key") ?? generatedId(action, createId),
    };
    return action === "undo"
      ? client.undoProject(projectId, request)
      : client.redoProject(projectId, request);
  }

  if (resource === "checkpoint" && action === "create") {
    assertNoUnknownOptions(arguments_, ["project", "base-revision", "idempotency-key", "label"]);
    return client.createCheckpoint(projectId, {
      baseRevision: integer(arguments_, "base-revision"),
      idempotencyKey: arguments_.values.get("idempotency-key") ?? generatedId("checkpoint", createId),
      label: required(arguments_, "label"),
    });
  }

  if (resource === "checkpoint" && action === "restore") {
    assertNoUnknownOptions(arguments_, ["project", "checkpoint", "base-revision", "idempotency-key", "reason"]);
    return client.restoreCheckpoint(
      projectId,
      required(arguments_, "checkpoint"),
      {
        baseRevision: integer(arguments_, "base-revision"),
        idempotencyKey: arguments_.values.get("idempotency-key") ?? generatedId("restore", createId),
        reason: arguments_.values.get("reason"),
      },
    );
  }

  throw new CliUsageError(`Unknown command ${JSON.stringify(`${resource} ${action}`)}. Use --help for command syntax.`);
}

export async function runPraxisCli(
  argv: readonly string[],
  dependencies: PraxisCliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const io = dependencies.io ?? defaultIo;
  const readFile = dependencies.readFile ?? readFileFromDisk;
  const writeFile = dependencies.writeFile ?? (async (path, data, options) => {
    await writeFileToDisk(path, data, options);
  });
  const mkdir = dependencies.mkdir ?? (async (path, options) => {
    await mkdirOnDisk(path, options);
  });
  const chmod = dependencies.chmod ?? chmodOnDisk;
  const rename = dependencies.rename ?? renameOnDisk;
  const unlink = dependencies.unlink ?? unlinkOnDisk;
  const cwd = dependencies.cwd ?? process.cwd;
  const createId = dependencies.createId ?? randomUUID;
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    writeJson(io.stderr, errorDocument(error), false, []);
    return errorExit(error);
  }
  const pretty = parsed.switches.has("pretty");
  if (parsed.switches.has("help")) {
    writeJson(io.stdout, { ok: true, result: helpDocument() }, pretty, []);
    return PRAXISCTL_EXIT.success;
  }

  const baseUrl = env.PRAXIS_API_BASE_URL;
  const configuredToken = env.PRAXIS_CAPABILITY_TOKEN ?? env.PRAXIS_OWNER_TOKEN;
  const claimTicket = parsed.values.get("ticket");
  const isAgentClaim = parsed.words[0] === "agent" && parsed.words[1] === "claim";
  const isAgentSessionCommand = parsed.words[0] === "agent" && [
    "context",
    "heartbeat",
    "finish",
  ].includes(parsed.words[1] ?? "");
  const needsAgentSession = isAgentSessionCommand || (!configuredToken && !isAgentClaim);
  const path = sessionFilePath(parsed, env, cwd);
  const secrets = [configuredToken, claimTicket].filter((value): value is string => Boolean(value));
  try {
    if (!baseUrl) throw new CliUsageError("PRAXIS_API_BASE_URL is required.");
    let agentSession: AgentSessionFile | undefined;
    if (needsAgentSession) {
      agentSession = await readAgentSession(path, readFile);
      secrets.push(agentSession.capabilityToken);
    }
    const token = isAgentSessionCommand
      ? agentSession?.capabilityToken
      : isAgentClaim
        ? undefined
        : configuredToken ?? agentSession?.capabilityToken;
    if (!token && !isAgentClaim) {
      throw new CliUsageError("PRAXIS_CAPABILITY_TOKEN or PRAXIS_OWNER_TOKEN is required.");
    }
    const client = new PraxisRemoteClient({ baseUrl, token, fetch: dependencies.fetch });
    if (agentSession && agentSession.apiRoot !== client.apiRoot) {
      throw new CliUsageError("The AgentRun session belongs to a different Praxis API base URL.");
    }
    const result = await execute(
      parsed,
      client,
      readFile,
      createId,
      agentSession,
      async (claimed) => {
        secrets.push(claimed.capabilityToken);
        await persistAgentSession(
          path,
          client.apiRoot,
          claimed,
          createId(),
          writeFile,
          mkdir,
          chmod,
          rename,
          unlink,
        );
        return path;
      },
    );
    writeJson(io.stdout, { ok: true, result }, pretty, secrets);
    return PRAXISCTL_EXIT.success;
  } catch (error) {
    writeJson(io.stderr, errorDocument(error), pretty, secrets);
    return errorExit(error);
  }
}

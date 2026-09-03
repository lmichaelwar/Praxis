import type { CloudTaskDispatcher, CloudTaskSubmission } from "./dispatcher";
import { CloudDispatcherError } from "./dispatcher";
import { buildDispatchPrompt } from "./prompt";
import type { DispatchControlPlane } from "./praxis-client";
import type {
  AgentRunStage,
  CloudTask,
  DispatchAttemptResult,
  DispatchIterationResult,
  DispatchLease,
  DispatchableAgentRun,
  ReconciliationCandidate,
} from "./types";

export interface DispatchLogger {
  info(event: string, fields?: Readonly<Record<string, string | number | boolean | undefined>>): void;
  warn(event: string, fields?: Readonly<Record<string, string | number | boolean | undefined>>): void;
  error(event: string, fields?: Readonly<Record<string, string | number | boolean | undefined>>): void;
}

export const jsonLineLogger: DispatchLogger = {
  info: (event, fields = {}) => process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`),
  warn: (event, fields = {}) => process.stdout.write(`${JSON.stringify({ level: "warn", event, ...fields })}\n`),
  error: (event, fields = {}) => process.stderr.write(`${JSON.stringify({ level: "error", event, ...fields })}\n`),
};

export interface CorrelationResult {
  readonly task?: CloudTask;
  readonly candidateTaskIds: readonly string[];
  readonly reasonCode: string;
}

const taskContainsMarker = (task: CloudTask, runId: string, attemptId: string): boolean => {
  const searchable = `${task.title}\n${task.summary ?? ""}`;
  const containsStableId = (id: string) => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9:_-])${escaped}($|[^A-Za-z0-9:_-])`, "u").test(searchable);
  };
  return containsStableId(attemptId) && containsStableId(runId);
};

/**
 * Correlation is intentionally conservative. An explicit exec identity wins;
 * otherwise an immutable marker must identify exactly one task, or exactly one
 * task may have appeared between the before/after snapshots.
 */
export const correlateCloudTask = (input: {
  readonly before?: readonly CloudTask[];
  readonly after: readonly CloudTask[];
  readonly submission?: CloudTaskSubmission;
  readonly knownTaskId?: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly allowSingleNewTask: boolean;
}): CorrelationResult => {
  const byId = new Map(input.after.map((task) => [task.id, task]));
  if (input.knownTaskId) {
    const known = byId.get(input.knownTaskId);
    return known
      ? { task: known, candidateTaskIds: [known.id], reasonCode: "EXPLICIT_TASK_ID" }
      : { candidateTaskIds: [input.knownTaskId], reasonCode: "KNOWN_TASK_NOT_VISIBLE" };
  }

  const explicitId = input.submission?.taskId;
  if (explicitId) {
    const listed = byId.get(explicitId);
    if (listed) return { task: listed, candidateTaskIds: [listed.id], reasonCode: "EXPLICIT_TASK_ID" };
    if (input.submission?.taskId && input.submission.taskUrl) {
      return {
        task: {
          id: input.submission.taskId,
          url: input.submission.taskUrl,
          title: "",
          status: "submitted",
          updatedAt: input.submission.submittedAt,
          environmentId: "unknown",
        },
        candidateTaskIds: [input.submission.taskId],
        reasonCode: "EXEC_TASK_ID",
      };
    }
  }

  const marked = input.after.filter((task) => taskContainsMarker(task, input.runId, input.attemptId));
  if (marked.length === 1) return { task: marked[0], candidateTaskIds: [marked[0]!.id], reasonCode: "IMMUTABLE_MARKER" };
  if (marked.length > 1) return { candidateTaskIds: marked.map((task) => task.id), reasonCode: "AMBIGUOUS_MARKERS" };

  const beforeIds = new Set((input.before ?? []).map((task) => task.id));
  const newTasks = input.after.filter((task) => !beforeIds.has(task.id));
  if (input.allowSingleNewTask && newTasks.length === 1) {
    return { task: newTasks[0], candidateTaskIds: [newTasks[0]!.id], reasonCode: "SINGLE_NEW_TASK" };
  }
  return {
    candidateTaskIds: newTasks.map((task) => task.id).slice(0, 20),
    reasonCode: newTasks.length > 1 ? "AMBIGUOUS_NEW_TASKS" : "TASK_NOT_VISIBLE",
  };
};

const STAGE_OBJECTIVES: Readonly<Record<AgentRunStage, string>> = {
  treatment: "developing or refining the treatment",
  script: "revising the script",
  previz: "refining the scene plan and previz",
  assets: "creating or managing permitted production assets",
  edit: "constructing or refining the permitted edit",
  finish: "performing permitted finishing work",
};

const joinedStageWork = (stages: readonly AgentRunStage[]): string => {
  const work = stages.map((stage) => STAGE_OBJECTIVES[stage]);
  if (work.length === 1) return work[0]!;
  if (work.length === 2) return `${work[0]} and ${work[1]}`;
  return `${work.slice(0, -1).join(", ")}, and ${work.at(-1)}`;
};

const defaultObjective = (run: DispatchableAgentRun): string => {
  const stageNames = run.stages.join(", ");
  const stageWork = joinedStageWork(run.stages);
  if (run.role === "reviewer") {
    return `Review only the delegated stages (${stageNames}), focusing on ${stageWork}, and provide bounded proposals for director review without committing changes or enqueueing jobs.`;
  }
  return run.mode === "propose"
    ? `Prepare bounded proposals only for the delegated stages (${stageNames}), focusing on ${stageWork}; do not commit changes or enqueue jobs.`
    : `Advance only the delegated stages (${stageNames}) by ${stageWork}, using permitted revisioned commands and only jobs required for those stages while preserving locked entities.`;
};

const publicErrorCode = (error: unknown, fallback: string): string => {
  if (error instanceof CloudDispatcherError && /^[A-Z0-9_]{2,80}$/u.test(error.code)) return error.code;
  return fallback;
};

const resultFor = (
  dispatcherId: string,
  outcome: DispatchAttemptResult["outcome"],
  reasonCode: string,
  now: () => Date,
  extra: Pick<DispatchAttemptResult, "codexTaskId" | "codexTaskUrl" | "candidateTaskIds"> = {},
): DispatchAttemptResult => ({
  dispatcherId,
  outcome,
  observedAt: now().toISOString(),
  reasonCode,
  ...(extra.codexTaskId ? { codexTaskId: extra.codexTaskId } : {}),
  ...(extra.codexTaskUrl ? { codexTaskUrl: extra.codexTaskUrl } : {}),
  ...(extra.candidateTaskIds?.length ? { candidateTaskIds: extra.candidateTaskIds.slice(0, 20) } : {}),
});

export interface DispatchServiceOptions {
  readonly dispatcherId: string;
  readonly controlPlane: DispatchControlPlane;
  readonly cloud: CloudTaskDispatcher;
  readonly reconciliationMaxPages?: number;
  readonly logger?: DispatchLogger;
  readonly now?: () => Date;
  readonly objectiveForRun?: (run: DispatchableAgentRun) => string;
}

export class DispatchService {
  private readonly dispatcherId: string;
  private readonly controlPlane: DispatchControlPlane;
  private readonly cloud: CloudTaskDispatcher;
  private readonly reconciliationMaxPages: number;
  private readonly logger: DispatchLogger;
  private readonly now: () => Date;
  private readonly objectiveForRun: (run: DispatchableAgentRun) => string;

  constructor(options: DispatchServiceOptions) {
    this.dispatcherId = options.dispatcherId;
    this.controlPlane = options.controlPlane;
    this.cloud = options.cloud;
    this.reconciliationMaxPages = options.reconciliationMaxPages ?? 5;
    if (!Number.isSafeInteger(this.reconciliationMaxPages) || this.reconciliationMaxPages < 1 || this.reconciliationMaxPages > 20) {
      throw new TypeError("Reconciliation page limit must be between 1 and 20");
    }
    this.logger = options.logger ?? jsonLineLogger;
    this.now = options.now ?? (() => new Date());
    this.objectiveForRun = options.objectiveForRun ?? defaultObjective;
  }

  private async persist(
    runId: string,
    attemptId: string,
    result: DispatchAttemptResult,
    signal?: AbortSignal,
  ): Promise<DispatchIterationResult> {
    await this.controlPlane.recordResult(runId, attemptId, result, signal);
    this.logger.info("dispatch_attempt_recorded", {
      runId,
      attemptId,
      outcome: result.outcome,
      reasonCode: result.reasonCode,
      codexTaskId: result.codexTaskId,
    });
    return { kind: "processed", runId, attemptId, result };
  }

  async dispatchLease(lease: DispatchLease, signal?: AbortSignal): Promise<DispatchIterationResult> {
    const { run, attemptId } = lease;
    if (Date.parse(run.claimExpiresAt) <= this.now().getTime()) {
      return this.persist(run.id, attemptId, resultFor(
        this.dispatcherId,
        "not_submitted",
        "CLAIM_TICKET_EXPIRED",
        this.now,
      ), signal);
    }

    let before;
    try {
      before = await this.cloud.listTasks({ limit: 20, signal });
    } catch (error) {
      return this.persist(run.id, attemptId, resultFor(
        this.dispatcherId,
        "not_submitted",
        publicErrorCode(error, "PRE_LIST_FAILED"),
        this.now,
      ), signal);
    }

    let prompt;
    try {
      prompt = buildDispatchPrompt({
        lease,
        praxisApiBaseUrl: this.controlPlane.publicBaseUrl,
        objective: this.objectiveForRun(run),
      });
    } catch {
      return this.persist(run.id, attemptId, resultFor(
        this.dispatcherId,
        "not_submitted",
        "PROMPT_INVALID",
        this.now,
      ), signal);
    }

    let submission: CloudTaskSubmission | undefined;
    let submissionError: unknown;
    try {
      submission = await this.cloud.submit({ prompt, signal });
    } catch (error) {
      submissionError = error;
    }

    let after;
    try {
      after = await this.cloud.listTasks({ limit: 20, signal });
    } catch (listError) {
      if (submission?.taskId && submission.taskUrl) {
        return this.persist(run.id, attemptId, resultFor(
          this.dispatcherId,
          "dispatched",
          "EXEC_TASK_ID",
          this.now,
          { codexTaskId: submission.taskId, codexTaskUrl: submission.taskUrl },
        ), signal);
      }
      const mayHaveSubmitted = !submissionError || (
        submissionError instanceof CloudDispatcherError && submissionError.submissionMayHaveOccurred
      );
      return this.persist(run.id, attemptId, resultFor(
        this.dispatcherId,
        mayHaveSubmitted ? "dispatch_unknown" : "not_submitted",
        publicErrorCode(listError, "POST_LIST_FAILED"),
        this.now,
      ), signal);
    }

    const correlation = correlateCloudTask({
      before: before.tasks,
      after: after.tasks,
      submission,
      runId: run.id,
      attemptId,
      allowSingleNewTask: true,
    });
    if (correlation.task) {
      return this.persist(run.id, attemptId, resultFor(
        this.dispatcherId,
        "dispatched",
        correlation.reasonCode,
        this.now,
        {
          codexTaskId: correlation.task.id,
          codexTaskUrl: correlation.task.url,
          candidateTaskIds: correlation.candidateTaskIds,
        },
      ), signal);
    }

    const definitelyRejected = submissionError instanceof CloudDispatcherError
      && !submissionError.submissionMayHaveOccurred;
    return this.persist(run.id, attemptId, resultFor(
      this.dispatcherId,
      definitelyRejected ? "not_submitted" : "dispatch_unknown",
      submissionError
        ? publicErrorCode(submissionError, "CLOUD_EXEC_FAILED")
        : correlation.reasonCode,
      this.now,
      { candidateTaskIds: correlation.candidateTaskIds },
    ), signal);
  }

  async reconcileCandidate(
    candidate: ReconciliationCandidate,
    tasks: readonly CloudTask[],
    signal?: AbortSignal,
  ): Promise<DispatchIterationResult | undefined> {
    if (candidate.run.status === "dispatching" && candidate.run.codexTaskId && candidate.run.codexTaskUrl) return undefined;
    const correlation = correlateCloudTask({
      after: tasks,
      knownTaskId: candidate.run.codexTaskId,
      runId: candidate.run.id,
      attemptId: candidate.attemptId,
      allowSingleNewTask: false,
    });
    if (correlation.task) {
      return this.persist(candidate.run.id, candidate.attemptId, resultFor(
        this.dispatcherId,
        "dispatched",
        `RECONCILED_${correlation.reasonCode}`,
        this.now,
        {
          codexTaskId: correlation.task.id,
          codexTaskUrl: correlation.task.url,
          candidateTaskIds: correlation.candidateTaskIds,
        },
      ), signal);
    }

    // A miss is not evidence that a submitted task does not exist. In
    // particular, the cloud task may already have claimed or completed the run
    // before its identity becomes visible to `codex cloud list`. Preserve those
    // durable states and only mark a still-dispatching, identity-less run as
    // ambiguous after a dispatcher restart.
    if (candidate.run.status !== "dispatching" || candidate.run.codexTaskId) return undefined;
    return this.persist(candidate.run.id, candidate.attemptId, resultFor(
      this.dispatcherId,
      "dispatch_unknown",
      `RECONCILE_${correlation.reasonCode}`,
      this.now,
      { candidateTaskIds: correlation.candidateTaskIds },
    ), signal);
  }

  private async listReconciliationTasks(signal?: AbortSignal): Promise<readonly CloudTask[]> {
    const tasks = new Map<string, CloudTask>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 1; pageNumber <= this.reconciliationMaxPages; pageNumber += 1) {
      const page = await this.cloud.listTasks({
        limit: 20,
        ...(cursor ? { cursor } : {}),
        signal,
      });
      for (const task of page.tasks.slice(0, 20)) {
        if (!tasks.has(task.id)) tasks.set(task.id, task);
      }
      if (!page.cursor) return [...tasks.values()];
      if (seenCursors.has(page.cursor)) {
        this.logger.warn("dispatch_reconciliation_cursor_loop", {
          pagesScanned: pageNumber,
          tasksScanned: tasks.size,
        });
        return [...tasks.values()];
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    this.logger.warn("dispatch_reconciliation_page_limit", {
      maxPages: this.reconciliationMaxPages,
      tasksScanned: tasks.size,
    });
    return [...tasks.values()];
  }

  async reconcileOutstanding(signal?: AbortSignal): Promise<readonly DispatchIterationResult[]> {
    const candidates = await this.controlPlane.listReconciliationCandidates(signal);
    const actionable = candidates.filter((candidate) =>
      candidate.run.status === "dispatch_unknown"
      || !candidate.run.codexTaskId
      || !candidate.run.codexTaskUrl);
    if (!actionable.length) return [];
    const tasks = await this.listReconciliationTasks(signal);
    const results: DispatchIterationResult[] = [];
    for (const candidate of actionable) {
      const result = await this.reconcileCandidate(candidate, tasks, signal);
      if (result) results.push(result);
    }
    return results;
  }

  async runOnce(signal?: AbortSignal): Promise<DispatchIterationResult> {
    const reconciled = await this.reconcileOutstanding(signal);
    const lease = await this.controlPlane.leaseNext(signal);
    if (!lease) return reconciled[0] ?? { kind: "idle" };
    return this.dispatchLease(lease, signal);
  }
}

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export interface DispatchPollLoopOptions {
  readonly service: DispatchService;
  readonly pollIntervalMs: number;
  readonly logger?: DispatchLogger;
}

export class DispatchPollLoop {
  private readonly service: DispatchService;
  private readonly pollIntervalMs: number;
  private readonly logger: DispatchLogger;

  constructor(options: DispatchPollLoopOptions) {
    if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 250 || options.pollIntervalMs > 60_000) {
      throw new TypeError("Dispatcher polling interval must be between 250 and 60000 milliseconds");
    }
    this.service = options.service;
    this.pollIntervalMs = options.pollIntervalMs;
    this.logger = options.logger ?? jsonLineLogger;
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let result: DispatchIterationResult | undefined;
      try {
        result = await this.service.runOnce(signal);
      } catch (error) {
        this.logger.error("dispatch_iteration_failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
      if (!result || result.kind === "idle") await wait(this.pollIntervalMs, signal);
    }
  }
}

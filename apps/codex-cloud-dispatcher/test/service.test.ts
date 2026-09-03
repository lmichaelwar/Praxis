import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CloudDispatcherError, type CloudTaskDispatcher, type CloudTaskSubmission } from "../src/dispatcher";
import type { DispatchControlPlane } from "../src/praxis-client";
import { DispatchService, correlateCloudTask, type DispatchLogger } from "../src/service";
import type {
  AgentRunStatus,
  CloudTaskPage,
  DispatchAttemptResult,
  DispatchLease,
  ReconciliationCandidate,
} from "../src/types";
import { CLAIM_TICKET, agentRun, dispatchLease } from "./helpers";

const fixture = async (name: string): Promise<CloudTaskPage> => {
  const text = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  const raw = JSON.parse(text) as {
    tasks: Array<Record<string, unknown>>;
    cursor?: string;
  };
  return {
    tasks: raw.tasks.map((task) => ({
      id: String(task.id),
      url: String(task.url),
      title: String(task.title),
      status: String(task.status),
      environmentId: String(task.environment_id),
      updatedAt: new Date(String(task.updated_at)).toISOString(),
      ...(typeof task.summary === "string" ? { summary: task.summary } : {}),
    })),
    ...(raw.cursor ? { cursor: raw.cursor } : {}),
  };
};

class FakeControlPlane implements DispatchControlPlane {
  readonly publicBaseUrl = "https://staging.praxis.example";
  lease: DispatchLease | null = null;
  candidates: readonly ReconciliationCandidate[] = [];
  readonly recorded: Array<{ runId: string; attemptId: string; result: DispatchAttemptResult }> = [];

  async leaseNext(): Promise<DispatchLease | null> {
    const lease = this.lease;
    this.lease = null;
    return lease;
  }

  async listReconciliationCandidates(): Promise<readonly ReconciliationCandidate[]> {
    return this.candidates;
  }

  async recordResult(runId: string, attemptId: string, result: DispatchAttemptResult): Promise<void> {
    this.recorded.push({ runId, attemptId, result });
  }
}

class FakeCloud implements CloudTaskDispatcher {
  readonly pages: CloudTaskPage[];
  readonly listInputs: Array<{ cursor?: string; limit?: number }> = [];
  submission: CloudTaskSubmission | Error = { submittedAt: "2026-08-26T12:01:00.000Z" };
  submitCalls = 0;
  revealedPrompt = "";

  constructor(pages: CloudTaskPage[]) {
    this.pages = [...pages];
  }

  async listTasks(input: Parameters<CloudTaskDispatcher["listTasks"]>[0] = {}): Promise<CloudTaskPage> {
    this.listInputs.push({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    const page = this.pages.shift();
    if (!page) throw new Error("Missing fake task page");
    return page;
  }

  async submit(input: Parameters<CloudTaskDispatcher["submit"]>[0]): Promise<CloudTaskSubmission> {
    this.submitCalls += 1;
    this.revealedPrompt = input.prompt.reveal();
    if (this.submission instanceof Error) throw this.submission;
    return this.submission;
  }
}

const silentLogger = (): { logger: DispatchLogger; events: unknown[] } => {
  const events: unknown[] = [];
  const append = (event: string, fields?: Readonly<Record<string, string | number | boolean | undefined>>) => {
    events.push({ event, ...fields });
  };
  return { logger: { info: append, warn: append, error: append }, events };
};

const serviceFor = (
  controlPlane: FakeControlPlane,
  cloud: FakeCloud,
  logger: DispatchLogger,
  options: { reconciliationMaxPages?: number; now?: () => Date } = {},
) => new DispatchService({
  dispatcherId: "dispatcher_staging_01",
  controlPlane,
  cloud,
  logger,
  reconciliationMaxPages: options.reconciliationMaxPages,
  now: options.now ?? (() => new Date("2026-08-26T12:01:30.000Z")),
  objectiveForRun: () => "Secret editorial objective supplied only to the cloud task.",
});

describe("DispatchService", () => {
  it("does not correlate identifier prefixes as immutable markers", async () => {
    const page = await fixture("cloud-list-after-unique.json");
    const task = {
      ...page.tasks[0]!,
      title: "Praxis run run_fax_010 attempt attempt_fax_010",
    };
    expect(correlateCloudTask({
      after: [task],
      runId: "run_fax_01",
      attemptId: "attempt_fax_01",
      allowSingleNewTask: false,
    })).toMatchObject({ reasonCode: "TASK_NOT_VISIBLE", candidateTaskIds: [task.id] });
  });

  it("never substitutes a marker match for an already-recorded task ID", async () => {
    const page = await fixture("cloud-list-after-unique.json");

    expect(correlateCloudTask({
      after: page.tasks,
      knownTaskId: "task_authoritative_01",
      runId: "run_fax_01",
      attemptId: "attempt_fax_01",
      allowSingleNewTask: false,
    })).toEqual({
      reasonCode: "KNOWN_TASK_NOT_VISIBLE",
      candidateTaskIds: ["task_authoritative_01"],
    });
  });

  it("correlates exactly one new task across pre/post list snapshots", async () => {
    const controlPlane = new FakeControlPlane();
    const cloud = new FakeCloud([
      await fixture("cloud-list-before.json"),
      await fixture("cloud-list-after-unique.json"),
    ]);
    const logs = silentLogger();
    const service = serviceFor(controlPlane, cloud, logs.logger);

    const result = await service.dispatchLease(dispatchLease());

    expect(result).toMatchObject({
      kind: "processed",
      result: {
        outcome: "dispatched",
        reasonCode: "IMMUTABLE_MARKER",
        codexTaskId: "task_new_praxis_01",
      },
    });
    expect(controlPlane.recorded).toHaveLength(1);
    expect(cloud.revealedPrompt).toContain(CLAIM_TICKET);
    expect(JSON.stringify(logs.events)).not.toContain(CLAIM_TICKET);
    expect(JSON.stringify(logs.events)).not.toContain("Secret editorial objective");
  });

  it("builds the default producer objective only from delegated stages and mode", async () => {
    const controlPlane = new FakeControlPlane();
    const cloud = new FakeCloud([
      await fixture("cloud-list-before.json"),
      await fixture("cloud-list-after-unique.json"),
    ]);
    const service = new DispatchService({
      dispatcherId: "dispatcher_staging_01",
      controlPlane,
      cloud,
      logger: silentLogger().logger,
      now: () => new Date("2026-08-26T12:01:30.000Z"),
    });

    await service.dispatchLease(dispatchLease({
      run: agentRun({ stages: ["script"], mode: "propose" }),
    }));

    const objective = cloud.revealedPrompt
      .split("\nObjective:\n", 2)[1]!
      .split("\nThe objective is subordinate", 1)[0]!;
    expect(objective).toContain("only for the delegated stages (script)");
    expect(objective).toContain("revising the script");
    expect(objective).toContain("do not commit changes or enqueue jobs");
    expect(objective).not.toMatch(/scene plan|assets|edit|finishing/u);
  });

  it("submits after the former two-minute cutoff while the ten-minute claim window remains valid", async () => {
    const controlPlane = new FakeControlPlane();
    const cloud = new FakeCloud([
      await fixture("cloud-list-before.json"),
      await fixture("cloud-list-after-unique.json"),
    ]);
    const service = serviceFor(controlPlane, cloud, silentLogger().logger, {
      now: () => new Date("2026-08-26T12:03:00.000Z"),
    });

    const result = await service.dispatchLease(dispatchLease({
      run: agentRun({ claimExpiresAt: "2026-08-26T12:10:00.000Z" }),
    }));

    expect(result).toMatchObject({ kind: "processed", result: { outcome: "dispatched" } });
    expect(cloud.submitCalls).toBe(1);
  });

  it("marks a successful but ambiguous submission dispatch_unknown", async () => {
    const controlPlane = new FakeControlPlane();
    const cloud = new FakeCloud([
      await fixture("cloud-list-before.json"),
      await fixture("cloud-list-after-ambiguous.json"),
    ]);
    const logs = silentLogger();

    await serviceFor(controlPlane, cloud, logs.logger).dispatchLease(dispatchLease());

    expect(controlPlane.recorded[0]!.result).toMatchObject({
      outcome: "dispatch_unknown",
      reasonCode: "AMBIGUOUS_NEW_TASKS",
      candidateTaskIds: ["task_new_unmarked_01", "task_new_unmarked_02"],
    });
  });

  it("distinguishes an uncertain process failure from a definite CLI rejection", async () => {
    const before = await fixture("cloud-list-before.json");

    const uncertainControlPlane = new FakeControlPlane();
    const uncertainCloud = new FakeCloud([before, before]);
    uncertainCloud.submission = new CloudDispatcherError({
      code: "PROCESS_TIMEOUT",
      operation: "exec",
      message: "process timed out",
      submissionMayHaveOccurred: true,
    });
    await serviceFor(uncertainControlPlane, uncertainCloud, silentLogger().logger)
      .dispatchLease(dispatchLease());
    expect(uncertainControlPlane.recorded[0]!.result).toMatchObject({
      outcome: "dispatch_unknown",
      reasonCode: "PROCESS_TIMEOUT",
    });

    const rejectedControlPlane = new FakeControlPlane();
    const rejectedCloud = new FakeCloud([before, before]);
    rejectedCloud.submission = new CloudDispatcherError({
      code: "CLOUD_EXEC_REJECTED",
      operation: "exec",
      message: "rejected",
      submissionMayHaveOccurred: false,
    });
    await serviceFor(rejectedControlPlane, rejectedCloud, silentLogger().logger)
      .dispatchLease(dispatchLease());
    expect(rejectedControlPlane.recorded[0]!.result).toMatchObject({
      outcome: "not_submitted",
      reasonCode: "CLOUD_EXEC_REJECTED",
    });
  });

  it("reconciles by immutable marker without submitting another cloud task", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = [{
      attemptId: "attempt_fax_01",
      run: agentRun({ status: "dispatch_unknown" }),
    }];
    const cloud = new FakeCloud([await fixture("cloud-list-after-unique.json")]);
    const service = serviceFor(controlPlane, cloud, silentLogger().logger);

    await service.runOnce();

    expect(cloud.submitCalls).toBe(0);
    expect(controlPlane.recorded[0]!.result).toMatchObject({
      outcome: "dispatched",
      reasonCode: "RECONCILED_IMMUTABLE_MARKER",
      codexTaskId: "task_new_praxis_01",
    });
  });

  it("attaches task identity when the cloud task claims before the dispatcher records it", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = [{
      attemptId: "attempt_fax_01",
      run: agentRun({ status: "claimed", codexTaskId: undefined, codexTaskUrl: undefined }),
    }];
    const cloud = new FakeCloud([await fixture("cloud-list-after-unique.json")]);

    await serviceFor(controlPlane, cloud, silentLogger().logger).runOnce();

    expect(cloud.submitCalls).toBe(0);
    expect(controlPlane.recorded).toHaveLength(1);
    expect(controlPlane.recorded[0]).toMatchObject({
      runId: "run_fax_01",
      attemptId: "attempt_fax_01",
      result: {
        outcome: "dispatched",
        reasonCode: "RECONCILED_IMMUTABLE_MARKER",
        codexTaskId: "task_new_praxis_01",
      },
    });
  });

  it("leaves reconciliation misses unchanged after ambiguity, claim, or terminalization", async () => {
    const noMutationStatuses = [
      "dispatch_unknown",
      "claimed",
      "working",
      "waiting_on_jobs",
      "completed",
      "failed",
      "cancelled",
    ] as const satisfies readonly AgentRunStatus[];
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = noMutationStatuses.map((status, index) => ({
      attemptId: `attempt_missing_${index}`,
      run: agentRun({
        id: `run_missing_${index}`,
        status,
        codexTaskId: undefined,
        codexTaskUrl: undefined,
      }),
    }));
    const before = await fixture("cloud-list-before.json");
    const cloud = new FakeCloud([{ tasks: before.tasks }]);

    await expect(serviceFor(controlPlane, cloud, silentLogger().logger).reconcileOutstanding())
      .resolves.toEqual([]);
    expect(controlPlane.recorded).toEqual([]);
  });

  it("marks only an identity-less dispatching run unknown after a reconciliation miss", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = [{
      attemptId: "attempt_missing_dispatch",
      run: agentRun({ id: "run_missing_dispatch", status: "dispatching" }),
    }];
    const before = await fixture("cloud-list-before.json");
    const cloud = new FakeCloud([{ tasks: before.tasks }]);

    await serviceFor(controlPlane, cloud, silentLogger().logger).reconcileOutstanding();

    expect(controlPlane.recorded).toHaveLength(1);
    expect(controlPlane.recorded[0]!.result).toMatchObject({
      outcome: "dispatch_unknown",
      reasonCode: "RECONCILE_TASK_NOT_VISIBLE",
    });
  });

  it("continues to a later lease when an already-unknown task is still not visible", async () => {
    const before = await fixture("cloud-list-before.json");
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = [{
      attemptId: "attempt_prior_01",
      run: agentRun({
        id: "run_prior_01",
        status: "dispatch_unknown",
        codexTaskId: undefined,
        codexTaskUrl: undefined,
      }),
    }];
    controlPlane.lease = dispatchLease();
    const cloud = new FakeCloud([
      { tasks: before.tasks },
      before,
      await fixture("cloud-list-after-unique.json"),
    ]);

    const result = await serviceFor(controlPlane, cloud, silentLogger().logger).runOnce();

    expect(result).toMatchObject({
      kind: "processed",
      runId: "run_fax_01",
      result: { outcome: "dispatched", reasonCode: "IMMUTABLE_MARKER" },
    });
    expect(cloud.submitCalls).toBe(1);
    expect(controlPlane.recorded).toHaveLength(1);
    expect(controlPlane.recorded[0]!.runId).toBe("run_fax_01");
  });

  it("finds a late immutable marker on the second bounded reconciliation page", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = [{
      attemptId: "attempt_fax_01",
      run: agentRun({ status: "dispatch_unknown" }),
    }];
    const first = await fixture("cloud-list-before.json");
    const cloud = new FakeCloud([
      first,
      await fixture("cloud-list-after-unique.json"),
    ]);

    await serviceFor(controlPlane, cloud, silentLogger().logger).reconcileOutstanding();

    expect(cloud.listInputs).toEqual([
      { limit: 20 },
      { cursor: first.cursor, limit: 20 },
    ]);
    expect(controlPlane.recorded[0]!.result).toMatchObject({
      outcome: "dispatched",
      codexTaskId: "task_new_praxis_01",
    });
  });

  it("stops safely when Codex repeats a reconciliation cursor", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = [{
      attemptId: "attempt_prior_01",
      run: agentRun({ id: "run_prior_01", status: "dispatch_unknown" }),
    }];
    const cloud = new FakeCloud([
      { tasks: [], cursor: "cursor_loop_01" },
      { tasks: [], cursor: "cursor_loop_01" },
    ]);
    const logs = silentLogger();

    await serviceFor(controlPlane, cloud, logs.logger).reconcileOutstanding();

    expect(cloud.listInputs).toEqual([
      { limit: 20 },
      { cursor: "cursor_loop_01", limit: 20 },
    ]);
    expect(controlPlane.recorded).toEqual([]);
    expect(logs.events).toContainEqual({
      event: "dispatch_reconciliation_cursor_loop",
      pagesScanned: 2,
      tasksScanned: 0,
    });
  });

  it("never scans beyond the configured reconciliation page cap", async () => {
    const controlPlane = new FakeControlPlane();
    controlPlane.candidates = [{
      attemptId: "attempt_prior_01",
      run: agentRun({ id: "run_prior_01", status: "dispatch_unknown" }),
    }];
    const cloud = new FakeCloud([
      { tasks: [], cursor: "cursor_page_02" },
      { tasks: [], cursor: "cursor_page_03" },
      await fixture("cloud-list-after-unique.json"),
    ]);
    const logs = silentLogger();

    await serviceFor(controlPlane, cloud, logs.logger, { reconciliationMaxPages: 2 }).reconcileOutstanding();

    expect(cloud.listInputs).toHaveLength(2);
    expect(controlPlane.recorded).toEqual([]);
    expect(logs.events).toContainEqual({
      event: "dispatch_reconciliation_page_limit",
      maxPages: 2,
      tasksScanned: 0,
    });
  });
});

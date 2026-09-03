import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CodexCloudCliDispatcher } from "../src/codex-cloud-cli";
import { buildDispatchPrompt } from "../src/prompt";
import type { ProcessInvocation, ProcessRunner, ProcessRunResult } from "../src/process-runner";
import { CLAIM_TICKET, dispatchLease } from "./helpers";

class QueueRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];
  readonly results: ProcessRunResult[];

  constructor(results: ProcessRunResult[]) {
    this.results = [...results];
  }

  async run(invocation: ProcessInvocation): Promise<ProcessRunResult> {
    this.invocations.push(invocation);
    const result = this.results.shift();
    if (!result) throw new Error("Missing fake process result");
    return result;
  }
}

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("CodexCloudCliDispatcher", () => {
  it("lists through fixed argv and parses the official JSON envelope", async () => {
    const runner = new QueueRunner([{ exitCode: 0, stdout: await fixture("cloud-list-before.json"), stderr: "" }]);
    const dispatcher = new CodexCloudCliDispatcher({
      environmentId: "env_praxis_staging",
      repositoryRoot: "/workspace/praxis",
      executable: "/usr/local/bin/codex",
      processRunner: runner,
      processEnvironment: {
        PATH: "/usr/local/bin:/usr/bin",
        HOME: "/home/dispatcher",
        CODEX_HOME: "/home/dispatcher/.codex",
        OPENAI_API_KEY: "must-not-cross",
        PRAXIS_DISPATCHER_TOKEN: "must-not-cross-either",
        CLOUDFLARE_API_TOKEN: "also-secret",
      },
    });

    const page = await dispatcher.listTasks({ cursor: "cursor_page_02", limit: 20 });

    expect(page.tasks).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({
      id: "task_existing_alpha",
      environmentId: "env_praxis_staging",
      attemptTotal: 1,
    });
    expect(runner.invocations[0]).toMatchObject({
      command: "/usr/local/bin/codex",
      args: ["cloud", "list", "--env", "env_praxis_staging", "--json", "--limit", "20", "--cursor", "cursor_page_02"],
      cwd: "/workspace/praxis",
      shell: false,
    });
    expect(runner.invocations[0]!.env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/home/dispatcher",
      CODEX_HOME: "/home/dispatcher/.codex",
    });
  });

  it("submits one protected prompt as one argv value and returns only a parsed task identity", async () => {
    const taskUrl = "https://chatgpt.com/codex/tasks/task_new_praxis_01";
    const runner = new QueueRunner([{ exitCode: 0, stdout: `Created ${taskUrl}\n`, stderr: "" }]);
    const dispatcher = new CodexCloudCliDispatcher({
      environmentId: "env_praxis_staging",
      repositoryRoot: "/workspace/praxis",
      branch: "staging",
      processRunner: runner,
      processEnvironment: { PATH: "/usr/bin", PRAXIS_DISPATCHER_TOKEN: "secret" },
      now: () => new Date("2026-08-26T12:01:00.000Z"),
    });
    const prompt = buildDispatchPrompt({
      lease: dispatchLease(),
      praxisApiBaseUrl: "https://staging.praxis.example",
      objective: "Build the delegated rough cut.",
    });

    await expect(dispatcher.submit({ prompt })).resolves.toEqual({
      submittedAt: "2026-08-26T12:01:00.000Z",
      taskId: "task_new_praxis_01",
      taskUrl,
    });
    const invocation = runner.invocations[0]!;
    expect(invocation.args.slice(0, -1)).toEqual([
      "cloud", "exec", "--env", "env_praxis_staging", "--attempts", "1", "--branch", "staging",
    ]);
    expect(invocation.args.at(-1)).toBe(prompt.reveal());
    expect(invocation.args.at(-1)).toContain(CLAIM_TICKET);
    expect(invocation.env).toEqual({ PATH: "/usr/bin" });
    expect(JSON.stringify({ ...invocation, args: invocation.args.slice(0, -1) })).not.toContain(CLAIM_TICKET);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  PraxisConflictError,
  PraxisRemoteClient,
  type ApplyCommandRequest,
  type FetchLike,
} from "../src";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const command = {
  commandId: "command_remote_01",
  idempotencyKey: "remote-command-once",
  projectId: "project_fax_oracle",
  baseRevision: 1,
  actor: { kind: "codex", sessionId: "session_remote_01" },
  operations: [{ type: "scene.setStatus", sceneId: "scene_04", status: "approved" }],
} as ApplyCommandRequest;

const agentRun = {
  id: "run_remote_01",
  projectId: "project_fax_oracle",
  checkpointId: "checkpoint_remote_01",
  baseRevision: 7,
  role: "producer-editor" as const,
  stages: ["script", "previz", "edit"] as const,
  mode: "act" as const,
  status: "created" as const,
  scopes: ["project:read" as const, "command:write" as const],
  deniedEntityIds: ["scene_03"],
  maxSpendUsd: 1,
  claimExpiresAt: "2026-08-26T21:10:00.000Z",
  createdAt: "2026-08-26T21:00:00.000Z",
  updatedAt: "2026-08-26T21:00:00.000Z",
};

describe("PraxisRemoteClient", () => {
  it("uses the API root, bearer capability, and caller command envelope", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({
        project: { projectId: "project_fax_oracle", revision: 2 },
        revision: 2,
        commandId: "command_remote_01",
        affectedEntityIds: ["scene_04"],
        staleEntityIds: [],
        eventSequence: 8,
        idempotentReplay: false,
      });
    };
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test",
      token: "capability-secret",
      fetch,
    });

    const result = await client.applyCommand("project_fax_oracle", command);

    expect(result.revision).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://praxis.test/api/projects/project_fax_oracle/commands");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.credentials).toBe("include");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer capability-secret");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(command);
  });

  it("forwards an explicit Codex checkpoint attribution downgrade", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({
          project: { projectId: "project_fax_oracle", revision: 2 },
          revision: 2,
          commandId: "command_checkpoint_remote_01",
          checkpointId: "checkpoint_remote_01",
          affectedEntityIds: ["checkpoint_remote_01"],
          staleEntityIds: [],
          idempotentReplay: false,
        });
      },
    });

    await client.createCheckpoint("project_fax_oracle", {
      baseRevision: 1,
      idempotencyKey: "checkpoint-remote-once",
      checkpointId: "checkpoint_remote_01",
      label: "WebMCP checkpoint",
      actor: { kind: "codex" },
    });

    expect(calls[0]?.url).toBe("https://praxis.test/api/projects/project_fax_oracle/checkpoints");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      checkpointId: "checkpoint_remote_01",
      actor: { kind: "codex" },
    });
  });

  it("returns a structured revision conflict", async () => {
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test/api",
      fetch: async () => jsonResponse({
        code: "REVISION_CONFLICT",
        message: "Project advanced.",
        expectedRevision: 1,
        currentRevision: 3,
        changedEntityIds: ["scene_04"],
        lockedEntityIds: ["scene_03"],
      }, 409),
    });

    try {
      await client.applyCommand("project_fax_oracle", command);
      expect.fail("Expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(PraxisConflictError);
      const conflict = error as PraxisConflictError;
      expect(conflict.code).toBe("REVISION_CONFLICT");
      expect(conflict.expectedRevision).toBe(1);
      expect(conflict.currentRevision).toBe(3);
      expect(conflict.changedEntityIds).toEqual(["scene_04"]);
      expect(conflict.lockedEntityIds).toEqual(["scene_03"]);
    }
  });

  it("targets durable job get and cancel endpoints", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetch: FetchLike = async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return jsonResponse({ job: { jobId: "job_7", status: "cancel_requested" } });
    };
    const client = new PraxisRemoteClient({ baseUrl: "https://praxis.test", fetch });

    await client.getJob("project 1", "job/7");
    await client.cancelJob("project 1", "job/7");

    expect(calls).toEqual([
      { url: "https://praxis.test/api/projects/project%201/jobs/job%2F7", method: "GET" },
      { url: "https://praxis.test/api/projects/project%201/jobs/job%2F7/cancel", method: "POST" },
    ]);
  });

  it("exchanges an Access identity for an HttpOnly browser session without bearer leakage", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test/api",
      token: "owner-token-must-not-be-sent",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ ok: true, expiresAt: "2026-08-27T05:00:00.000Z" });
      },
    });

    await client.createBrowserSession();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://praxis.test/auth/session");
    expect(calls[0]?.init).toMatchObject({ method: "POST", credentials: "include", body: "{}" });
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBeNull();
  });

  it("refreshes an expired cookie session once and retries the original browser request", async () => {
    const calls: string[] = [];
    let projectAttempts = 0;
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test",
      refreshBrowserSessionOnUnauthorized: true,
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/auth/session")) {
          return jsonResponse({ ok: true, expiresAt: "2026-08-27T05:00:00.000Z" }, 201);
        }
        projectAttempts += 1;
        if (projectAttempts === 1) {
          return jsonResponse({ code: "AUTH_INVALID", message: "Browser session expired." }, 401);
        }
        return jsonResponse({ project: { projectId: "project_fax_oracle", revision: 9 } });
      },
    });

    await expect(client.getProject("project_fax_oracle")).resolves.toMatchObject({
      project: { revision: 9 },
    });
    expect(calls).toEqual([
      "https://praxis.test/api/projects/project_fax_oracle",
      "https://praxis.test/auth/session",
      "https://praxis.test/api/projects/project_fax_oracle",
    ]);
  });

  it("refreshes an expired cookie session before consuming the browser event stream", async () => {
    const calls: string[] = [];
    const encoder = new TextEncoder();
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test",
      refreshBrowserSessionOnUnauthorized: true,
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/auth/session")) {
          return jsonResponse({ ok: true, expiresAt: "2026-08-27T05:00:00.000Z" }, 201);
        }
        if (calls.filter((candidate) => candidate.includes("/events?")).length === 1) {
          return jsonResponse({ code: "AUTH_INVALID", message: "Browser session expired." }, 401);
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              "id: 1\nevent: project.committed\ndata: {\"sequence\":1,\"type\":\"project.committed\",\"revision\":2,\"commandId\":\"cmd_2\"}\n\n",
            ));
            controller.close();
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const events: number[] = [];

    const subscription = client.subscribeProjectEvents("project_fax_oracle", {
      reconnect: false,
      onEvent: (event) => { events.push(event.sequence); },
    });
    await subscription.done;

    expect(events).toEqual([1]);
    expect(calls).toEqual([
      "https://praxis.test/api/projects/project_fax_oracle/events?afterSequence=0",
      "https://praxis.test/auth/session",
      "https://praxis.test/api/projects/project_fax_oracle/events?afterSequence=0",
    ]);
  });

  it("uses the durable AgentRun endpoints and keeps claim bearer-free", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test",
      token: "run-capability",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        const url = String(input);
        if (url.endsWith("/claim")) {
          return jsonResponse({
            run: { ...agentRun, status: "claimed", leaseExpiresAt: "2026-08-26T21:15:00.000Z" },
            capabilityToken: "short-lived-agent-capability",
            expiresAt: "2026-08-26T21:15:00.000Z",
          });
        }
        if (url.endsWith("/heartbeat")) {
          return jsonResponse({
            run: {
              ...agentRun,
              status: "working",
              leaseExpiresAt: "2026-08-26T21:45:00.000Z",
              lastHeartbeatAt: "2026-08-26T21:15:00.000Z",
              updatedAt: "2026-08-26T21:15:00.000Z",
            },
            capabilityToken: "rotated-agent-capability",
            expiresAt: "2026-08-26T21:45:00.000Z",
          });
        }
        if (url.endsWith("/agent-runs")) return jsonResponse({ runs: [agentRun] });
        return jsonResponse({ run: agentRun });
      },
    });

    await client.createAgentRun("project_fax_oracle", {
      idempotencyKey: "agent-run-once",
      baseRevision: 7,
      role: "producer-editor",
      stages: ["script", "previz", "edit"],
      mode: "act",
      scopes: ["project:read", "command:write"],
      deniedEntityIds: ["scene_03"],
      maxSpendUsd: 1,
    });
    await client.listAgentRuns("project_fax_oracle");
    await client.getAgentRun("project_fax_oracle", "run_remote_01");
    await client.getAgentRunContext("project_fax_oracle", "run_remote_01");
    const heartbeat = await client.heartbeatAgentRun("project_fax_oracle", "run_remote_01", {
      idempotencyKey: "heartbeat-once",
    });
    await client.finishAgentRun("project_fax_oracle", "run_remote_01", {
      idempotencyKey: "finish-run-once",
      status: "waiting_on_jobs",
      completionSummary: "Rough cut queued.",
    });
    await client.cancelAgentRun("project_fax_oracle", "run_remote_01", {
      idempotencyKey: "cancel-run-once",
    });
    await client.claimAgentRun({ ticket: "claim-ticket-value-that-is-long-enough" });

    expect(calls.map(({ url }) => url)).toEqual([
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_remote_01",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_remote_01/context",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_remote_01/heartbeat",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_remote_01/finish",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_remote_01/cancel",
      "https://praxis.test/api/agent-runs/claim",
    ]);
    expect(new Headers(calls.at(-1)?.init?.headers).get("authorization")).toBeNull();
    expect(calls.every(({ init }) => init?.credentials === "include")).toBe(true);
    expect(heartbeat).toMatchObject({
      run: { status: "working" },
      capabilityToken: "rotated-agent-capability",
      expiresAt: "2026-08-26T21:45:00.000Z",
    });
  });

  it("parses SSE frames and reports a sequence gap before delivery", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          "id: 5\nevent: project.committed\ndata: {\"sequence\":5,\"type\":\"project.committed\",\"revision\":2,\"commandId\":\"cmd_2\"}\n\n",
        ));
        controller.enqueue(encoder.encode(
          "id: 7\nevent: job.updated\ndata: {\"sequence\":7,\"type\":\"job.updated\",\"jobId\":\"job_7\",\"status\":\"running\"}\n\n",
        ));
        controller.close();
      },
    });
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test",
      token: "event-capability",
      fetch: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const events: number[] = [];
    const gaps: unknown[] = [];

    const subscription = client.subscribeProjectEvents("project_fax_oracle", {
      afterSequence: 4,
      reconnect: false,
      onEvent: (event) => { events.push(event.sequence); },
      onGap: (gap) => { gaps.push(gap); },
    });
    await subscription.done;

    expect(events).toEqual([5, 7]);
    expect(gaps).toEqual([{ lastSequence: 5, expectedSequence: 6, receivedSequence: 7 }]);
    expect(subscription.getLastSequence()).toBe(7);
    expect(requests[0]?.url).toBe("https://praxis.test/api/projects/project_fax_oracle/events?afterSequence=4");
    expect(requests[0]?.headers.get("last-event-id")).toBe("4");
    expect(requests[0]?.headers.get("accept")).toBe("text/event-stream");
  });

  it("does not write credentials or requests to console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = new PraxisRemoteClient({
      baseUrl: "https://praxis.test",
      token: "do-not-log-this",
      fetch: async () => jsonResponse({ code: "DENIED", message: "No access." }, 403),
    });

    await expect(client.getProject("project_fax_oracle")).rejects.toMatchObject({ code: "DENIED" });
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    error.mockRestore();
  });
});

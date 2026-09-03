import { describe, expect, it, vi } from "vitest";
import { PraxisDispatchApiError, PraxisDispatchClient, type FetchLike } from "../src/praxis-client";
import type { DispatchAttemptResult } from "../src/types";
import { CLAIM_TICKET, agentRun } from "./helpers";

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json" },
});

const DISPATCHER_TOKEN = "dispatcher-token-not-for-logs-0123456789abcdef";

const options = (fetch: FetchLike) => ({
  baseUrl: "https://staging.praxis.example/api",
  token: DISPATCHER_TOKEN,
  projectId: "project_fax_01",
  dispatcherId: "dispatcher_staging_01",
  leaseSeconds: 120,
  fetch,
});

describe("PraxisDispatchClient", () => {
  it("uses the lease endpoint and transforms its one-time ticket response", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      run: agentRun(),
      dispatchAttemptId: "attempt_fax_01",
      claimTicket: CLAIM_TICKET,
    }));
    const client = new PraxisDispatchClient(options(fetch));

    await expect(client.leaseNext()).resolves.toMatchObject({
      mode: "submit",
      attemptId: "attempt_fax_01",
      claimTicket: CLAIM_TICKET,
      run: {
        id: "run_fax_01",
        stages: ["treatment", "script", "previz", "assets", "edit", "finish"],
        mode: "act",
      },
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://staging.praxis.example/internal/agent-dispatch/lease");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      projectId: "project_fax_01",
      dispatcherId: "dispatcher_staging_01",
      leaseSeconds: 120,
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${DISPATCHER_TOKEN}`);
  });

  it("requests a ten-minute claim window by default", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const { leaseSeconds: _leaseSeconds, ...defaultOptions } = options(fetch);
    const client = new PraxisDispatchClient(defaultOptions);

    await client.leaseNext();

    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ leaseSeconds: 600 });
  });

  it("uses the confirmed reconciliation envelope and records an idempotent result", async () => {
    const fetch = vi.fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse({
        runs: [{ run: agentRun({ status: "dispatch_unknown" }), dispatchAttemptId: "attempt_fax_01" }],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new PraxisDispatchClient(options(fetch));

    await expect(client.listReconciliationCandidates()).resolves.toMatchObject([
      { attemptId: "attempt_fax_01", run: { id: "run_fax_01", status: "dispatch_unknown" } },
    ]);
    const result: DispatchAttemptResult = {
      dispatcherId: "dispatcher_staging_01",
      outcome: "dispatched",
      observedAt: "2026-08-26T12:01:00.000Z",
      reasonCode: "SINGLE_NEW_TASK",
      codexTaskId: "task_new_praxis_01",
      codexTaskUrl: "https://chatgpt.com/codex/tasks/task_new_praxis_01",
    };
    await client.recordResult("run_fax_01", "attempt_fax_01", result);

    const [listUrl, listInit] = fetch.mock.calls[0]!;
    expect(String(listUrl)).toBe(
      "https://staging.praxis.example/internal/agent-dispatch/runs?projectId=project_fax_01&statuses=dispatching%2Cdispatch_unknown%2Cclaimed%2Cworking%2Cwaiting_on_jobs%2Ccompleted%2Cfailed%2Ccancelled",
    );
    expect(listInit?.method).toBe("GET");
    const [resultUrl, resultInit] = fetch.mock.calls[1]!;
    expect(resultUrl).toBe("https://staging.praxis.example/internal/agent-dispatch/runs/run_fax_01/result");
    expect(JSON.parse(String(resultInit?.body))).toEqual({
      projectId: "project_fax_01",
      dispatchAttemptId: "attempt_fax_01",
      idempotencyKey: expect.stringMatching(/^dispatch-result-[a-f0-9]{32}$/u),
      action: "record_task",
      codexTaskId: "task_new_praxis_01",
      codexTaskUrl: "https://chatgpt.com/codex/tasks/task_new_praxis_01",
    });
  });

  it("does not reflect control-plane response bodies or bearer tokens in errors", async () => {
    const secret = DISPATCHER_TOKEN;
    const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
      code: "LEASE_REJECTED",
      message: `accidental echo ${secret}`,
    }, 403));
    const client = new PraxisDispatchClient(options(fetch));

    const error = await client.leaseNext().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PraxisDispatchApiError);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("accidental echo");
    expect(error).toMatchObject({ code: "LEASE_REJECTED", status: 403 });
  });

  it("rejects tokens shorter than the control-plane minimum", () => {
    expect(() => new PraxisDispatchClient({
      ...options(vi.fn<FetchLike>()),
      token: "x".repeat(31),
    })).toThrow(/token length is invalid/);
  });

  it("rejects missing, empty, duplicate, unknown, or invalid delegated authority", async () => {
    const invalidRuns: unknown[] = [
      { ...agentRun(), stages: undefined },
      { ...agentRun(), stages: [] },
      { ...agentRun(), stages: ["script", "script"] },
      { ...agentRun(), stages: ["script", "sound"] },
      { ...agentRun(), mode: undefined },
      { ...agentRun(), mode: "execute" },
      { ...agentRun(), role: "reviewer", mode: "act" },
    ];

    for (const run of invalidRuns) {
      const fetch = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({
        run,
        dispatchAttemptId: "attempt_fax_01",
        claimTicket: CLAIM_TICKET,
      }));
      const error = await new PraxisDispatchClient(options(fetch)).leaseNext().catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("maps unknown and failed outcomes to the strict control-plane action shapes", async () => {
    const fetch = vi.fn<FetchLike>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new PraxisDispatchClient(options(fetch));
    await client.recordResult("run_fax_01", "attempt_fax_01", {
      dispatcherId: "dispatcher_staging_01",
      outcome: "dispatch_unknown",
      observedAt: "2026-08-26T12:01:00.000Z",
      reasonCode: "PROCESS_TIMEOUT",
    });
    await client.recordResult("run_fax_02", "attempt_fax_02", {
      dispatcherId: "dispatcher_staging_01",
      outcome: "not_submitted",
      observedAt: "2026-08-26T12:02:00.000Z",
      reasonCode: "CLOUD_EXEC_REJECTED",
    });

    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({
      projectId: "project_fax_01",
      dispatchAttemptId: "attempt_fax_01",
      idempotencyKey: expect.stringMatching(/^dispatch-result-[a-f0-9]{32}$/u),
      action: "mark_unknown",
      errorCode: "PROCESS_TIMEOUT",
      errorMessage: "Codex Cloud submission could not be correlated unambiguously",
    });
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({
      projectId: "project_fax_01",
      dispatchAttemptId: "attempt_fax_02",
      idempotencyKey: expect.stringMatching(/^dispatch-result-[a-f0-9]{32}$/u),
      action: "mark_failed",
      errorCode: "CLOUD_EXEC_REJECTED",
      errorMessage: "Codex Cloud task was not submitted",
    });
  });

  it("keys idempotency by the durable result payload, not only by action", async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = new PraxisDispatchClient(options(fetch));
    const first: DispatchAttemptResult = {
      dispatcherId: "dispatcher_staging_01",
      outcome: "dispatch_unknown",
      observedAt: "2026-08-26T12:01:00.000Z",
      reasonCode: "PROCESS_TIMEOUT",
    };
    const materiallyDifferent: DispatchAttemptResult = {
      ...first,
      observedAt: "2026-08-26T12:02:00.000Z",
      reasonCode: "RECONCILE_TASK_NOT_VISIBLE",
    };
    const samePayloadObservedLater: DispatchAttemptResult = {
      ...first,
      observedAt: "2026-08-26T12:03:00.000Z",
    };

    await client.recordResult("run_fax_01", "attempt_fax_01", first);
    await client.recordResult("run_fax_01", "attempt_fax_01", materiallyDifferent);
    await client.recordResult("run_fax_01", "attempt_fax_01", samePayloadObservedLater);

    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { idempotencyKey: string });
    expect(bodies[0]!.idempotencyKey).not.toBe(bodies[1]!.idempotencyKey);
    expect(bodies[2]!.idempotencyKey).toBe(bodies[0]!.idempotencyKey);
  });
});

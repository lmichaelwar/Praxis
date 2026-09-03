import { describe, expect, it } from "vitest";
import type { FetchLike } from "@praxis/remote-client";
import { PRAXISCTL_EXIT, runPraxisCli, type PraxisCliIo } from "../src/cli";

function captureIo() {
  let stdout = "";
  let stderr = "";
  const io: PraxisCliIo = {
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

const environment = {
  PRAXIS_API_BASE_URL: "https://praxis.test",
  PRAXIS_CAPABILITY_TOKEN: "cli-capability-secret",
};

const claimedRun = {
  id: "run_cli_01",
  projectId: "project_fax_oracle",
  checkpointId: "checkpoint_cli_01",
  baseRevision: 12,
  role: "producer-editor",
  stages: ["script", "previz", "edit"],
  mode: "act",
  status: "claimed",
  scopes: ["project:read", "command:write", "agent:read", "agent:write"],
  deniedEntityIds: ["scene_03"],
  maxSpendUsd: 1,
  claimExpiresAt: "2026-08-26T21:10:00.000Z",
  leaseExpiresAt: "2026-08-26T21:15:00.000Z",
  createdAt: "2026-08-26T21:00:00.000Z",
  updatedAt: "2026-08-26T21:01:00.000Z",
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("praxisctl", () => {
  it("prints parseable JSON for project get", async () => {
    const capture = captureIo();
    const fetch: FetchLike = async () => jsonResponse({
      project: { projectId: "project_fax_oracle", revision: 12 },
      history: { canUndo: true, canRedo: false, entries: [] },
      checkpoints: [],
      jobs: [],
      budget: { spentUsd: 0, reservedUsd: 0 },
      renders: [],
      assets: [],
      latestEventSequence: 20,
    });

    const exitCode = await runPraxisCli(
      ["project", "get", "--project", "project_fax_oracle"],
      { env: environment, io: capture.io, fetch },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.success);
    expect(capture.stderr()).toBe("");
    expect(JSON.parse(capture.stdout())).toMatchObject({
      ok: true,
      result: { project: { projectId: "project_fax_oracle", revision: 12 } },
    });
  });

  it("loads a command file and preserves its idempotency key", async () => {
    const capture = captureIo();
    let requestBody: unknown;
    let authorization: string | null = null;
    const fetch: FetchLike = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization");
      return jsonResponse({
        project: { projectId: "project_fax_oracle", revision: 2 },
        revision: 2,
        commandId: "command_cli_01",
        affectedEntityIds: ["scene_04"],
        staleEntityIds: [],
        eventSequence: 2,
        idempotentReplay: false,
      });
    };
    const commandFile = JSON.stringify({
      commandId: "command_cli_01",
      idempotencyKey: "cli-command-once",
      projectId: "project_fax_oracle",
      baseRevision: 1,
      actor: { kind: "codex", sessionId: "session_cli" },
      operations: [{ type: "scene.setStatus", sceneId: "scene_04", status: "approved" }],
    });

    const exitCode = await runPraxisCli(
      ["command", "apply", "--project", "project_fax_oracle", "--file", "command.json"],
      {
        env: environment,
        io: capture.io,
        fetch,
        readFile: async () => commandFile,
      },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.success);
    expect(requestBody).toMatchObject({ idempotencyKey: "cli-command-once" });
    expect(authorization).toBe("Bearer cli-capability-secret");
    expect(capture.stdout()).not.toContain("cli-capability-secret");
  });

  it("returns a useful conflict exit code and redacts the capability", async () => {
    const capture = captureIo();
    const fetch: FetchLike = async () => jsonResponse({
      code: "REVISION_CONFLICT",
      message: "Token cli-capability-secret cannot apply stale revision.",
      expectedRevision: 4,
      currentRevision: 6,
      changedEntityIds: ["scene_03"],
      lockedEntityIds: ["scene_03"],
    }, 409);

    const exitCode = await runPraxisCli(
      ["command", "apply", "--project", "project_fax_oracle", "--file", "command.json"],
      {
        env: environment,
        io: capture.io,
        fetch,
        readFile: async () => JSON.stringify({
          commandId: "command_conflict",
          idempotencyKey: "conflict-once",
          projectId: "project_fax_oracle",
          baseRevision: 4,
          actor: { kind: "codex", sessionId: "session_cli" },
          operations: [{ type: "scene.setStatus", sceneId: "scene_04", status: "approved" }],
        }),
      },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.conflict);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).not.toContain("cli-capability-secret");
    expect(JSON.parse(capture.stderr())).toEqual({
      ok: false,
      error: {
        code: "REVISION_CONFLICT",
        message: "Token [REDACTED] cannot apply stale revision.",
        status: 409,
        expectedRevision: 4,
        currentRevision: 6,
        changedEntityIds: ["scene_03"],
        lockedEntityIds: ["scene_03"],
        retryable: true,
      },
    });
  });

  it("uses a nonzero usage exit when authentication configuration is absent", async () => {
    const capture = captureIo();
    const exitCode = await runPraxisCli(
      ["project", "get", "--project", "project_fax_oracle"],
      { env: { PRAXIS_API_BASE_URL: "https://praxis.test" }, io: capture.io },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.usage);
    expect(JSON.parse(capture.stderr())).toMatchObject({
      ok: false,
      error: { code: "USAGE" },
    });
  });

  it("claims without bearer auth, redacts both secrets, and saves a mode-0600 session", async () => {
    const capture = captureIo();
    const ticket = "one-use-claim-ticket-that-must-never-be-printed";
    const capability = "short-lived-agent-capability-that-must-stay-private";
    let authorization: string | null = "not-called";
    let stored: { path: string; data: string; mode: number } | undefined;
    const chmodCalls: Array<{ path: string; mode: number }> = [];
    const renameCalls: Array<{ from: string; to: string }> = [];
    const unlinkCalls: string[] = [];
    const finalPath = "/runtime/user/1000/praxis/agent-session.json";
    const temporaryPath = `${finalPath}.00000000000000000000000000000001.tmp`;

    const exitCode = await runPraxisCli(
      ["agent", "claim", "--ticket", ticket],
      {
        env: {
          PRAXIS_API_BASE_URL: "https://praxis.test",
          XDG_RUNTIME_DIR: "/runtime/user/1000",
        },
        io: capture.io,
        cwd: () => "/workspace",
        fetch: async (input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          expect(String(input)).toBe("https://praxis.test/api/agent-runs/claim");
          expect(JSON.parse(String(init?.body))).toEqual({ ticket });
          return jsonResponse({
            run: claimedRun,
            capabilityToken: capability,
            expiresAt: "2026-08-26T21:15:00.000Z",
          });
        },
        mkdir: async () => undefined,
        writeFile: async (path, data, options) => {
          stored = { path, data, mode: options.mode };
        },
        chmod: async (path, mode) => { chmodCalls.push({ path, mode }); },
        rename: async (from, to) => { renameCalls.push({ from, to }); },
        unlink: async (path) => { unlinkCalls.push(path); },
        createId: () => "00000000-0000-0000-0000-000000000001",
      },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.success);
    expect(authorization).toBeNull();
    expect(stored).toMatchObject({
      path: temporaryPath,
      mode: 0o600,
    });
    expect(JSON.parse(stored!.data)).toMatchObject({
      apiRoot: "https://praxis.test/api",
      projectId: "project_fax_oracle",
      runId: "run_cli_01",
      capabilityToken: capability,
    });
    expect(chmodCalls).toEqual([
      { path: temporaryPath, mode: 0o600 },
      { path: finalPath, mode: 0o600 },
    ]);
    expect(renameCalls).toEqual([{ from: temporaryPath, to: finalPath }]);
    expect(unlinkCalls).toEqual([]);
    expect(capture.stdout()).not.toContain(ticket);
    expect(capture.stdout()).not.toContain(capability);
    expect(capture.stderr()).toBe("");
  });

  it("cleans the owner-only temporary session when the atomic rename fails", async () => {
    const capture = captureIo();
    const capability = "short-lived-agent-capability-that-must-stay-private";
    const finalPath = "/runtime/user/1000/praxis/agent-session.json";
    const temporaryPath = `${finalPath}.00000000000000000000000000000001.tmp`;
    const unlinked: string[] = [];

    const exitCode = await runPraxisCli(
      ["agent", "claim", "--ticket", "one-use-claim-ticket-that-must-never-be-printed"],
      {
        env: {
          PRAXIS_API_BASE_URL: "https://praxis.test",
          XDG_RUNTIME_DIR: "/runtime/user/1000",
        },
        io: capture.io,
        fetch: async () => jsonResponse({
          run: claimedRun,
          capabilityToken: capability,
          expiresAt: "2026-08-26T21:15:00.000Z",
        }),
        mkdir: async () => undefined,
        writeFile: async () => undefined,
        chmod: async () => undefined,
        rename: async () => { throw new Error("rename failed"); },
        unlink: async (path) => { unlinked.push(path); },
        createId: () => "00000000-0000-0000-0000-000000000001",
      },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.unavailable);
    expect(unlinked).toEqual([temporaryPath]);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).not.toContain(capability);
  });

  it("rejects an undersized claimed capability before writing a session", async () => {
    const capture = captureIo();
    let writeCalled = false;
    const exitCode = await runPraxisCli(
      ["agent", "claim", "--ticket", "one-use-claim-ticket-that-must-never-be-printed"],
      {
        env: {
          PRAXIS_API_BASE_URL: "https://praxis.test",
          XDG_RUNTIME_DIR: "/runtime/user/1000",
        },
        io: capture.io,
        fetch: async () => jsonResponse({
          run: claimedRun,
          capabilityToken: "too-short",
          expiresAt: "2026-08-26T21:15:00.000Z",
        }),
        mkdir: async () => undefined,
        writeFile: async () => { writeCalled = true; },
        chmod: async () => undefined,
        rename: async () => undefined,
        unlink: async () => undefined,
      },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.unavailable);
    expect(writeCalled).toBe(false);
    expect(capture.stderr()).not.toContain("too-short");
  });

  it("uses only the saved run capability for context, heartbeat, and finish", async () => {
    const capture = captureIo();
    const capabilityToken = "saved-agent-capability-value-secure";
    const rotatedCapabilityToken = "rotated-agent-capability-value-secure";
    const rotatedExpiry = "2026-08-26T21:45:00.000Z";
    let session = JSON.stringify({
      version: 1,
      apiRoot: "https://praxis.test/api",
      projectId: "project_fax_oracle",
      runId: "run_cli_01",
      capabilityToken,
      expiresAt: "2026-08-26T21:15:00.000Z",
    });
    const requests: Array<{ url: string; authorization: string | null; body?: unknown }> = [];
    const fetch: FetchLike = async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (String(input).endsWith("/context")) {
        return jsonResponse({
          run: claimedRun,
          project: { projectId: "project_fax_oracle", revision: 12 },
          history: { entries: [] },
          checkpoint: { checkpointId: "checkpoint_cli_01" },
          jobs: [],
          budget: { settledUsd: 0, reservedUsd: 0 },
        });
      }
      if (String(input).endsWith("/heartbeat")) {
        return jsonResponse({
          run: {
            ...claimedRun,
            status: "working",
            leaseExpiresAt: rotatedExpiry,
            lastHeartbeatAt: "2026-08-26T21:15:00.000Z",
            updatedAt: "2026-08-26T21:15:00.000Z",
          },
          capabilityToken: rotatedCapabilityToken,
          expiresAt: rotatedExpiry,
          eventSequence: 22,
          idempotentReplay: false,
        });
      }
      return jsonResponse({ run: claimedRun });
    };
    const sessionWrites: Array<{ path: string; mode: number }> = [];
    const sessionRenames: Array<{ from: string; to: string }> = [];
    let pendingSession = "";
    const dependencies = {
      env: {
        PRAXIS_API_BASE_URL: "https://praxis.test/api",
        XDG_RUNTIME_DIR: "/runtime/user/1000",
        // A reusable owner token must not override the run-bound session capability.
        PRAXIS_OWNER_TOKEN: "owner-token-must-not-be-used",
      },
      io: capture.io,
      fetch,
      readFile: async () => session,
      cwd: () => "/workspace",
      mkdir: async () => undefined,
      writeFile: async (path: string, data: string, options: { encoding: "utf8"; mode: number }) => {
        pendingSession = data;
        sessionWrites.push({ path, mode: options.mode });
      },
      chmod: async () => undefined,
      rename: async (from: string, to: string) => {
        session = pendingSession;
        sessionRenames.push({ from, to });
      },
      unlink: async () => undefined,
      createId: () => "00000000-0000-0000-0000-000000000001",
    };

    expect(await runPraxisCli(["agent", "context"], dependencies)).toBe(PRAXISCTL_EXIT.success);
    expect(await runPraxisCli(["agent", "heartbeat"], dependencies)).toBe(PRAXISCTL_EXIT.success);
    expect(await runPraxisCli([
      "agent",
      "finish",
      "--status",
      "waiting_on_jobs",
      "--summary",
      "Preview render queued.",
    ], dependencies)).toBe(PRAXISCTL_EXIT.success);

    expect(requests.map(({ url }) => url)).toEqual([
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_cli_01/context",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_cli_01/heartbeat",
      "https://praxis.test/api/projects/project_fax_oracle/agent-runs/run_cli_01/finish",
    ]);
    expect(requests.map(({ authorization: value }) => value)).toEqual([
      `Bearer ${capabilityToken}`,
      `Bearer ${capabilityToken}`,
      `Bearer ${rotatedCapabilityToken}`,
    ]);
    expect(requests[1]?.body).toEqual({ idempotencyKey: "heartbeat_00000000000000000000000000000001" });
    expect(requests[2]?.body).toEqual({
      idempotencyKey: "finish_00000000000000000000000000000001",
      status: "waiting_on_jobs",
      completionSummary: "Preview render queued.",
    });
    expect(capture.stdout()).not.toContain(capabilityToken);
    expect(capture.stdout()).not.toContain(rotatedCapabilityToken);
    expect(capture.stdout()).not.toContain("owner-token-must-not-be-used");
    expect(sessionWrites).toEqual([{
      path: "/runtime/user/1000/praxis/agent-session.json.00000000000000000000000000000001.tmp",
      mode: 0o600,
    }]);
    expect(sessionRenames).toEqual([{
      from: "/runtime/user/1000/praxis/agent-session.json.00000000000000000000000000000001.tmp",
      to: "/runtime/user/1000/praxis/agent-session.json",
    }]);
    expect(JSON.parse(session)).toMatchObject({
      capabilityToken: rotatedCapabilityToken,
      expiresAt: rotatedExpiry,
    });
  });

  it("uses the claimed session for project commands when no reusable token exists", async () => {
    const capture = captureIo();
    const capabilityToken = "run-bound-command-capability-secure";
    const session = JSON.stringify({
      version: 1,
      apiRoot: "https://praxis.test/api",
      projectId: "project_fax_oracle",
      runId: "run_cli_01",
      capabilityToken,
      expiresAt: "2026-08-26T21:15:00.000Z",
    });
    const commandFile = JSON.stringify({
      commandId: "command_agent_01",
      idempotencyKey: "agent-command-once",
      projectId: "project_fax_oracle",
      baseRevision: 12,
      actor: { kind: "codex", sessionId: "run_cli_01" },
      operations: [{ type: "scene.setStatus", sceneId: "scene_04", status: "approved" }],
    });
    let authorization: string | null = null;

    const exitCode = await runPraxisCli(
      ["command", "apply", "--project", "project_fax_oracle", "--file", "command.json"],
      {
        env: {
          PRAXIS_API_BASE_URL: "https://praxis.test",
          XDG_RUNTIME_DIR: "/runtime/user/1000",
        },
        io: capture.io,
        readFile: async (path) => path.endsWith("agent-session.json") ? session : commandFile,
        fetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return jsonResponse({
            project: { projectId: "project_fax_oracle", revision: 13 },
            revision: 13,
            commandId: "command_agent_01",
            affectedEntityIds: ["scene_04"],
            staleEntityIds: [],
            idempotentReplay: false,
          });
        },
      },
    );

    expect(exitCode).toBe(PRAXISCTL_EXIT.success);
    expect(authorization).toBe(`Bearer ${capabilityToken}`);
    expect(capture.stdout()).not.toContain(capabilityToken);
  });
});

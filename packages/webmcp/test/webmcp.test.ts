import { describe, expect, it, vi } from "vitest";

import {
  PRAXIS_WEBMCP_TOOL_NAMES,
  PraxisWebMcpHostError,
  createPraxisWebMcpTools,
  registerPraxisWebMcpTools,
  type PraxisWebMcpHost,
  type WebMcpModelContext,
  type WebMcpRegisterToolOptions,
  type WebMcpToolDefinition,
} from "../src";

function makeHost() {
  const methods = {
    getProjectContext: vi.fn(async () => ({
      projectId: "project_01",
      revision: 7,
      title: "Fax Oracle",
      stages: [
        { stage: "script" as const, status: "approved" as const, delegation: "act" as const },
      ],
    })),
    getCurrentSelection: vi.fn(async () => ({
      revision: 7,
      activeView: "timeline" as const,
      playheadFrame: 120,
      clipId: "clip_01",
    })),
    getChangeHistory: vi.fn(async () => ({
      currentRevision: 7,
      entries: [
        {
          revision: 7,
          operationId: "op_07",
          actor: "director" as const,
          action: "timeline.moveClip",
        },
      ],
    })),
    applyProjectOperations: vi.fn(async () => ({
      revision: 8,
      appliedOperationIds: ["op_08"],
      affectedEntityIds: ["clip_01"],
      invalidatedEntityIds: ["render_final"],
    })),
    setDelegation: vi.fn(async () => ({ revision: 8, updatedStages: ["edit" as const] })),
    createCheckpoint: vi.fn(async () => ({
      revision: 8,
      checkpointId: "checkpoint_08",
      label: "Before rough cut",
    })),
    restoreCheckpoint: vi.fn(async () => ({
      revision: 9,
      restoredCheckpointId: "checkpoint_08",
      affectedEntityIds: ["clip_01"],
    })),
    runQc: vi.fn(async () => ({
      revision: 8,
      jobId: "job_qc_01",
      status: "queued" as const,
    })),
    delegateProductionRun: vi.fn(async () => ({
      revision: 8,
      agentRun: {
        id: "run_01",
        projectId: "project_01",
        checkpointId: "checkpoint_08",
        baseRevision: 8,
        role: "producer-editor" as const,
        stages: ["script" as const, "previz" as const, "edit" as const],
        mode: "act" as const,
        status: "created" as const,
        scopes: ["project:read" as const, "command:write" as const],
        deniedEntityIds: ["scene_03"],
        maxSpendUsd: 1,
        claimExpiresAt: "2026-08-26T20:10:00.000Z",
        createdAt: "2026-08-26T20:00:00.000Z",
        updatedAt: "2026-08-26T20:00:00.000Z",
      },
    })),
    generateSceneAsset: vi.fn(async () => ({
      jobId: "job_image_01",
      jobType: "image.generate" as const,
      status: "queued" as const,
      baseRevision: 7,
      reservedCostUsd: 0.04,
      settledCostUsd: 0,
    })),
    generateNarration: vi.fn(async () => ({
      jobId: "job_speech_01",
      jobType: "speech.generate" as const,
      status: "queued" as const,
      baseRevision: 7,
      reservedCostUsd: 0.02,
      settledCostUsd: 0,
    })),
    startRender: vi.fn(async () => ({
      jobId: "job_render_01",
      jobType: "render.preview" as const,
      status: "queued" as const,
      baseRevision: 7,
      reservedCostUsd: 0.01,
      settledCostUsd: 0,
    })),
    getJobStatus: vi.fn(async () => ({
      jobId: "job_image_01",
      jobType: "image.generate" as const,
      status: "succeeded" as const,
      baseRevision: 7,
      reservedCostUsd: 0,
      settledCostUsd: 0.04,
      assetVersionId: "asset_scene_01_v2",
    })),
    cancelJob: vi.fn(async () => ({
      jobId: "job_image_01",
      jobType: "image.generate" as const,
      status: "cancel_requested" as const,
      baseRevision: 7,
      reservedCostUsd: 0.04,
      settledCostUsd: 0,
    })),
  } satisfies PraxisWebMcpHost;

  return methods;
}

class FakeModelContext implements WebMcpModelContext {
  readonly tools = new Map<string, WebMcpToolDefinition>();
  readonly registrations: Array<{
    tool: WebMcpToolDefinition;
    options?: WebMcpRegisterToolOptions;
  }> = [];

  async registerTool(tool: WebMcpToolDefinition, options?: WebMcpRegisterToolOptions) {
    this.tools.set(tool.name, tool);
    this.registrations.push({ tool, options });
    options?.signal?.addEventListener(
      "abort",
      () => {
        this.tools.delete(tool.name);
      },
      { once: true },
    );
  }
}

describe("Praxis WebMCP tools", () => {
  it("defines the requested semantic catalog with closed schemas and explicit annotations", () => {
    const tools = createPraxisWebMcpTools(makeHost());

    expect(tools.map((tool) => tool.name)).toEqual(PRAXIS_WEBMCP_TOOL_NAMES);
    expect(tools).toHaveLength(14);

    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.annotations).toEqual({
        readOnlyHint: [
          "get_project_context",
          "get_current_selection",
          "get_change_history",
          "get_job_status",
          "run_qc",
        ].includes(tool.name),
        untrustedContentHint: expect.any(Boolean),
      });

      if (!tool.annotations.readOnlyHint && tool.name !== "cancel_job") {
        const required = tool.inputSchema.required as readonly string[];
        expect(required).toContain("baseRevision");
        expect(required).toContain("idempotencyKey");
        expect(tool.description).toContain("Side effect:");
      }
    }

    const delegate = tools.find((tool) => tool.name === "delegate_production_run");
    expect(delegate?.inputSchema.properties).not.toHaveProperty("checkpointAfterEachStage");
  });

  it("delegates every tool to the generic host and forwards execution cancellation", async () => {
    const host = makeHost();
    const tools = new Map(createPraxisWebMcpTools(host).map((tool) => [tool.name, tool]));
    const execution = new AbortController();
    const context = { signal: execution.signal };

    await tools.get("get_project_context")?.execute({}, context);
    await tools.get("get_current_selection")?.execute({}, context);
    await tools.get("get_change_history")?.execute({ limit: 10 }, context);
    await tools.get("apply_project_operations")?.execute(
      {
        baseRevision: 7,
        idempotencyKey: "rough_cut_01",
        operations: [
          { type: "timeline.moveClip", clipId: "clip_01", startFrame: 150 },
        ],
      },
      context,
    );
    await tools.get("set_delegation")?.execute(
      {
        baseRevision: 7,
        idempotencyKey: "delegation_01",
        policies: [{ stage: "edit", mode: "act" }],
      },
      context,
    );
    await tools.get("create_checkpoint")?.execute(
      { baseRevision: 7, idempotencyKey: "checkpoint_01" },
      context,
    );
    await tools.get("restore_checkpoint")?.execute(
      {
        baseRevision: 8,
        idempotencyKey: "restore_checkpoint_01",
        checkpointId: "checkpoint_08",
      },
      context,
    );
    await tools.get("run_qc")?.execute(
      { baseRevision: 7, idempotencyKey: "quality_check_01" },
      context,
    );
    await tools.get("delegate_production_run")?.execute(
      {
        baseRevision: 7,
        idempotencyKey: "production_run_01",
        role: "producer-editor",
        stages: ["script", "previz", "edit"],
        mode: "act",
        maxSpendUsd: 1,
        preserveLockedEntities: true,
      },
      context,
    );
    await tools.get("generate_scene_asset")?.execute(
      { baseRevision: 7, idempotencyKey: "image_job_01", sceneId: "scene_01" },
      context,
    );
    await tools.get("generate_narration")?.execute(
      { baseRevision: 7, idempotencyKey: "speech_job_01", beatIds: ["beat_01"] },
      context,
    );
    await tools.get("start_render")?.execute(
      { baseRevision: 7, idempotencyKey: "render_job_01", kind: "preview" },
      context,
    );
    await tools.get("get_job_status")?.execute({ jobId: "job_image_01" }, context);
    await tools.get("cancel_job")?.execute({ jobId: "job_image_01" }, context);

    expect(host.getProjectContext).toHaveBeenCalledWith({
      toolName: "get_project_context",
      signal: execution.signal,
    });
    expect(host.getChangeHistory).toHaveBeenCalledWith(
      { limit: 10 },
      { toolName: "get_change_history", signal: execution.signal },
    );
    expect(host.applyProjectOperations).toHaveBeenCalledOnce();
    expect(host.setDelegation).toHaveBeenCalledOnce();
    expect(host.createCheckpoint).toHaveBeenCalledOnce();
    expect(host.restoreCheckpoint).toHaveBeenCalledOnce();
    expect(host.runQc).toHaveBeenCalledOnce();
    expect(host.delegateProductionRun).toHaveBeenCalledOnce();
    expect(host.generateSceneAsset).toHaveBeenCalledOnce();
    expect(host.generateNarration).toHaveBeenCalledOnce();
    expect(host.startRender).toHaveBeenCalledOnce();
    expect(host.getJobStatus).toHaveBeenCalledOnce();
    expect(host.cancelJob).toHaveBeenCalledOnce();
  });

  it("projects bounded summaries instead of returning arbitrary host data", async () => {
    const host = makeHost();
    host.getProjectContext.mockResolvedValueOnce({
      projectId: "project_01",
      revision: 7,
      title: "Fax Oracle",
      secretProviderToken: "must-not-leak",
      snapshot: { enormous: true },
    } as never);

    const [tool] = createPraxisWebMcpTools(host);
    const result = await tool.execute({});

    expect(result).toEqual({
      ok: true,
      result: { projectId: "project_01", revision: 7, title: "Fax Oracle" },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("snapshot");
  });

  it("never projects provider requests or object-store keys from durable jobs", async () => {
    const host = makeHost();
    host.getJobStatus.mockResolvedValueOnce({
      jobId: "job_image_01",
      jobType: "image.generate",
      status: "succeeded",
      baseRevision: 7,
      reservedCostUsd: 0,
      settledCostUsd: 0.04,
      assetVersionId: "asset_scene_01_v2",
      objectKey: "projects/private/provider-output.png",
      providerRequest: { authorization: "Bearer must-not-leak" },
    } as never);
    const tool = createPraxisWebMcpTools(host).find(({ name }) => name === "get_job_status");
    const result = await tool?.execute({ jobId: "job_image_01" });

    expect(result).toEqual({
      ok: true,
      result: {
        jobId: "job_image_01",
        jobType: "image.generate",
        status: "succeeded",
        baseRevision: 7,
        reservedCostUsd: 0,
        settledCostUsd: 0.04,
        assetVersionId: "asset_scene_01_v2",
      },
    });
    expect(JSON.stringify(result)).not.toContain("objectKey");
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("returns canonical durable AgentRun state without claim material", async () => {
    const host = makeHost();
    host.delegateProductionRun.mockResolvedValueOnce({
      revision: 7,
      agentRun: {
        id: "run_01",
        projectId: "project_01",
        checkpointId: "checkpoint_08",
        baseRevision: 8,
        role: "producer-editor",
        stages: ["script", "previz", "edit"],
        mode: "act",
        status: "dispatching",
        scopes: ["project:read", "command:write"],
        deniedEntityIds: ["scene_03"],
        maxSpendUsd: 1,
        claimExpiresAt: "2026-08-26T20:10:00.000Z",
        codexTaskId: "task_01",
        codexTaskUrl: "https://chatgpt.com/codex/tasks/task_01",
        createdAt: "2026-08-26T20:00:00.000Z",
        updatedAt: "2026-08-26T20:01:00.000Z",
        claimTicket: "must-not-leak",
      },
    } as never);
    const tool = createPraxisWebMcpTools(host).find(({ name }) => name === "delegate_production_run");
    const result = await tool?.execute({
      baseRevision: 7,
      idempotencyKey: "production_run_01",
      role: "producer-editor",
      stages: ["script", "previz", "edit"],
      mode: "act",
      maxSpendUsd: 1,
      preserveLockedEntities: true,
    });

    expect(result).toMatchObject({
      ok: true,
      result: {
        revision: 8,
        agentRun: {
          id: "run_01",
          status: "dispatching",
          stages: ["script", "previz", "edit"],
          mode: "act",
          maxSpendUsd: 1,
          codexTaskId: "task_01",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("claimTicket");
  });

  it("returns bounded structured host failures without leaking unknown errors", async () => {
    const host = makeHost();
    host.applyProjectOperations.mockRejectedValueOnce(
      new PraxisWebMcpHostError({
        code: "REVISION_CONFLICT",
        summary: "The director changed scene 03.",
        currentRevision: 9,
        changedEntityIds: ["scene_03"],
        retryable: true,
      }),
    );
    host.applyProjectOperations.mockRejectedValueOnce(
      new Error("provider-token=super-secret"),
    );
    const tool = createPraxisWebMcpTools(host).find(
      ({ name }) => name === "apply_project_operations",
    );
    const input = {
      baseRevision: 7,
      idempotencyKey: "rough_cut_01",
      operations: [{ type: "timeline.removeClip", clipId: "clip_01" }],
    };

    await expect(tool?.execute(input)).resolves.toEqual({
      ok: false,
      error: {
        code: "REVISION_CONFLICT",
        summary: "The director changed scene 03.",
        currentRevision: 9,
        changedEntityIds: ["scene_03"],
        retryable: true,
      },
    });

    const unknown = await tool?.execute(input);
    expect(unknown).toEqual({
      ok: false,
      error: {
        code: "HOST_ERROR",
        summary: "The project host could not complete this tool call.",
        retryable: false,
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("super-secret");
  });
});

describe("Praxis WebMCP registration lifecycle", () => {
  it("feature-detects an unavailable document without throwing", async () => {
    const registration = await registerPraxisWebMcpTools(makeHost(), {
      modelContext: null,
    });

    expect(registration.supported).toBe(false);
    expect(registration.unavailableReason).toBe("model_context_unavailable");
    expect(registration.registeredToolNames).toEqual([]);
  });

  it("registers with a shared signal and aborts all project-scoped tools on dispose", async () => {
    const modelContext = new FakeModelContext();
    const registration = await registerPraxisWebMcpTools(makeHost(), { modelContext });

    expect(registration.supported).toBe(true);
    expect(registration.registeredToolNames).toEqual(PRAXIS_WEBMCP_TOOL_NAMES);
    expect(modelContext.tools.size).toBe(14);
    expect(modelContext.registrations.every(({ options }) => options?.signal === registration.signal))
      .toBe(true);

    const cachedTool = modelContext.tools.get("get_project_context");
    registration.dispose();

    expect(registration.signal.aborted).toBe(true);
    expect(modelContext.tools.size).toBe(0);
    await expect(cachedTool?.execute({})).rejects.toMatchObject({ name: "AbortError" });
  });

  it("registers only an explicitly bounded tool subset in catalog order", async () => {
    const modelContext = new FakeModelContext();
    const registration = await registerPraxisWebMcpTools(makeHost(), {
      modelContext,
      toolNames: ["run_qc", "get_project_context", "run_qc"],
    });

    expect(registration.registeredToolNames).toEqual([
      "get_project_context",
      "run_qc",
    ]);
    expect([...modelContext.tools]).toEqual([
      ["get_project_context", expect.any(Object)],
      ["run_qc", expect.any(Object)],
    ]);
  });

  it("follows an owning lifecycle signal", async () => {
    const modelContext = new FakeModelContext();
    const owner = new AbortController();
    const registration = await registerPraxisWebMcpTools(makeHost(), {
      modelContext,
      signal: owner.signal,
    });

    owner.abort();

    expect(registration.signal.aborted).toBe(true);
    expect(modelContext.tools.size).toBe(0);
  });

  it("falls back to one-argument registration and honors a returned teardown", async () => {
    const tools = new Map<string, WebMcpToolDefinition>();
    const registerTool = vi.fn(function (
      tool: WebMcpToolDefinition,
      _options?: WebMcpRegisterToolOptions,
    ) {
      if (arguments.length > 1) {
        throw new TypeError("registration options are not supported");
      }

      tools.set(tool.name, tool);
      return () => {
        tools.delete(tool.name);
      };
    });
    const modelContext = { registerTool } satisfies WebMcpModelContext;

    const registration = await registerPraxisWebMcpTools(makeHost(), { modelContext });

    expect(tools.size).toBe(14);
    expect(registerTool).toHaveBeenCalledTimes(28);

    registration.dispose();
    await Promise.resolve();

    expect(tools.size).toBe(0);
  });
});

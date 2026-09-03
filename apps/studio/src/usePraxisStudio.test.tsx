// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { AgentRun } from "@praxis/agent-runs";
import { createSeedProject, type ProductionProject } from "@praxis/project-schema";
import {
  PraxisApiError,
  PraxisConflictError,
  type ProjectHydrationResponse,
  type SubscribeProjectEventsOptions,
} from "@praxis/remote-client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPanel } from "./components/PreviewPanel";
import { CloudRunStrip } from "./components/CloudRunStrip";
import { DelegationDrawer } from "./components/DelegationDrawer";
import { StudioHeader } from "./components/StudioHeader";
import { lockedEntityIds } from "./locked-entities";
import { resolveStudioCapabilities } from "./studio-capabilities";
import { usePraxisStudio, type StudioGateway } from "./usePraxisStudio";
import { SUBMISSION_WEBMCP_TOOL_NAMES } from "./usePraxisWebMcp";

const UNATTACHED_VERSION_ID = "version_unattached_scene_03";

function durableAgentRun(status: AgentRun["status"] = "created"): AgentRun {
  return {
    id: "run_studio_01",
    projectId: "project_fax_oracle",
    checkpointId: "checkpoint_studio_01",
    baseRevision: 8,
    role: "producer-editor",
    stages: ["script", "previz", "edit"],
    mode: "act",
    status,
    scopes: ["project:read", "command:write", "job:create", "job:read", "agent:read", "agent:write"],
    deniedEntityIds: ["scene_03"],
    maxSpendUsd: 1,
    claimExpiresAt: "2026-08-26T21:10:00.000Z",
    ...(status === "claimed" || status === "working"
      ? { leaseExpiresAt: "2026-08-26T21:15:00.000Z" }
      : {}),
    createdAt: "2026-08-26T21:00:00.000Z",
    updatedAt: "2026-08-26T21:00:00.000Z",
  };
}

function hydrationWithUnattachedAsset(): ProjectHydrationResponse {
  const project = createSeedProject();
  const scene = project.scenes.find((candidate) => candidate.meta.id === "scene_03")!;
  scene.meta.locked = false;
  return {
    ...hydration(project),
    assets: [{
      assetId: "asset_scene_03",
      assetVersionId: UNATTACHED_VERSION_ID,
      projectId: project.projectId,
      kind: "image",
      objectKey: `projects/${project.projectId}/assets/sha256/${"a".repeat(64)}.png`,
      sha256: "a".repeat(64),
      mimeType: "image/png",
      byteLength: 4_096,
      width: 1536,
      height: 1024,
      provenance: {
        projectRevision: project.revision,
        jobId: "job_unattached_scene_03",
        provider: "fake",
        model: "deterministic-image-v1",
      },
      createdAt: "2026-08-26T20:00:00.000Z",
    }],
  };
}

function atRevision(revision: number): ProductionProject {
  const project = createSeedProject();
  project.revision = revision;
  return project;
}

function hydration(project = createSeedProject(), sequence = 4): ProjectHydrationResponse {
  return {
    project,
    history: { canUndo: false, canRedo: false, entries: [] },
    checkpoints: [],
    jobs: [],
    budget: { maxSpendUsd: 1, reservedUsd: 0, settledUsd: 0, availableUsd: 1 },
    assets: [],
    renders: [],
    agentRuns: [],
    latestEventSequence: sequence,
  };
}

describe("locked entity capability boundary", () => {
  it("collects every lockable canonical entity once", () => {
    const project = createSeedProject();
    for (const beat of project.script.beats) beat.meta.locked = false;
    for (const scene of project.scenes) scene.meta.locked = false;
    for (const asset of Object.values(project.assets)) asset.meta.locked = false;
    project.timeline.meta.locked = false;
    for (const track of project.timeline.tracks) {
      track.meta.locked = false;
      for (const clip of track.clips) clip.meta.locked = false;
    }
    for (const decision of project.decisions) decision.meta.locked = false;

    project.script.beats[0]!.meta.locked = true;
    project.scenes[0]!.meta.locked = true;
    project.assets["asset_scene_01"]!.meta.locked = true;
    project.timeline.meta.locked = true;
    project.timeline.tracks[0]!.meta.locked = true;
    project.timeline.tracks[0]!.clips[0]!.meta.locked = true;
    project.decisions[0]!.meta.locked = true;
    project.decisions.push(structuredClone(project.decisions[0]!));

    expect(lockedEntityIds(project)).toEqual([
      "beat_01",
      "scene_01",
      "asset_scene_01",
      "timeline_main",
      "track_video_01",
      "clip_scene_01",
      "decision_tighten_ending",
    ]);
  });
});

function gatewayHarness(initial = hydration()) {
  let current = initial;
  let eventOptions: SubscribeProjectEventsOptions | undefined;
  const eventController = new AbortController();
  const close = vi.fn(() => eventController.abort());
  const getProject = vi.fn(async () => current);
  const applyCommand = vi.fn(async (_projectId: string, command: Parameters<StudioGateway["applyCommand"]>[1]) => {
    const project = atRevision(command.baseRevision + 1);
    current = {
      ...current,
      project,
      history: {
        canUndo: true,
        canRedo: false,
        entries: [{
          commandId: command.commandId,
          reason: command.reason,
          actorKind: command.actor.kind,
          revisionBefore: command.baseRevision,
          revisionAfter: project.revision,
          affectedEntityIds: ["scene_01"],
          staleEntityIds: [],
          committedAt: "2026-08-26T20:00:00.000Z",
        }],
      },
      latestEventSequence: current.latestEventSequence + 1,
    };
    return {
      project,
      revision: project.revision,
      commandId: command.commandId,
      affectedEntityIds: ["scene_01"],
      staleEntityIds: [],
      eventSequence: current.latestEventSequence,
      idempotentReplay: false,
    };
  });
  const createAgentRun = vi.fn(async (
    _projectId: string,
    request: Parameters<StudioGateway["createAgentRun"]>[1],
  ) => {
    const project = atRevision(request.baseRevision + 1);
    const run = {
      ...durableAgentRun(),
      baseRevision: project.revision,
      stages: request.stages ?? ["treatment", "script", "previz", "assets", "edit", "finish"],
      mode: request.mode ?? "act",
    };
    current = {
      ...current,
      project,
      agentRuns: [run],
      latestEventSequence: current.latestEventSequence + 1,
    };
    return { run, eventSequence: current.latestEventSequence, idempotentReplay: false };
  });
  const cancelAgentRun = vi.fn(async () => {
    const run = {
      ...durableAgentRun("cancelled"),
      baseRevision: current.agentRuns?.[0]?.baseRevision ?? current.project.revision,
      updatedAt: "2026-08-26T21:02:00.000Z",
    };
    current = {
      ...current,
      agentRuns: [run],
      latestEventSequence: current.latestEventSequence + 1,
    };
    return { run, eventSequence: current.latestEventSequence, idempotentReplay: false };
  });
  const gateway = {
    getProject,
    createProject: vi.fn(async () => current),
    applyCommand,
    undoProject: vi.fn(),
    redoProject: vi.fn(),
    createCheckpoint: vi.fn(),
    restoreCheckpoint: vi.fn(),
    createJob: vi.fn(),
    getJob: vi.fn(),
    cancelJob: vi.fn(),
    createAgentRun,
    cancelAgentRun,
    assetAccessUrl: vi.fn((_projectId: string, versionId: string) => `/api/assets/${versionId}`),
    subscribeProjectEvents: vi.fn((_projectId: string, options: SubscribeProjectEventsOptions) => {
      eventOptions = options;
      return {
        signal: eventController.signal,
        done: new Promise<void>(() => undefined),
        close,
        getLastSequence: () => options.afterSequence ?? 0,
      };
    }),
  } as unknown as StudioGateway;
  return {
    gateway,
    getProject,
    applyCommand,
    createAgentRun,
    cancelAgentRun,
    close,
    eventOptions: () => eventOptions,
    setHydration: (next: ProjectHydrationResponse) => { current = next; },
  };
}

describe("usePraxisStudio gateway authority", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("hydrates the durable project and stores only its locator", async () => {
    window.localStorage.setItem("praxis:studio:v1", JSON.stringify({ project: { revision: 999 } }));
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const harness = gatewayHarness();
    const { result, unmount } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(result.current.project.revision).toBe(createSeedProject().revision);
    expect(harness.getProject).toHaveBeenCalledWith("project_fax_oracle");
    expect(window.localStorage.getItem("praxis:studio:project-id:v1")).toBe("project_fax_oracle");
    expect(setItem).not.toHaveBeenCalledWith("praxis:studio:v1", expect.any(String));
    expect(harness.eventOptions()?.afterSequence).toBe(4);
    unmount();
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("exchanges Cloudflare Access identity once after a 401 and retries hydration with the browser session", async () => {
    const harness = gatewayHarness();
    harness.getProject.mockRejectedValueOnce(new PraxisApiError(401, {
      code: "AUTHENTICATION_REQUIRED",
      message: "Create a browser session.",
    }));
    const createBrowserSession = vi.fn(async () => ({
      ok: true as const,
      expiresAt: "2026-08-27T05:00:00.000Z",
    }));
    const gateway = { ...harness.gateway, createBrowserSession } as StudioGateway;
    const { result } = renderHook(() => usePraxisStudio({ gateway }));

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(createBrowserSession).toHaveBeenCalledOnce();
    expect(harness.getProject).toHaveBeenCalledTimes(2);
    expect(result.current.connection.status).toBe("connected");
  });

  it("creates and cancels a durable AgentRun instead of synthesizing browser-only status", async () => {
    const harness = gatewayHarness();
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));
    await waitFor(() => expect(result.current.isReady).toBe(true));

    let launched: Awaited<ReturnType<typeof result.current.startCloudRun>> | undefined;
    await act(async () => {
      launched = await result.current.startCloudRun();
    });

    expect(launched?.runId).toBe("run_studio_01");
    expect(harness.createAgentRun).toHaveBeenCalledWith(
      "project_fax_oracle",
      expect.objectContaining({
        baseRevision: 2,
        role: "producer-editor",
        stages: ["treatment", "script", "assets", "edit"],
        mode: "act",
        maxSpendUsd: 1,
        checkpointLabel: "Before delegated production",
        deniedEntityIds: expect.arrayContaining(["scene_03"]),
        scopes: expect.arrayContaining(["command:write", "job:create", "agent:write"]),
      }),
    );
    expect(result.current.cloudRun).toMatchObject({
      id: "run_studio_01",
      status: "created",
      baseRevision: 3,
      maxSpendUsd: 1,
    });

    await act(async () => {
      await result.current.cancelCloudRun();
    });

    expect(harness.cancelAgentRun).toHaveBeenCalledWith(
      "project_fax_oracle",
      "run_studio_01",
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^cancel_agent_run_/) }),
    );
    expect(result.current.cloudRun.status).toBe("cancelled");
  });

  it("keeps an active AgentRun visible when a newer terminal run exists", async () => {
    const active = {
      ...durableAgentRun("working"),
      id: "run_active_01",
      updatedAt: "2026-08-26T21:01:00.000Z",
    };
    const terminal = {
      ...durableAgentRun("completed"),
      id: "run_terminal_02",
      updatedAt: "2026-08-26T21:05:00.000Z",
      completionSummary: "Newer review finished.",
    };
    const harness = gatewayHarness({
      ...hydration(),
      agentRuns: [terminal, active],
    });
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));

    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(result.current.cloudRun).toMatchObject({
      id: "run_active_01",
      status: "working",
    });
  });

  it("rejects reviewer act authority before committing delegation policy", async () => {
    const harness = gatewayHarness();
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));
    await waitFor(() => expect(result.current.isReady).toBe(true));

    let launched: Awaited<ReturnType<typeof result.current.launchCloudRun>> | undefined;
    await act(async () => {
      launched = await result.current.launchCloudRun(
        result.current.delegationDraft,
        "codex",
        result.current.project.revision,
        "reviewer-act-is-denied",
        "reviewer",
        { stages: ["script"], mode: "act" },
      );
    });

    expect(launched?.result.ok).toBe(false);
    expect(harness.applyCommand).not.toHaveBeenCalled();
    expect(harness.createAgentRun).not.toHaveBeenCalled();
  });

  it("sends semantic commands with the caller idempotency key and reconciles the committed revision", async () => {
    const harness = gatewayHarness();
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));
    await waitFor(() => expect(result.current.isReady).toBe(true));

    let mutation: Awaited<ReturnType<typeof result.current.executeOperations>> | undefined;
    await act(async () => {
      mutation = await result.current.executeOperations(
        [{ type: "scene.setLocked", sceneId: "scene_01", locked: true }],
        "Lock scene",
        "codex",
        7,
        false,
        "webmcp_lock_01",
      );
    });

    expect(mutation?.ok).toBe(true);
    expect(result.current.project.revision).toBe(8);
    expect(harness.applyCommand).toHaveBeenCalledWith(
      "project_fax_oracle",
      expect.objectContaining({ baseRevision: 7, idempotencyKey: "webmcp_lock_01" }),
    );
  });

  it("sends checkpoint attribution only for the WebMCP Codex downgrade", async () => {
    const harness = gatewayHarness();
    const createCheckpoint = vi.mocked(harness.gateway.createCheckpoint);
    createCheckpoint.mockImplementation(async (_projectId, request) => ({
      project: atRevision(request.baseRevision + 1),
      revision: request.baseRevision + 1,
      commandId: request.commandId ?? "command_checkpoint_studio_01",
      checkpointId: request.checkpointId ?? "checkpoint_studio_01",
      affectedEntityIds: [request.checkpointId ?? "checkpoint_studio_01"],
      staleEntityIds: [],
      idempotentReplay: false,
    }));
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));
    await waitFor(() => expect(result.current.isReady).toBe(true));

    await act(async () => {
      await result.current.createCheckpoint("Director checkpoint", "director", 1, "checkpoint-ui-once");
      await result.current.createCheckpoint("WebMCP checkpoint", "codex", 1, "checkpoint-webmcp-once");
      await result.current.createCheckpoint("Untrusted system marker", "system", 1, "checkpoint-system-once");
    });

    const directorRequest = createCheckpoint.mock.calls[0]?.[1];
    const codexRequest = createCheckpoint.mock.calls[1]?.[1];
    const systemRequest = createCheckpoint.mock.calls[2]?.[1];
    expect(directorRequest).not.toHaveProperty("actor");
    expect(codexRequest).toMatchObject({
      reason: "Codex requested a durable checkpoint",
      actor: { kind: "codex" },
    });
    expect(systemRequest).not.toHaveProperty("actor");
  });

  it("reloads authoritative state and exposes a conflict boundary", async () => {
    const harness = gatewayHarness();
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));
    await waitFor(() => expect(result.current.isReady).toBe(true));
    harness.setHydration(hydration(atRevision(9), 8));
    vi.mocked(harness.gateway.applyCommand).mockRejectedValueOnce(new PraxisConflictError(409, {
      code: "REVISION_CONFLICT",
      message: "The director changed scene 03.",
      expectedRevision: 7,
      currentRevision: 9,
      changedEntityIds: ["scene_03"],
      lockedEntityIds: [],
    }));

    await act(async () => {
      await result.current.executeOperations(
        [{ type: "scene.setStatus", sceneId: "scene_01", status: "approved" }],
        "Approve scene",
        "codex",
        7,
        false,
        "webmcp_approve_01",
      );
    });

    expect(result.current.project.revision).toBe(9);
    expect(result.current.connection.status).toBe("conflict");
    expect(result.current.connection.message).toContain("authoritative state reloaded");
  });

  it("reconciles an SSE sequence gap through a full hydration", async () => {
    const harness = gatewayHarness();
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));
    await waitFor(() => expect(result.current.isReady).toBe(true));
    harness.setHydration({
      ...hydration(atRevision(8), 9),
      budget: { maxSpendUsd: 1, reservedUsd: 0.2, settledUsd: 0.1, availableUsd: 0.7 },
    });

    await act(async () => {
      await harness.eventOptions()?.onGap?.({ lastSequence: 4, expectedSequence: 5, receivedSequence: 9 });
    });

    expect(result.current.project.revision).toBe(8);
    expect(result.current.reservedUsd).toBe(0.2);
    expect(result.current.connection.status).toBe("connected");
  });

  it("inspects an unattached persisted version before adopting it through a director command", async () => {
    const harness = gatewayHarness(hydrationWithUnattachedAsset());
    const { result } = renderHook(() => usePraxisStudio({ gateway: harness.gateway }));
    await waitFor(() => expect(result.current.isReady).toBe(true));

    expect(result.current.assetVersions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: UNATTACHED_VERSION_ID,
        label: expect.stringContaining("stale / unattached"),
        status: "stale",
        selected: false,
        unattached: true,
        accessUrl: `/api/assets/${UNATTACHED_VERSION_ID}`,
      }),
    ]));

    await act(async () => {
      await result.current.selectAssetVersion(UNATTACHED_VERSION_ID);
    });

    expect(harness.applyCommand).not.toHaveBeenCalled();
    expect(result.current.previewedAssetVersion).toMatchObject({
      id: UNATTACHED_VERSION_ID,
      unattached: true,
    });
    expect(result.current.previewAssetUrl).toBe(`/api/assets/${UNATTACHED_VERSION_ID}`);

    await act(async () => {
      await result.current.adoptAssetVersion(UNATTACHED_VERSION_ID);
    });

    const command = harness.applyCommand.mock.calls.at(-1)?.[1];
    expect(command).toMatchObject({
      actor: { kind: "director" },
      reason: `Director adopted unattached asset ${UNATTACHED_VERSION_ID}`,
    });
    expect(command?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "asset.addVersion",
        assetId: "asset_scene_03",
        version: expect.objectContaining({
          id: UNATTACHED_VERSION_ID,
          status: "ready",
          sha256: "a".repeat(64),
          provenance: expect.objectContaining({ jobId: "job_unattached_scene_03" }),
        }),
      }),
      expect.objectContaining({
        type: "asset.selectVersion",
        assetId: "asset_scene_03",
        versionId: UNATTACHED_VERSION_ID,
      }),
      expect.objectContaining({
        type: "timeline.updateClip",
        clipId: "clip_scene_03",
        patch: expect.objectContaining({
          assetVersionId: UNATTACHED_VERSION_ID,
          versionPolicy: "pinned",
        }),
      }),
    ]));
  });
});

describe("PreviewPanel unattached asset intervention", () => {
  it("labels and previews the persisted version and exposes explicit adoption", () => {
    const onAdoptAssetVersion = vi.fn();
    const { unmount } = render(
      <PreviewPanel
        scene={null}
        playheadFrame={0}
        isPlaying={false}
        imageUrl={`/api/assets/${UNATTACHED_VERSION_ID}`}
        assetVersions={[{
          id: UNATTACHED_VERSION_ID,
          label: `${UNATTACHED_VERSION_ID} · stale / unattached`,
          status: "stale",
          selected: true,
          unattached: true,
          accessUrl: `/api/assets/${UNATTACHED_VERSION_ID}`,
        }]}
        pending={false}
        mediaActionsEnabled
        onTogglePlay={vi.fn()}
        onSeek={vi.fn()}
        onGenerateImage={vi.fn()}
        onGenerateNarration={vi.fn()}
        onSelectAssetVersion={vi.fn()}
        onAdoptAssetVersion={onAdoptAssetVersion}
      />,
    );

    expect(screen.getByText("Stale · unattached")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("src")).toBe(`/api/assets/${UNATTACHED_VERSION_ID}`);
    fireEvent.click(screen.getByRole("button", { name: "Adopt version" }));
    expect(onAdoptAssetVersion).toHaveBeenCalledWith(UNATTACHED_VERSION_ID);
    unmount();
  });
});

describe("DelegationDrawer authority controls", () => {
  it("makes lock preservation and the initial checkpoint explicit and non-optional", () => {
    const onStart = vi.fn();
    render(
      <DelegationDrawer
        open
        revision={7}
        draft={{
          modes: {
            treatment: "propose",
            script: "propose",
            previz: "propose",
            assets: "propose",
            edit: "propose",
            finish: "propose",
          },
          maxSpendUsd: 1,
          preserveLocked: true,
        }}
        onChange={vi.fn()}
        onClose={vi.fn()}
        onSave={vi.fn()}
        onStart={onStart}
      />,
    );

    const preservation = screen.getByRole("checkbox", { name: "Preserve locked entities" }) as HTMLInputElement;
    const checkpoint = screen.getByRole("checkbox", { name: "Create checkpoint before run" }) as HTMLInputElement;
    const takeStack = screen.getByRole("button", { name: "TAKE THE STACK" }) as HTMLButtonElement;
    expect(preservation.checked).toBe(true);
    expect(preservation.disabled).toBe(true);
    expect(checkpoint.checked).toBe(true);
    expect(checkpoint.disabled).toBe(true);
    expect(takeStack.disabled).toBe(true);
    expect(screen.getByText(/Locked entities will be preserved/)).toBeTruthy();
    expect(screen.getByText(/Saving authority and the initial checkpoint/)).toBeTruthy();
    fireEvent.click(takeStack);
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("CloudRunStrip durable AgentRun status", () => {
  it("renders the persisted status, revision, budget, and task identity", () => {
    const onCancel = vi.fn();
    render(
      <CloudRunStrip
        run={{
          id: "run_studio_01",
          label: "Codex production",
          status: "working",
          role: "producer-editor",
          baseRevision: 8,
          maxSpendUsd: 1,
          codexTaskUrl: "https://chatgpt.com/codex/tasks/task_01",
        }}
        jobs={[]}
        connection={{ status: "connected", message: "Live · event 12" }}
        submissionDemo={false}
        onCancel={onCancel}
        onCancelJob={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("r8 · $1.00 cap")).toBeTruthy();
    expect(screen.getByRole("link", { name: "task" }).getAttribute("href"))
      .toBe("https://chatgpt.com/codex/tasks/task_01");
    fireEvent.click(screen.getByRole("button", { name: "Cancel delegated AgentRun" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("submission demo capability boundary", () => {
  it("fails closed unless a full Studio explicitly opts out", () => {
    expect(resolveStudioCapabilities({})).toMatchObject({
      mode: "submission-demo",
      mediaActions: false,
      delegationActions: false,
      source: "safe-default",
    });
    expect(resolveStudioCapabilities({ VITE_PRAXIS_SUBMISSION_DEMO: "false" })).toMatchObject({
      mode: "full",
      mediaActions: true,
      delegationActions: true,
      source: "environment",
    });
  });

  it("hides provider and cloud-run controls while preserving playback and reset", () => {
    const onReset = vi.fn();
    const { container } = render(
      <>
        <StudioHeader
          title="The Fax Oracle"
          revision={17}
          spendUsd={0.07}
          reservedUsd={0}
          maxSpendUsd={1}
          connectionStatus="connected"
          controlsDisabled={false}
          cloudRunActive={false}
          webMcpStatus={{ state: "registered", toolCount: 6, access: "submission" }}
          submissionDemo
          canUndo
          canRedo={false}
          onDelegate={vi.fn()}
          onPreview={vi.fn()}
          onRender={vi.fn()}
          onRenderFinal={vi.fn()}
          onReset={onReset}
          onUndo={vi.fn()}
          onRedo={vi.fn()}
        />
        <PreviewPanel
          scene={null}
          playheadFrame={0}
          isPlaying={false}
          imageUrl="/existing-still.png"
          assetVersions={[]}
          pending={false}
          mediaActionsEnabled={false}
          onTogglePlay={vi.fn()}
          onSeek={vi.fn()}
          onGenerateImage={vi.fn()}
          onGenerateNarration={vi.fn()}
          onSelectAssetVersion={vi.fn()}
          onAdoptAssetVersion={vi.fn()}
        />
        <CloudRunStrip
          run={{
            id: "run_demo",
            label: "Existing run",
            status: "working",
            role: "producer-editor",
            baseRevision: 16,
            maxSpendUsd: 1,
            codexTaskUrl: "https://chatgpt.com/codex/tasks/existing",
          }}
          jobs={[{
            id: "job_existing",
            type: "render.preview",
            status: "running",
            baseRevision: 16,
            reservedCostUsd: 0,
            settledCostUsd: 0,
            cancellable: true,
          }]}
          connection={{ status: "connected", message: "Live · event 12" }}
          submissionDemo
          onCancel={vi.fn()}
          onCancelJob={vi.fn()}
          onRetry={vi.fn()}
        />
      </>,
    );

    const demo = within(container);
    expect(demo.getByText("Submission demo")).toBeTruthy();
    expect(demo.getByText("Existing media only")).toBeTruthy();
    expect(demo.getByText("Existing media only · no generation")).toBeTruthy();
    expect(demo.getByText("Submission demo · cloud runs disabled")).toBeTruthy();
    expect(demo.getByText("WebMCP · 6 bounded tools")).toBeTruthy();
    expect(demo.getByRole("button", { name: "Preview" })).toBeTruthy();
    fireEvent.click(demo.getByRole("button", { name: "Reset demo" }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(demo.queryByRole("button", { name: "Generate still" })).toBeNull();
    expect(demo.queryByRole("button", { name: "Narration" })).toBeNull();
    expect(demo.queryByRole("button", { name: "Render" })).toBeNull();
    expect(demo.queryByRole("button", { name: "Delegate run" })).toBeNull();
    expect(demo.queryByRole("button", { name: "Cancel delegated AgentRun" })).toBeNull();
    expect(demo.queryByRole("button", { name: "Cancel render.preview job" })).toBeNull();
    expect(demo.queryByRole("link", { name: "task" })).toBeNull();
  });

  it("labels native WebMCP absence and registration failure distinctly", () => {
    const props = {
      title: "The Fax Oracle",
      revision: 17,
      spendUsd: 0,
      reservedUsd: 0,
      maxSpendUsd: 1,
      connectionStatus: "connected" as const,
      controlsDisabled: false,
      cloudRunActive: false,
      submissionDemo: true,
      canUndo: false,
      canRedo: false,
      onDelegate: vi.fn(),
      onPreview: vi.fn(),
      onRender: vi.fn(),
      onRenderFinal: vi.fn(),
      onReset: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
    };
    const { rerender } = render(<StudioHeader {...props} webMcpStatus={{ state: "unavailable", reason: "model_context_unavailable" }} />);
    expect(screen.getByText("WebMCP · unavailable")).toBeTruthy();
    rerender(<StudioHeader {...props} webMcpStatus={{ state: "failed" }} />);
    expect(screen.getByText("WebMCP · registration failed")).toBeTruthy();
  });

  it("exposes only the bounded submission tool set", () => {
    expect(SUBMISSION_WEBMCP_TOOL_NAMES).toEqual([
      "get_project_context",
      "get_current_selection",
      "get_change_history",
      "apply_project_operations",
      "create_checkpoint",
      "run_qc",
    ]);
    expect(SUBMISSION_WEBMCP_TOOL_NAMES).not.toContain("delegate_production_run");
    expect(SUBMISSION_WEBMCP_TOOL_NAMES).not.toContain("generate_scene_asset");
    expect(SUBMISSION_WEBMCP_TOOL_NAMES).not.toContain("generate_narration");
    expect(SUBMISSION_WEBMCP_TOOL_NAMES).not.toContain("start_render");
  });
});

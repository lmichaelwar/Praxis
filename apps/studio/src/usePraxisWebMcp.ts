import { useEffect, useRef, useState } from "react";
import type { ProjectOperation } from "@praxis/commands";
import { createEntityMeta } from "@praxis/project-schema";
import { runStructuralQc } from "@praxis/qc";
import { PraxisApiError, PraxisConflictError } from "@praxis/remote-client";
import {
  PraxisWebMcpHostError,
  registerPraxisWebMcpTools,
  type ApplyProjectOperationsInput,
  type PraxisWebMcpHost,
  type ProjectMutationSummary,
  type ProjectOperationInput,
  type PraxisWebMcpToolName,
} from "@praxis/webmcp";
import { lockedEntityIds } from "./locked-entities";

export type PraxisWebMcpStatus =
  | { readonly state: "waiting" | "registering" }
  | { readonly state: "unavailable"; readonly reason: "model_context_unavailable" }
  | { readonly state: "registered"; readonly toolCount: number; readonly access: "submission" | "full" }
  | { readonly state: "failed" };

export const SUBMISSION_WEBMCP_TOOL_NAMES = [
  "get_project_context",
  "get_current_selection",
  "get_change_history",
  "apply_project_operations",
  "create_checkpoint",
  "run_qc",
] as const satisfies readonly PraxisWebMcpToolName[];

type StudioController = ReturnType<
  (typeof import("./usePraxisStudio"))["usePraxisStudio"]
>;

type StudioCommandResult = Awaited<ReturnType<StudioController["executeOperations"]>>;

function throwForResult(result: StudioCommandResult): never {
  if (result.ok) throw new Error("Expected a failed command result");
  throw new PraxisWebMcpHostError({
    code: result.error.code,
    summary: result.error.summary,
    currentRevision: result.project.revision,
    changedEntityIds:
      result.error.code === "REVISION_CONFLICT"
        ? result.error.changedEntities
        : "entityId" in result.error
          ? [result.error.entityId]
          : undefined,
    retryable: result.error.code === "REVISION_CONFLICT",
  });
}

function mutationSummary(
  result: StudioCommandResult,
): ProjectMutationSummary {
  if (!result.ok) return throwForResult(result);
  return {
    revision: result.result.revision,
    appliedOperationIds: result.result.appliedOperationIds,
    affectedEntityIds: result.result.affectedEntityIds,
    invalidatedEntityIds: result.result.invalidatedEntityIds,
    checkpointId: result.result.checkpointId,
    dryRun: result.result.dryRun,
  };
}

function durableJobSummary(job: Awaited<ReturnType<StudioController["getJob"]>>) {
  return {
    jobId: job.jobId,
    jobType: job.jobType,
    status: job.status,
    baseRevision: job.baseRevision,
    reservedCostUsd: job.reservedCostUsd,
    settledCostUsd: job.settledCostUsd,
    assetVersionId: job.output?.assetVersionId,
    renderId: job.output?.renderId,
    attached: job.output?.attached,
    stale: job.output?.stale,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
  };
}

async function gatewayJob<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PraxisApiError) {
      throw new PraxisWebMcpHostError({
        code: error.code,
        summary: error.message,
        currentRevision: error instanceof PraxisConflictError ? error.currentRevision : undefined,
        changedEntityIds: error instanceof PraxisConflictError ? error.changedEntityIds : undefined,
        retryable: error.retryable,
      });
    }
    throw error;
  }
}

function normalizeOperation(
  input: ProjectOperationInput,
  studio: StudioController,
): ProjectOperation {
  if (input.type !== "timeline.insertClip") {
    return structuredClone(input) as ProjectOperation;
  }

  const { clip } = input;
  return {
    type: "timeline.insertClip",
    operationId: input.operationId,
    trackId: input.trackId,
    clip: {
      meta: createEntityMeta(clip.clipId, studio.project.revision + 1, "codex", {
        derivedFrom: [clip.sceneId, clip.assetId].filter((id): id is string => Boolean(id)),
      }),
      kind: clip.kind,
      name: clip.name,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      sourceStartFrame: clip.sourceStartFrame ?? 0,
      ...(clip.sourceDurationFrames === undefined ? {} : { sourceDurationFrames: clip.sourceDurationFrames }),
      ...(clip.sceneId ? { sceneId: clip.sceneId } : {}),
      ...(clip.assetId ? { assetId: clip.assetId } : {}),
      ...(clip.assetVersionId ? { assetVersionId: clip.assetVersionId } : {}),
      versionPolicy: clip.versionPolicy ?? "pinned",
      opacity: clip.opacity ?? 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, ...clip.transform },
      ...(clip.transitionIn ? { transitionIn: clip.transitionIn } : {}),
      ...(clip.transitionOut ? { transitionOut: clip.transitionOut } : {}),
    },
  };
}

export function usePraxisWebMcp(studio: StudioController, submissionDemo = false) {
  const latest = useRef(studio);
  latest.current = studio;
  const [status, setStatus] = useState<PraxisWebMcpStatus>({ state: "waiting" });

  useEffect(() => {
    if (!studio.isReady) {
      setStatus({ state: "waiting" });
      return;
    }
    const lifecycle = new AbortController();
    let active = true;
    setStatus({ state: "registering" });

    const host: PraxisWebMcpHost = {
      getProjectContext: () => {
        const current = latest.current;
        return {
          projectId: current.project.projectId,
          revision: current.project.revision,
          title: current.project.metadata.title,
          briefSummary: current.project.brief.premise,
          activeStage: current.activeStage,
          durationFrames: current.project.timeline.durationFrames,
          fps: current.project.timeline.fps,
          stages: current.stages.map((stage) => ({
            stage: stage.id,
            status: current.project.stages[stage.id].status,
            delegation: stage.mode,
          })),
          budget: {
            spentUsd: current.spendUsd,
            maxSpendUsd: current.budget.maxSpendUsd,
          },
          lockedEntityIds: lockedEntityIds(current.project),
          outstandingJobs: current.jobs.slice(0, 25).map((job) => ({
            jobId: job.jobId,
            kind: job.jobType,
            status: job.status === "succeeded"
              ? "completed" as const
              : job.status === "failed" || job.status === "cancelled"
                ? job.status
                : job.status === "queued" ? "queued" as const : "running" as const,
          })),
        };
      },

      getCurrentSelection: () => {
        const current = latest.current;
        return {
          revision: current.project.revision,
          activeView: current.selection.activeView === "script" ? "script" as const : "storyboard" as const,
          playheadFrame: current.selection.playheadFrame,
          beatId: current.selectedScene?.beatId,
          sceneId: current.selection.sceneId ?? undefined,
          clipId: current.selection.clipId ?? undefined,
        };
      },

      getChangeHistory: (input) => {
        const current = latest.current;
        const entries = current.ledger
          .filter((entry) => input.sinceRevision === undefined || entry.revision > input.sinceRevision)
          .filter((entry) => input.actor === undefined || entry.actor === input.actor)
          .slice(0, input.limit ?? 20)
          .map((entry) => ({
            revision: entry.revision,
            operationId: entry.id,
            actor: entry.actor,
            action: entry.action,
            summary: entry.detail,
            createdAt: entry.timestamp,
          }));
        return {
          currentRevision: current.project.revision,
          entries,
          hasMore: current.ledger.length > entries.length,
        };
      },

      applyProjectOperations: async (input: ApplyProjectOperationsInput) => {
        const current = latest.current;
        const operations = input.operations.map((operation) => normalizeOperation(operation, current));
        return mutationSummary(await current.executeOperations(
          operations,
          input.reason ?? "Codex applied semantic project operations",
          "codex",
          input.baseRevision,
          input.dryRun ?? false,
          input.idempotencyKey,
        ));
      },

      setDelegation: async (input) => {
        const current = latest.current;
        for (const policy of input.policies) {
          if (policy.entityIds && policy.entityIds.length > 0) {
            throw new PraxisWebMcpHostError({
              code: "UNSUPPORTED_ENTITY_SCOPE",
              summary: "The first vertical slice supports stage-scoped delegation; entity locks remain available separately.",
              currentRevision: current.project.revision,
              retryable: false,
            });
          }
        }
        const result = await current.executeOperations(
          input.policies.map((policy): ProjectOperation => ({
            type: "delegation.set",
            stage: policy.stage,
            mode: policy.mode,
            maxSpendUsd: policy.maxSpendUsd,
            checkpointAfterStage: policy.checkpointAfterStage,
          })),
          input.reason ?? "Codex updated delegation policy",
          "codex",
          input.baseRevision,
          false,
          input.idempotencyKey,
        );
        return {
          ...mutationSummary(result),
          updatedStages: input.policies.map((policy) => policy.stage),
        };
      },

      createCheckpoint: async (input) => {
        const current = latest.current;
        const created = await current.createCheckpoint(
          input.label ?? "Codex checkpoint",
          "codex",
          input.baseRevision,
          input.idempotencyKey,
        );
        if (!created.result.ok) return throwForResult(created.result);
        return {
          revision: created.result.project.revision,
          checkpointId: created.checkpointId,
          label: input.label ?? "Codex checkpoint",
        };
      },

      restoreCheckpoint: async (input) => {
        if (input.dryRun) {
          throw new PraxisWebMcpHostError({
            code: "DRY_RUN_UNSUPPORTED",
            summary: "The control-plane restore endpoint does not expose checkpoint snapshot previews.",
            currentRevision: latest.current.project.revision,
            retryable: false,
          });
        }
        const result = await latest.current.restoreCheckpoint(
          input.checkpointId,
          input.baseRevision,
          input.dryRun ?? false,
          "codex",
          input.idempotencyKey,
        );
        if (!result) {
          throw new PraxisWebMcpHostError({
            code: "CHECKPOINT_NOT_FOUND",
            summary: `Checkpoint ${input.checkpointId} does not exist in the durable project.`,
            currentRevision: latest.current.project.revision,
          });
        }
        return {
          ...mutationSummary(result),
          restoredCheckpointId: input.checkpointId,
        };
      },

      runQc: (input) => {
        const current = latest.current;
        if (input.baseRevision !== current.project.revision) {
          throw new PraxisWebMcpHostError({
            code: "REVISION_CONFLICT",
            summary: `QC requested revision ${input.baseRevision}, but the project is at ${current.project.revision}.`,
            currentRevision: current.project.revision,
            retryable: true,
          });
        }
        const report = runStructuralQc(current.project);
        return {
          revision: current.project.revision,
          jobId: `qc_r${current.project.revision}`,
          status: "completed" as const,
          findings: report.findings.map((finding) => ({
            severity: finding.severity,
            code: finding.code,
            summary: finding.message,
            entityId: finding.entityIds[0],
          })),
        };
      },

      delegateProductionRun: async (input) => {
        const current = latest.current;
        const modes = { ...current.delegationDraft.modes };
        for (const stage of input.stages) modes[stage] = input.mode;
        const launched = await current.launchCloudRun({
          modes,
          maxSpendUsd: input.maxSpendUsd,
          preserveLocked: true,
        }, "codex", input.baseRevision, input.idempotencyKey, input.role, {
          stages: input.stages,
          mode: input.mode,
        });
        if (!launched.result.ok) return throwForResult(launched.result);
        const agentRun = "agentRun" in launched ? launched.agentRun : undefined;
        if (!agentRun) {
          throw new PraxisWebMcpHostError({
            code: "AGENT_RUN_NOT_CREATED",
            summary: "The durable AgentRun response was missing after delegation.",
            currentRevision: launched.result.project.revision,
            retryable: true,
          });
        }
        return {
          revision: agentRun.baseRevision,
          agentRun,
        };
      },

      generateSceneAsset: async (input) => durableJobSummary(await gatewayJob(() => latest.current.generateSceneAsset(
        input.sceneId,
        input.prompt,
        input.idempotencyKey,
        input.baseRevision,
      ))),

      generateNarration: async (input) => durableJobSummary(await gatewayJob(() => latest.current.generateNarration(
        input.beatIds,
        input.idempotencyKey,
        input.baseRevision,
      ))),

      startRender: async (input) => durableJobSummary(await gatewayJob(() => latest.current.startRender(
        input.kind,
        input.idempotencyKey,
        input.baseRevision,
      ))),

      getJobStatus: async (input) => durableJobSummary(await gatewayJob(() => latest.current.getJob(input.jobId))),

      cancelJob: async (input) => durableJobSummary(await gatewayJob(() => latest.current.cancelJob(input.jobId))),
    };

    void registerPraxisWebMcpTools(host, {
      signal: lifecycle.signal,
      ...(submissionDemo ? { toolNames: SUBMISSION_WEBMCP_TOOL_NAMES } : {}),
    })
      .then((registration) => {
        if (!active) {
          registration.dispose();
          return;
        }
        setStatus(registration.supported
          ? {
              state: "registered",
              toolCount: registration.registeredToolNames.length,
              access: submissionDemo ? "submission" : "full",
            }
          : { state: "unavailable", reason: "model_context_unavailable" });
      })
      .catch(() => {
        if (active) setStatus({ state: "failed" });
      });

    return () => {
      active = false;
      lifecycle.abort();
    };
  }, [studio.isReady, submissionDemo]);

  return status;
}

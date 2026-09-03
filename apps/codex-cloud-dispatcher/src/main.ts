import { CodexCloudCliDispatcher } from "./codex-cloud-cli";
import { loadDispatcherConfig } from "./config";
import { PraxisDispatchClient } from "./praxis-client";
import { DispatchPollLoop, DispatchService, jsonLineLogger } from "./service";

const abortController = new AbortController();
const requestShutdown = (signal: NodeJS.Signals) => {
  jsonLineLogger.info("dispatcher_shutdown_requested", { signal });
  abortController.abort(new Error(`Received ${signal}`));
};
process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  const config = loadDispatcherConfig();
  const controlPlane = new PraxisDispatchClient({
    baseUrl: config.praxisApiBaseUrl,
    token: config.praxisDispatcherToken,
    projectId: config.projectId,
    dispatcherId: config.dispatcherId,
    leaseSeconds: config.leaseSeconds,
  });
  const cloud = new CodexCloudCliDispatcher({
    environmentId: config.codexEnvironmentId,
    repositoryRoot: config.repositoryRoot,
    branch: config.branch,
    executable: config.codexExecutable,
  });
  const service = new DispatchService({
    dispatcherId: config.dispatcherId,
    controlPlane,
    cloud,
    reconciliationMaxPages: config.reconciliationMaxPages,
  });

  jsonLineLogger.info("dispatcher_started", {
    dispatcherId: config.dispatcherId,
    projectId: config.projectId,
    runMode: config.runOnce ? "once" : "poll",
  });

  if (config.runOnce) {
    const result = await service.runOnce(abortController.signal);
    jsonLineLogger.info("dispatcher_once_completed", {
      resultKind: result.kind,
      ...(result.kind === "processed" ? {
        runId: result.runId,
        attemptId: result.attemptId,
        outcome: result.result.outcome,
      } : {}),
    });
  } else {
    const loop = new DispatchPollLoop({
      service,
      pollIntervalMs: config.pollIntervalMs,
    });
    await loop.run(abortController.signal);
  }
} catch (error) {
  const candidateCode = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
  jsonLineLogger.error("dispatcher_fatal", {
    errorType: error instanceof Error ? error.name : "UnknownError",
    ...(/^[A-Z][A-Z0-9_]{0,79}$/u.test(candidateCode ?? "") ? { errorCode: candidateCode } : {}),
  });
  process.exitCode = 1;
}

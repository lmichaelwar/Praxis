import { loadRenderWorkerConfig } from "./config";
import { FfmpegRenderExecutor } from "./executor";
import { createRenderServer } from "./server";

const config = await loadRenderWorkerConfig();
const executor = new FfmpegRenderExecutor(config);
const server = createRenderServer({
  authSecret: config.authSecret,
  tokenMaxTtlSeconds: config.tokenMaxTtlSeconds,
  allowStaticAuth: config.allowStaticAuth,
  staticAuthToken: config.staticAuthToken,
  maxRequestBytes: config.maxRequestBytes,
  timeoutMs: config.timeoutMs,
  executor,
});

server.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(`Praxis render worker listening on port ${config.port}\n`);
});

const shutdown = (signal: NodeJS.Signals) => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
  process.stdout.write(`Praxis render worker received ${signal}\n`);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(repositoryRoot, ".praxis-data");
const secretsPath = path.join(runtimeRoot, "dev-secrets.json");
const workerEnvPath = path.join(runtimeRoot, "dev-full.env");

const parseEnvironment = (source) => {
  const values = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) continue;
    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
};

const readOptionalEnvironment = async (filePath) => {
  try {
    return parseEnvironment(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
};

await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
let generatedSecrets;
let generatedSecretsCreated = false;
try {
  generatedSecrets = JSON.parse(await readFile(secretsPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  generatedSecrets = {
    ownerToken: randomBytes(32).toString("base64url"),
    capabilitySigningSecret: randomBytes(48).toString("base64url"),
    renderAuthSecret: randomBytes(48).toString("base64url"),
    renderResultSigningSecret: randomBytes(48).toString("base64url"),
    browserSessionSigningSecret: randomBytes(48).toString("base64url"),
    agentClaimSigningSecret: randomBytes(48).toString("base64url"),
    dispatcherToken: randomBytes(48).toString("base64url"),
  };
  generatedSecretsCreated = true;
  await writeFile(secretsPath, `${JSON.stringify(generatedSecrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

let generatedSecretsUpdated = false;
for (const key of ["renderResultSigningSecret", "browserSessionSigningSecret", "agentClaimSigningSecret", "dispatcherToken"]) {
  if (typeof generatedSecrets[key] === "string" && generatedSecrets[key].length >= 32) continue;
  generatedSecrets[key] = randomBytes(48).toString("base64url");
  generatedSecretsUpdated = true;
}
if (!generatedSecretsCreated && generatedSecretsUpdated) {
  await writeFile(secretsPath, `${JSON.stringify(generatedSecrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const [rootEnvironment, localEnvironment] = await Promise.all([
  readOptionalEnvironment(path.join(repositoryRoot, ".env")),
  readOptionalEnvironment(path.join(repositoryRoot, ".env.local")),
]);
const loaded = { ...rootEnvironment, ...localEnvironment };
const liveMedia = (loaded.PRAXIS_LIVE_MEDIA_TEST ?? process.env.PRAXIS_LIVE_MEDIA_TEST) === "1";
const openAiKey = loaded.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
const fontSourcePath = path.join(repositoryRoot, "node_modules/@fontsource-variable/roboto-condensed/files/roboto-condensed-latin-wght-normal.woff2");
const fontPath = path.join(runtimeRoot, "fonts/RobotoCondensedVariable.woff2");
await access(fontSourcePath, constants.R_OK);
await mkdir(path.dirname(fontPath), { recursive: true });
await copyFile(fontSourcePath, fontPath);

const childEnvironment = {
  ...process.env,
  ...loaded,
  PRAXIS_OWNER_TOKEN: loaded.PRAXIS_OWNER_TOKEN ?? generatedSecrets.ownerToken,
  PRAXIS_CAPABILITY_SIGNING_SECRET: loaded.PRAXIS_CAPABILITY_SIGNING_SECRET ?? generatedSecrets.capabilitySigningSecret,
  PRAXIS_RENDER_AUTH_SECRET: loaded.PRAXIS_RENDER_AUTH_SECRET ?? loaded.PRAXIS_RENDER_WORKER_TOKEN ?? generatedSecrets.renderAuthSecret,
  PRAXIS_RENDER_RESULT_SIGNING_SECRET: loaded.PRAXIS_RENDER_RESULT_SIGNING_SECRET ?? generatedSecrets.renderResultSigningSecret,
  PRAXIS_RENDER_RESULT_SIGNING_KEY_ID: loaded.PRAXIS_RENDER_RESULT_SIGNING_KEY_ID ?? "praxis-render-result-local-v1",
  PRAXIS_BROWSER_SESSION_SIGNING_SECRET: loaded.PRAXIS_BROWSER_SESSION_SIGNING_SECRET ?? generatedSecrets.browserSessionSigningSecret,
  PRAXIS_AGENT_CLAIM_SIGNING_SECRET: loaded.PRAXIS_AGENT_CLAIM_SIGNING_SECRET ?? generatedSecrets.agentClaimSigningSecret,
  PRAXIS_DISPATCHER_TOKEN: loaded.PRAXIS_DISPATCHER_TOKEN ?? generatedSecrets.dispatcherToken,
  PRAXIS_AGENT_LEASE_SECONDS: loaded.PRAXIS_AGENT_LEASE_SECONDS ?? "1800",
  PRAXIS_RECONCILE_INTERVAL_SECONDS: loaded.PRAXIS_RECONCILE_INTERVAL_SECONDS ?? "30",
  PRAXIS_CANCEL_GRACE_SECONDS: loaded.PRAXIS_CANCEL_GRACE_SECONDS ?? "45",
  PRAXIS_API_BASE_URL: loaded.PRAXIS_API_BASE_URL ?? "http://127.0.0.1:8787",
  PRAXIS_PUBLIC_API_BASE_URL: loaded.PRAXIS_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8787",
  PRAXIS_RENDER_WORKER_URL: loaded.PRAXIS_RENDER_WORKER_URL ?? "http://127.0.0.1:8790",
  PRAXIS_FAKE_IMAGE_URL: loaded.PRAXIS_FAKE_IMAGE_URL ?? "http://127.0.0.1:4173/media/fax-oracle-corridor.png",
  PRAXIS_PROVIDER_MODE: loaded.PRAXIS_PROVIDER_MODE ?? (liveMedia && openAiKey ? "openai" : "fake"),
  PRAXIS_IMAGE_MODEL: loaded.PRAXIS_IMAGE_MODEL ?? "gpt-image-2",
  PRAXIS_TTS_MODEL: loaded.PRAXIS_TTS_MODEL ?? "gpt-4o-mini-tts",
  PRAXIS_TTS_VOICE: loaded.PRAXIS_TTS_VOICE ?? "alloy",
  PRAXIS_LIVE_MEDIA_TEST: liveMedia ? "1" : "0",
  PRAXIS_RENDER_PORT: "8790",
  PRAXIS_RENDER_ALLOW_STATIC_AUTH: "0",
  PRAXIS_RENDER_AUTH_MAX_TTL_SECONDS: "900",
  PRAXIS_RENDERER_VERSION: "praxis-ffmpeg-1",
  PRAXIS_OBJECT_STORE_ROOT: path.join(runtimeRoot, "render-objects"),
  PRAXIS_RENDER_TEMP_ROOT: path.join(runtimeRoot, "render-jobs"),
  PRAXIS_FONT_PATH: fontPath,
  PRAXIS_FONT_FAMILY: "Roboto Condensed Variable",
  PRAXIS_ASS_FONT_FAMILY: "Roboto Condensed",
  PRAXIS_FONT_WEIGHT: "700",
  PRAXIS_FONT_STYLE: "normal",
  ...(openAiKey ? { OPENAI_API_KEY: openAiKey } : {}),
};

const workerEnvironmentNames = [
  "PRAXIS_OWNER_TOKEN", "PRAXIS_CAPABILITY_SIGNING_SECRET", "PRAXIS_RENDER_AUTH_SECRET",
  "PRAXIS_RENDER_RESULT_SIGNING_SECRET", "PRAXIS_RENDER_RESULT_SIGNING_KEY_ID", "PRAXIS_RENDER_RESULT_VERIFY_KEYS_JSON",
  "PRAXIS_BROWSER_SESSION_SIGNING_SECRET", "PRAXIS_AGENT_CLAIM_SIGNING_SECRET", "PRAXIS_DISPATCHER_TOKEN",
  "PRAXIS_AGENT_LEASE_SECONDS", "PRAXIS_RECONCILE_INTERVAL_SECONDS", "PRAXIS_CANCEL_GRACE_SECONDS",
  "PRAXIS_API_BASE_URL", "PRAXIS_RENDER_WORKER_URL", "PRAXIS_FAKE_IMAGE_URL", "PRAXIS_PROVIDER_MODE",
  "PRAXIS_IMAGE_MODEL", "PRAXIS_TTS_MODEL", "PRAXIS_TTS_VOICE", "PRAXIS_LIVE_MEDIA_TEST", "OPENAI_API_KEY",
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME",
];
const workerEnvironmentFile = workerEnvironmentNames
  .filter((name) => childEnvironment[name])
  .map((name) => `${name}=${JSON.stringify(childEnvironment[name])}`)
  .join("\n");
await writeFile(workerEnvPath, `${workerEnvironmentFile}\n`, { encoding: "utf8", mode: 0o600 });

const children = [];
const exitPromises = [];
let firstExitResolve;
const firstExit = new Promise((resolve) => { firstExitResolve = resolve; });
let stopping = false;
const launch = (name, executable, arguments_, cwd) => {
  const child = spawn(executable, arguments_, { cwd, env: childEnvironment, stdio: "inherit" });
  child.praxisName = name;
  children.push(child);
  exitPromises.push(new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      const result = { name, code, signal };
      firstExitResolve(result);
      resolve(result);
    });
  }));
  return child;
};

launch("studio", process.execPath, [path.join(repositoryRoot, "node_modules/vite/bin/vite.js")], path.join(repositoryRoot, "apps/studio"));
launch("renderer", process.execPath, [path.join(repositoryRoot, "node_modules/tsx/dist/cli.mjs"), "src/main.ts"], path.join(repositoryRoot, "apps/render-worker"));
launch("control-plane", process.execPath, [
  path.join(repositoryRoot, "node_modules/wrangler/bin/wrangler.js"), "dev", "--config", "wrangler.jsonc",
  "--port", "8787", "--persist-to", path.join(runtimeRoot, "wrangler"), "--env-file", workerEnvPath,
  "--show-interactive-dev-session", "false",
], path.join(repositoryRoot, "apps/control-plane"));

const stopChildren = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  setTimeout(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5_000).unref();
};
process.once("SIGINT", () => stopChildren("SIGINT"));
process.once("SIGTERM", () => stopChildren("SIGTERM"));

const waitForHttp = async (url, timeoutMs = 60_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      // Services start concurrently and become reachable at different times.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

try {
  const startup = Promise.all([
    waitForHttp("http://127.0.0.1:4173/"),
    waitForHttp("http://127.0.0.1:8787/health"),
    waitForHttp("http://127.0.0.1:8790/health"),
  ]).then(() => ({ ready: true }));
  const startupResult = await Promise.race([startup, firstExit.then((exit) => ({ ready: false, exit }))]);
  if (!startupResult.ready) throw new Error(`${startupResult.exit.name} exited during startup (${startupResult.exit.signal ?? startupResult.exit.code ?? "unknown"})`);
  process.stdout.write("Praxis full stack ready at http://127.0.0.1:4173\n");
  const exit = await firstExit;
  if (!stopping) {
    process.stderr.write(`${exit.name} exited unexpectedly (${exit.signal ?? exit.code ?? "unknown"})\n`);
    process.exitCode = exit.code && exit.code !== 0 ? exit.code : 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Praxis full stack failed to start"}\n`);
  process.exitCode = 1;
} finally {
  stopChildren();
  await Promise.all(exitPromises);
}

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessRunResult>;
}

export class ProcessRunError extends Error {
  readonly code: "PROCESS_SPAWN_FAILED" | "PROCESS_TIMEOUT" | "PROCESS_ABORTED" | "PROCESS_OUTPUT_LIMIT";
  readonly processStarted: boolean;

  constructor(input: {
    code: ProcessRunError["code"];
    message: string;
    processStarted: boolean;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ProcessRunError";
    this.code = input.code;
    this.processStarted = input.processStarted;
  }
}

/** Runs a fixed executable and argv vector. Shell execution is never available. */
export class SpawnProcessRunner implements ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessRunResult> {
    return new Promise((resolve, reject) => {
      if (invocation.signal?.aborted) {
        reject(new ProcessRunError({
          code: "PROCESS_ABORTED",
          message: "Codex CLI invocation was aborted",
          processStarted: false,
        }));
        return;
      }

      let processStarted = false;
      let settled = false;
      let pendingFailure: ProcessRunError | undefined;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      const child: ChildProcessByStdio<null, Readable, Readable> = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: { ...invocation.env } as NodeJS.ProcessEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stop = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        forceKillTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 5_000);
        forceKillTimer.unref();
      };
      const failAfterClose = (failure: ProcessRunError) => {
        if (pendingFailure) return;
        pendingFailure = failure;
        stop();
      };
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > invocation.maxOutputBytes) {
          failAfterClose(new ProcessRunError({
            code: "PROCESS_OUTPUT_LIMIT",
            message: "Codex CLI output exceeded the configured limit",
            processStarted,
          }));
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };

      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("spawn", () => { processStarted = true; });

      const timer = setTimeout(() => {
        failAfterClose(new ProcessRunError({
          code: "PROCESS_TIMEOUT",
          message: "Codex CLI invocation timed out",
          processStarted,
        }));
      }, invocation.timeoutMs);
      timer.unref();

      const onAbort = () => failAfterClose(new ProcessRunError({
        code: "PROCESS_ABORTED",
        message: "Codex CLI invocation was aborted",
        processStarted,
      }));
      invocation.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanUp = () => {
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        invocation.signal?.removeEventListener("abort", onAbort);
      };
      child.once("error", (cause: Error) => {
        if (settled) return;
        settled = true;
        cleanUp();
        reject(new ProcessRunError({
          code: "PROCESS_SPAWN_FAILED",
          message: "Codex CLI process could not be started",
          processStarted,
          // Node spawn errors may contain spawnargs, including the protected prompt.
          cause: cause instanceof Error ? new Error(cause.name) : undefined,
        }));
      });
      child.once("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanUp();
        if (pendingFailure) reject(pendingFailure);
        else resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

export class ProcessExecutionError extends Error {
  readonly code: "PROCESS_FAILED" | "PROCESS_TIMEOUT" | "PROCESS_ABORTED";
  readonly exitCode?: number | null;
  readonly stderr: string;

  constructor(options: {
    code: ProcessExecutionError["code"];
    message: string;
    exitCode?: number | null;
    stderr?: string;
  }) {
    super(options.message);
    this.name = "ProcessExecutionError";
    this.code = options.code;
    this.exitCode = options.exitCode;
    this.stderr = options.stderr ?? "";
  }
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes?: number;
}

export function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new ProcessExecutionError({
      code: "PROCESS_ABORTED",
      message: "The media process was cancelled before it started",
    }));
  }

  return new Promise((resolve, reject) => {
    const maxOutputBytes = options.maxOutputBytes ?? 262_144;
    const child = spawn(options.command, [...options.args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let terminalReason: "timeout" | "abort" | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const append = (
      current: Buffer<ArrayBufferLike>,
      next: string | Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const buffer = typeof next === "string" ? Buffer.from(next) : next;
      if (current.length >= maxOutputBytes) return current;
      return Buffer.concat([current, buffer.subarray(0, maxOutputBytes - current.length)]);
    };
    child.stdout.on("data", (chunk: string | Buffer<ArrayBufferLike>) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: string | Buffer<ArrayBufferLike>) => { stderr = append(stderr, chunk); });

    const terminate = (reason: "timeout" | "abort") => {
      if (terminalReason) return;
      terminalReason = reason;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceKillTimer.unref();
    };
    const onAbort = () => terminate("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timeout.unref();

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.once("error", (error) => {
      cleanup();
      reject(new ProcessExecutionError({
        code: terminalReason === "timeout" ? "PROCESS_TIMEOUT" : terminalReason === "abort" ? "PROCESS_ABORTED" : "PROCESS_FAILED",
        message: `Unable to execute media process: ${error.message}`,
        stderr: stderr.toString(),
      }));
    });
    child.once("close", (code) => {
      cleanup();
      const decodedStdout = stdout.toString();
      const decodedStderr = stderr.toString();
      if (terminalReason === "abort") {
        reject(new ProcessExecutionError({
          code: "PROCESS_ABORTED",
          message: "The media process was cancelled",
          exitCode: code,
          stderr: decodedStderr,
        }));
      } else if (terminalReason === "timeout") {
        reject(new ProcessExecutionError({
          code: "PROCESS_TIMEOUT",
          message: `The media process exceeded ${options.timeoutMs}ms`,
          exitCode: code,
          stderr: decodedStderr,
        }));
      } else if (code !== 0) {
        reject(new ProcessExecutionError({
          code: "PROCESS_FAILED",
          message: `The media process exited with code ${code}`,
          exitCode: code,
          stderr: decodedStderr,
        }));
      } else {
        resolve({ stdout: decodedStdout, stderr: decodedStderr });
      }
    });
  });
}

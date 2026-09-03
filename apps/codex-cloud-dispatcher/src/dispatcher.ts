import type { CloudTaskPage } from "./types";

/** A prompt wrapper whose default string and JSON representations are redacted. */
export interface ProtectedDispatchPrompt {
  reveal(): string;
  redact(value: string): string;
  readonly publicMetadata: {
    readonly runId: string;
    readonly attemptId: string;
    readonly projectId: string;
  };
}

export interface CloudTaskSubmission {
  readonly submittedAt: string;
  readonly taskId?: string;
  readonly taskUrl?: string;
}

/** Replaceable boundary around the experimental cloud-task transport. */
export interface CloudTaskDispatcher {
  listTasks(input?: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<CloudTaskPage>;
  submit(input: {
    readonly prompt: ProtectedDispatchPrompt;
    readonly signal?: AbortSignal;
  }): Promise<CloudTaskSubmission>;
}

export class CloudDispatcherError extends Error {
  readonly code: string;
  readonly operation: "exec" | "list";
  readonly submissionMayHaveOccurred: boolean;

  constructor(input: {
    code: string;
    operation: "exec" | "list";
    message: string;
    submissionMayHaveOccurred?: boolean;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "CloudDispatcherError";
    this.code = input.code;
    this.operation = input.operation;
    this.submissionMayHaveOccurred = input.submissionMayHaveOccurred ?? false;
  }
}

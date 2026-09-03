import type { ApiErrorBody } from "./types";

const fallbackMessage = (status: number) =>
  status > 0 ? `Praxis API request failed with HTTP ${status}.` : "Praxis API request failed.";

export class PraxisApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiErrorBody;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(status: number, details: ApiErrorBody = {}, cause?: unknown) {
    super(details.message ?? details.summary ?? fallbackMessage(status), { cause });
    this.name = "PraxisApiError";
    this.status = status;
    this.code = details.code ?? (status > 0 ? `HTTP_${status}` : "API_ERROR");
    this.details = details;
    this.requestId = details.requestId;
    this.retryable = details.retryable ?? (status === 409 || status === 429 || status >= 500);
  }
}

export class PraxisConflictError extends PraxisApiError {
  readonly expectedRevision?: number;
  readonly currentRevision?: number;
  readonly changedEntityIds: readonly string[];
  readonly lockedEntityIds: readonly string[];

  constructor(status: number, details: ApiErrorBody) {
    super(status, details);
    this.name = "PraxisConflictError";
    this.expectedRevision = details.expectedRevision;
    this.currentRevision = details.currentRevision;
    this.changedEntityIds = details.changedEntityIds ?? [];
    this.lockedEntityIds = details.lockedEntityIds ?? [];
  }
}

export class PraxisNetworkError extends PraxisApiError {
  constructor(cause: unknown) {
    super(0, {
      code: "NETWORK_ERROR",
      message: "Praxis API could not be reached.",
      retryable: true,
    }, cause);
    this.name = "PraxisNetworkError";
  }
}

export class PraxisEventStreamError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PraxisEventStreamError";
  }
}

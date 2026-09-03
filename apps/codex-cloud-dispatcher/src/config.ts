import { hostname } from "node:os";
import path from "node:path";

const STABLE_ID = /^[A-Za-z][A-Za-z0-9:_-]{2,127}$/u;

export interface DispatcherConfig {
  readonly praxisApiBaseUrl: string;
  readonly praxisDispatcherToken: string;
  readonly projectId: string;
  readonly dispatcherId: string;
  readonly leaseSeconds: number;
  readonly codexEnvironmentId: string;
  readonly codexExecutable: string;
  readonly repositoryRoot: string;
  readonly branch?: string;
  readonly pollIntervalMs: number;
  readonly reconciliationMaxPages: number;
  readonly runOnce: boolean;
}

const required = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum = 16_384,
): string => {
  const value = environment[name];
  if (!value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be a non-empty bounded value without control characters`);
  }
  return value;
};

const optional = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum = 2_048,
): string | undefined => {
  const value = environment[name];
  if (value === undefined || value === "") return undefined;
  if (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must be a bounded value without control characters`);
  }
  return value;
};

const integer = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = environment[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const defaultDispatcherId = (): string => {
  const suffix = hostname().replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 120) || "local";
  return `dispatcher-${suffix}`.slice(0, 128);
};

const stableId = (value: string, name: string): string => {
  if (!STABLE_ID.test(value)) throw new Error(`${name} must be a stable Praxis identifier`);
  return value;
};

const boolean = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
): boolean => {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be one of 1, 0, true, or false`);
};

export const loadDispatcherConfig = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DispatcherConfig => {
  const token = required(environment, "PRAXIS_DISPATCHER_TOKEN");
  const branch = optional(environment, "PRAXIS_CODEX_BRANCH", 1_024);
  if (token.length < 32) throw new Error("PRAXIS_DISPATCHER_TOKEN must contain at least 32 characters");
  return {
    praxisApiBaseUrl: required(environment, "PRAXIS_API_BASE_URL", 4_096),
    praxisDispatcherToken: token,
    projectId: stableId(required(environment, "PRAXIS_PROJECT_ID", 128), "PRAXIS_PROJECT_ID"),
    dispatcherId: stableId(
      optional(environment, "PRAXIS_DISPATCHER_ID", 128) ?? defaultDispatcherId(),
      "PRAXIS_DISPATCHER_ID",
    ),
    leaseSeconds: integer(environment, "PRAXIS_DISPATCH_LEASE_SECONDS", 600, 60, 1_800),
    codexEnvironmentId: required(environment, "PRAXIS_CODEX_ENVIRONMENT_ID", 1_024),
    codexExecutable: optional(environment, "PRAXIS_CODEX_EXECUTABLE", 1_024) ?? "codex",
    repositoryRoot: path.resolve(optional(environment, "PRAXIS_REPOSITORY_ROOT", 4_096) ?? process.cwd()),
    ...(branch ? { branch } : {}),
    pollIntervalMs: integer(environment, "PRAXIS_DISPATCH_POLL_INTERVAL_MS", 5_000, 250, 60_000),
    reconciliationMaxPages: integer(environment, "PRAXIS_DISPATCH_RECONCILE_MAX_PAGES", 5, 1, 20),
    runOnce: boolean(environment, "PRAXIS_DISPATCH_ONCE", false),
  };
};

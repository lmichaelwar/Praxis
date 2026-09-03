import { describe, expect, it } from "vitest";
import { loadDispatcherConfig } from "../src/config";

describe("dispatcher configuration", () => {
  it("loads the isolated runtime contract", () => {
    expect(loadDispatcherConfig({
      PRAXIS_API_BASE_URL: "https://staging.praxis.example",
      PRAXIS_DISPATCHER_TOKEN: "dispatcher-token-0123456789abcdef",
      PRAXIS_PROJECT_ID: "project_fax_01",
      PRAXIS_DISPATCHER_ID: "dispatcher_staging_01",
      PRAXIS_CODEX_ENVIRONMENT_ID: "env_praxis_staging",
      PRAXIS_REPOSITORY_ROOT: "/workspace/praxis",
      PRAXIS_CODEX_BRANCH: "staging",
      PRAXIS_DISPATCH_ONCE: "1",
    })).toMatchObject({
      projectId: "project_fax_01",
      dispatcherId: "dispatcher_staging_01",
      leaseSeconds: 600,
      codexEnvironmentId: "env_praxis_staging",
      repositoryRoot: "/workspace/praxis",
      branch: "staging",
      pollIntervalMs: 5_000,
      reconciliationMaxPages: 5,
      runOnce: true,
    });
  });

  it("requires explicit control-plane, project, token, and cloud environment settings", () => {
    expect(() => loadDispatcherConfig({})).toThrow(/PRAXIS_DISPATCHER_TOKEN/);
  });

  it("rejects dispatcher tokens that the control plane cannot authorize", () => {
    expect(() => loadDispatcherConfig({
      PRAXIS_DISPATCHER_TOKEN: "x".repeat(31),
    })).toThrow(/at least 32 characters/);
  });

  it("bounds reconciliation pagination explicitly", () => {
    const base = {
      PRAXIS_API_BASE_URL: "https://staging.praxis.example",
      PRAXIS_DISPATCHER_TOKEN: "x".repeat(32),
      PRAXIS_PROJECT_ID: "project_fax_01",
      PRAXIS_CODEX_ENVIRONMENT_ID: "env_praxis_staging",
    };
    expect(loadDispatcherConfig({
      ...base,
      PRAXIS_DISPATCH_RECONCILE_MAX_PAGES: "12",
    }).reconciliationMaxPages).toBe(12);
    expect(() => loadDispatcherConfig({
      ...base,
      PRAXIS_DISPATCH_RECONCILE_MAX_PAGES: "21",
    })).toThrow(/between 1 and 20/);
  });
});

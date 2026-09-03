# `@praxis/webmcp`

Thin, browser-facing WebMCP registration for Praxis. This package contains schemas, tool descriptions, safe result projections, and lifecycle wiring only. Project mutation, revision checks, locks, checkpoints, jobs, and QC remain responsibilities of the injected host.

## API

- `registerPraxisWebMcpTools(host, options?)` registers the project-scoped catalog and returns an idempotent `dispose()` handle.
- `createPraxisWebMcpTools(host, lifecycleSignal?)` creates definitions without registering them, useful for tests and custom integration.
- `isWebMcpAvailable()` and `getDocumentModelContext()` provide graceful feature detection.
- `PRAXIS_WEBMCP_TOOL_NAMES` and `PRAXIS_WEBMCP_INPUT_SCHEMAS` expose the static catalog.
- `PraxisWebMcpHost` is the generic application boundary. Its methods return bounded summaries, never project snapshots.
- `PraxisWebMcpHostError` lets a host expose a safe structured conflict or validation error.
- `delegate_production_run` returns a bounded canonical `AgentRun`; the Studio
  host persists it through the control plane instead of synthesizing browser
  status.

```ts
import { registerPraxisWebMcpTools } from "@praxis/webmcp";

const lifecycle = new AbortController();
const registration = await registerPraxisWebMcpTools(projectToolHost, {
  signal: lifecycle.signal,
});

if (!registration.supported) {
  // Keep the studio usable when document.modelContext is unavailable.
}

// Abort on project/view teardown. The same signal is supplied to
// document.modelContext.registerTool(tool, { signal }).
lifecycle.abort();
```

The adapter also tolerates a one-argument `registerTool(tool)` implementation. A legacy implementation can return an unregister callback or `{ unregister() }` handle, or expose `unregisterTool`, so `dispose()` can remove those tools. Cached tool definitions reject new execution after lifecycle disposal.

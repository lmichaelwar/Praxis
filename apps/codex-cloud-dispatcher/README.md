# Praxis Codex Cloud dispatcher

This isolated Node service bridges durable Praxis `AgentRun` records to the experimental Codex Cloud CLI. It does not own project state, mint capabilities, execute media work, or expose a reusable Praxis credential to a cloud task. The control plane leases one dispatch attempt and returns its one-use claim ticket exactly once.

The CLI is behind `CloudTaskDispatcher`, so a future supported API can replace it without changing control-plane or AgentRun semantics. The current adapter invokes only these fixed argument shapes with `shell: false`:

```text
codex cloud list --env <environment-id> --json --limit 20 [--cursor <cursor>]
codex cloud exec --env <environment-id> --attempts 1 [--branch <branch>] <protected-prompt>
```

Only a small allowlist of process variables (`PATH`, the Codex/XDG home paths, locale, certificate, temporary-directory, and proxy settings) reaches the CLI. Praxis, OpenAI, Cloudflare, object-store, and media-provider secrets are not inherited. The one-use claim ticket appears only in the protected prompt's final argv value; default string, JSON, inspection, logs, and errors redact it. The protected prompt also carries the exact durable `stages` and `mode`; its objective is explicitly subordinate to that authority. The default producer objective is assembled only from the selected stages and never grants work in an omitted stage.

## Runtime

Required environment variables:

- `PRAXIS_API_BASE_URL` — staging control-plane origin; HTTPS is required except for loopback development.
- `PRAXIS_DISPATCHER_TOKEN` — bearer credential of at least 32 characters for only the internal dispatch endpoints.
- `PRAXIS_PROJECT_ID` — one project handled by this process.
- `PRAXIS_CODEX_ENVIRONMENT_ID` — pre-provisioned Codex Cloud environment that contains the repository and allows outbound access only to the staging Praxis API.

Optional variables:

- `PRAXIS_DISPATCHER_ID` — stable instance identity; defaults to a hostname-derived ID.
- `PRAXIS_DISPATCH_LEASE_SECONDS` — `60..1800`, default `600`. This bounds how long an asynchronously starting cloud task may retain its one-use claim ticket.
- `PRAXIS_DISPATCH_POLL_INTERVAL_MS` — `250..60000`, default `5000`.
- `PRAXIS_DISPATCH_RECONCILE_MAX_PAGES` — `1..20`, default `5`. Reconciliation scans at most 20 tasks per page (100 tasks by default) and stops on a repeated cursor.
- `PRAXIS_REPOSITORY_ROOT` — CLI working directory, default current directory.
- `PRAXIS_CODEX_BRANCH` — fixed branch sent to `codex cloud exec`.
- `PRAXIS_CODEX_EXECUTABLE` — binary path, default `codex`.
- `PRAXIS_DISPATCH_ONCE` — `1`/`true` for one reconciliation-and-lease iteration.

Build and run:

```bash
npm run build --workspace @praxis/codex-cloud-dispatcher
npm run start --workspace @praxis/codex-cloud-dispatcher
```

## Internal control-plane contract

The dispatcher calls only:

```text
POST /internal/agent-dispatch/lease
{ projectId, dispatcherId, leaseSeconds }
-> 204 or { run: { ..., stages, mode }, dispatchAttemptId, claimTicket }

GET /internal/agent-dispatch/runs?projectId=<id>&statuses=dispatching,dispatch_unknown,claimed,working,waiting_on_jobs,completed,failed,cancelled
-> { runs: [{ run, dispatchAttemptId }] }

POST /internal/agent-dispatch/runs/:runId/result
{ projectId, dispatchAttemptId, idempotencyKey,
  action: record_task | mark_unknown | mark_failed,
  codexTaskId?, codexTaskUrl?, errorCode?, errorMessage? }
```

Every request uses `Authorization: Bearer $PRAXIS_DISPATCHER_TOKEN`. Result idempotency keys are deterministic per run, attempt, and durable result payload, so retries are stable without conflating changed task identities or diagnostics.

Before submission, the service snapshots `codex cloud list`. After `exec` returns or fails, it lists again. An explicit task identity, one unique immutable run/attempt marker, or exactly one new task is accepted. Ambiguous or possibly-submitted failures become `mark_unknown`; a definite CLI rejection or a failure before submission becomes `mark_failed`. On restart, reconciliation follows opaque cursors only to the configured page cap, uses only an existing ID or an immutable marker, and never uses the weaker single-new-task inference. A miss never downgrades a claimed or terminal run and never triggers a second submission. Keep the Codex environment dedicated and raise the bounded page cap only when its task volume can push an acceptance task beyond the default 100-task window.

Tests use captured JSON fixtures and fake process/control-plane boundaries. They never call Codex Cloud:

```bash
npm run test --workspace @praxis/codex-cloud-dispatcher
npm run check --workspace @praxis/codex-cloud-dispatcher
```

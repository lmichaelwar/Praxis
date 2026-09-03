# ADR-002: Durable control plane and media workers

- Status: Accepted
- Date: 2026-08-26
- Scope: First distributed Praxis production path

## Context

Praxis began this handoff with one canonical, validated `ProductionProject` snapshot and a pure command engine. That baseline kept the snapshot, command envelopes, snapshot-backed inverses, locks, staleness propagation, history, checkpoints, Markdown projections, QC, and WebMCP catalog in the browser. React state mirrored to `localStorage` was authoritative; undo, redo, checkpoint bodies, simulated jobs, and spend were also browser-local.

The supported demonstration timeline is narrower than the schema: still-image/scene clips on a primary video track, one text overlay, narration, optional music, cuts, dissolves, and opacity fades at a fixed integer frame rate. Rendiv is not currently a dependency.

The distributed slice needs one serial authority, durable jobs and events, immutable external media, reload-safe clients, and a real renderer without creating another editable project format.

## Decision

### State boundary

`ProductionProject` remains the only canonical editable graph. It is stored as validated JSON in one `ProjectRoom` Durable Object selected by canonical `projectId`. The browser holds only a hydrated projection and transient UI state. UI, WebMCP, CLI, and system job commits all use the same revisioned command API.

The command package gains only the semantic operations needed to append immutable asset versions and deliberately select a version. Media bytes, jobs, event records, render manifests, and provider payloads are not embedded in `ProductionProject`.

### Storage

Cloudflare production uses a SQLite-backed Durable Object and R2:

- `project_state`: storage schema version, canonical revision, and validated snapshot;
- `history_state` and `operations`: undo/redo state, inverses, command audit, and idempotent results;
- `checkpoints`: materialized, validated snapshots;
- `jobs` and `budget_state`: durable orchestration and reservation/settlement state;
- `asset_records` and `renders`: immutable-object metadata and provenance;
- `events`: monotonically sequenced, reconnectable project events.

Schema changes are applied through an idempotent `_sql_schema_migrations` ledger. Command mutation, idempotency recording, history, budget transitions, and event append occur synchronously in the room's SQLite transaction. Duplicate idempotency keys return the recorded response; reuse with a different request hash is rejected.

R2 keys include a SHA-256 content address for assets and an exact revision/render identity for outputs. A filesystem object-store adapter implements the same immutable hash-checking contract for tests and local development. No media bytes are persisted in SQLite or command history.

Generated-object provenance records the authenticated creation actor, source job and base revision, provider/model, target entities, prompt or text hash, and bounded generation parameters. Large direct uploads use create-only, checksum-bound R2 PUT grants; a metadata-only finalize route trusts R2's verified SHA-256, size, and MIME metadata before registering an immutable record and returning ordinary command operations for adoption.

### API, identity, and live events

A stateless Worker gateway validates JSON, CORS, owner/capability authentication, request size, and route semantics, then invokes typed `ProjectRoom` RPC methods. Actor identity is derived from authentication, never trusted from request JSON. HMAC-SHA-256 capability tokens use Web Crypto and scope project, operations, expiration, optional run, spend ceiling, and denied entities. A thin `praxisctl` client consumes this API without logging credentials.

Project events are first persisted with a sequence number, then delivered over a reconnectable SSE endpoint. Clients reconnect with the last sequence; a detected gap causes full hydration. SSE is chosen for this bounded one-way stream and simple local/browser parity. SQLite events, rather than an in-memory emitter, remain the source of truth.

### Job model

Jobs use `queued`, `running`, `waiting_external`, `succeeded`, `failed`, `cancel_requested`, and `cancelled` states. The orchestration core is interface-driven. Cloudflare Workflows supplies durable production steps in both deployed and Wrangler-local modes; fake/OpenAI providers and the render adapter persist every transition through `ProjectRoom` RPC.

The gateway validates capability scope and denied job targets. `ProjectRoom.createJob` atomically validates the base revision and budget, reserves the conservative estimate, persists the job, and appends an event. Entity locks are enforced by the command engine when an output is adopted; a locked or incompatibly changed target instead produces a stale/unattached output. Every transition is compare-and-set and same-status replays do not increment attempts, settle, or emit twice.

Media success applies the optional system attachment command, immutable asset record, budget settlement, terminal job state, and durable events in one SQLite transaction. A revision conflict is rehydrated and retried; the final bounded fallback records the output unattached rather than overwriting or orphaning it. If cancellation wins after provider bytes were stored, the same transaction retains the asset as stale/unattached and completes the job as cancelled. Render finalization similarly commits the MP4/poster records, render record, budget, job, and events atomically. Renders always execute an immutable snapshot of one revision and become `outdated` when the live project advances.

Provider pricing and model selection live in provider configuration. Normal tests use deterministic image and WAV providers; OpenAI image and speech adapters are server-only and live tests are opt-in. Because the image and speech endpoints do not provide a documented idempotency guarantee, each billable provider step gets one total attempt; storage, command, and finalization steps retain bounded idempotent retries. Once a job enters `waiting_external`, an unknown provider failure settles the conservative estimate instead of silently refunding a potentially incurred charge.

### Render strategy

The canonical snapshot compiles deterministically to a versioned `RenderManifest`: sorted clips/assets, integer frames, explicit immutable versions and hashes, renderer version, exact project revision, and no signed URLs. The manifest is execution input, not an editable schema.

The first `RenderExecutor` is an independent containerized FFmpeg service. It accepts only a validated manifest plus job-scoped input/output access, verifies hashes, supports the bounded still/text/audio/fade subset, encodes H.264/AAC/yuv420p MP4, extracts a poster, runs `ffprobe`, and returns structural metadata. It never evaluates generated code, shell fragments, arbitrary URLs, or arbitrary paths.

Rendiv was evaluated from its current public API. Its primary composition contract is authored React/TypeScript and its workflow treats TSX as the composition source. Adopting that contract here would either make TSX a second authority or require generated component code, both prohibited by this slice. FFmpeg maps the bounded canonical manifest directly and is therefore the authoritative renderer. The `RenderExecutor` interface leaves room for a future fixed, reviewed Rendiv composition that accepts the manifest strictly as data if that integration becomes useful.

### Local topology

The integrated local path runs the studio, Wrangler Durable Object/Workflow/R2 emulation, and the independent render-worker HTTP service. The browser-local store remains only as an isolated test fixture. Cloud deployment configuration is provided, but deployment is reported only when authenticated credentials and bindings are actually available.

## Consequences

- Project mutation remains atomic and schema-compatible across browser, WebMCP, CLI, and workers.
- Reloads and control-plane restarts preserve projects, history, checkpoints, jobs, assets, renders, budgets, and events.
- Media work can continue while the director edits, with explicit stale/outdated results instead of silent replacement.
- The first renderer intentionally supports only the demonstrated timeline subset; unsupported clips fail structural preflight before expensive work.
- SSE gives durable one-way updates without collaborative presence; bidirectional WebSockets can be added later without changing event records.
- Cloudflare remains the production authority, while filesystem storage and the local runner make the complete path deterministic and testable without provider spend or cloud credentials.

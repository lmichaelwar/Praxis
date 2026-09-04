# Praxis

**Codex does video—without taking the cut away from the director.**

Praxis is a cooperative video-production studio where a person and a browser agent work on the same revisioned project. The director keeps the visible timeline, locks, checkpoints, budget, and final say; WebMCP gives the agent semantic tools for reading context and proposing or applying bounded changes.

- Live demo: <https://praxis-no-api-demo.hofwar.workers.dev>
- Record and submit: [HACKATHON_DEMO.md](HACKATHON_DEMO.md) — short narration, exact agent prompt, and recording checklist.
- Judge walkthrough: [docs/submission/testing-instructions.md](docs/submission/testing-instructions.md)

The hosted demo opens on a simple Praxis sign-in page. Judges enter the demo-only username and password supplied privately in Devpost; a successful sign-in creates a secure, HttpOnly session cookie and redirects into the Studio. HTTP Basic remains available for compatible automation. No credential belongs in this repository.

## What the demo shows

- One canonical video project shared by the Studio UI and WebMCP tools.
- Revision-checked semantic edits instead of simulated clicks or DOM scraping.
- A visible change ledger, undo/redo, checkpoints, stage policy, and entity locks.
- Durable project state and reconnectable events through a Cloudflare Worker and a SQLite-backed Durable Object.
- Deterministic structural QC and explicit stale/outdated results when project state moves ahead of generated media or renders.
- A bounded job architecture for media generation and FFmpeg rendering in the full codebase, without putting provider credentials in the browser. Those production actions are disabled in the hosted submission demo.

Praxis deliberately separates creative authority from execution. An agent can inspect the active selection and project revision, then call a purpose-built tool. The result travels through the same command path as a director edit and appears in the same interface.

## How WebMCP is used

The hosted Studio registers six deliberately bounded site tools with `document.modelContext`: project context, current selection, change history, atomic project operations, checkpoint creation, and structural QC. The full source catalog contains 14 tools, including delegation and durable media-job controls, but those provider and render actions are not exposed in the no-API submission deployment.

The key code is intentionally small and inspectable:

- [`packages/webmcp/src/tools.ts`](packages/webmcp/src/tools.ts) defines tool names, descriptions, JSON schemas, annotations, execution, and safe result summaries.
- [`packages/webmcp/src/register.ts`](packages/webmcp/src/register.ts) owns feature detection, registration, compatibility, and lifecycle cleanup.
- [`apps/studio/src/usePraxisWebMcp.ts`](apps/studio/src/usePraxisWebMcp.ts) adapts those tools to the open Studio project.
- [`apps/control-plane/src/index.ts`](apps/control-plane/src/index.ts) exposes the revisioned command and job API used by the Studio.

```text
browser agent -> WebMCP site tool -> Studio host -> control-plane command
                                                    |
director UI  <--- durable event + revision <---------+
```

WebMCP is the fit here because the browser has meaningful live context: the open project, current selection, current revision, and the director's visible controls. The agent gets a stable semantic contract while the person sees and can reverse the outcome.

## Run locally without an API key

Requirements: Node.js 22+, npm, and an FFmpeg-capable platform. Docker is optional.

```bash
npm install
npm run dev:full
```

Open `http://127.0.0.1:4173`. The launcher starts the Studio, the local Cloudflare control plane, and the render worker. Local durable state is written under ignored `.praxis-data/`.

No OpenAI API key is required. The hosted competition demo uses bundled existing media and does not invoke a media provider or depend on R2. The full local source includes deterministic, zero-cost provider adapters, while provider-backed generation and remote Codex Cloud dispatch remain outside the judged path. The demo is about safe human-agent coordination, not a claim about generative-model quality.

To verify the repository:

```bash
npm run test:all
npm run typecheck
npm run build
npm run audit
```

## Architecture

- `apps/studio` — React/Vite director interface and WebMCP host.
- `apps/control-plane` — Worker gateway, Durable Object, Workflows, R2 access, capabilities, and SSE.
- `apps/render-worker` — bounded FFmpeg/ffprobe render service.
- `apps/praxisctl` — JSON-first remote CLI.
- `packages/project-schema`, `commands`, and `history` — canonical project graph and reversible mutation engine.
- `packages/webmcp` — browser-facing semantic tool catalog.
- `packages/jobs`, `media`, `render-manifest`, and `qc` — durable work, immutable media, deterministic rendering, and structural checks.

The state and render boundaries are explained in [ADR-002](docs/architecture/adr-002-durable-control-plane.md).

## Honest limits

Praxis is a focused vertical slice, not a replacement for a full nonlinear editor. The renderer supports the demonstrated still, text, audio, cut, dissolve, and fade subset. QC is structural rather than aesthetic. The judged path does not depend on live provider generation or the optional remote Codex Cloud dispatcher.

## Submission-period work

Praxis was created for this challenge. The implementation in this repository was developed during the August 25–September 4, 2026 submission period; no pre-August 25 implementation is included.

## License

Original Praxis source code is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses.

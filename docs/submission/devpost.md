# Devpost submission copy

This document is ready to paste into Devpost after replacing the remaining video URL placeholder. Keep judge credentials only in Devpost's private testing-instructions field.

## Project name

Praxis

## Tagline

Codex does video—without taking the cut away from the director.

## Links

- Live app: <https://praxis-no-api-demo.hofwar.workers.dev>
- Public demo video: `{{VIDEO_URL}}`
- Source repository: <https://github.com/lmichaelwar/Praxis>

## Short description

Praxis is a cooperative video-production studio where a director and a browser agent work on one live, revisioned project. WebMCP gives the agent semantic tools to understand the open cut and make bounded changes; the director keeps visible control through locks, checkpoints, history, budgets, and the final decision.

## Inspiration

Most agent demos optimize for how much the agent can do alone. Creative work has a different problem: the person needs to keep authorship while still benefiting from fast, capable automation. Video makes that tension obvious. A useful agent should understand the actual cut, respect its current revision, and leave every change visible and reversible.

Praxis asks a simple question: what if an agent could work inside a production interface without pretending to be a mouse, and without becoming a second source of truth?

## What it does

Praxis opens a real production project with a script, scenes, assets, timeline, delegation policy, revision history, and structural quality checks. A director can work in the Studio normally. In a WebMCP-capable browser, the hosted demo lets an agent read current context and selection, apply semantic operations, create checkpoints, inspect history, and run deterministic QC. Provider generation, rendering, delegation, uploads, and background-job controls are visibly disabled for judging.

Every successful change advances the canonical project revision and appears in the same interface and ledger. Commands carry a base revision, so stale work fails as a conflict instead of silently overwriting a newer cut. In the broader source architecture, media and render results are also attached to the revision they were created from and can be marked stale or outdated when the project moves on.

## How we used WebMCP

The hosted Studio registers six bounded site tools through `document.modelContext`. They are not wrappers around UI clicks. Each tool has a bounded JSON schema, a clear read-only or mutating annotation, and a compact result designed for an agent rather than a duplicate project dump. The full source catalog contains 14 tools; the no-API judge deployment intentionally exposes only the six that can complete without providers, rendering, or remote delegation.

WebMCP is especially useful here because the browser knows which project, scene, timeline position, and revision the director is looking at. The agent can use that live context while the human sees the result in the application. Registration is feature-detected and tied to the Studio lifecycle, so the editor remains usable in an ordinary browser and stale tools are disposed when the project view goes away.

## How we built it

The frontend is React and Vite. Project state flows through a Cloudflare Worker to one SQLite-backed Durable Object per project. The same command path serves the director UI and WebMCP host, with revision checks, idempotency, checkpoints, history, jobs, and reconnectable server-sent events. The broader source architecture also implements R2-backed immutable media and an independent bounded FFmpeg render worker. TypeScript and Zod keep the project, command, job, and tool boundaries explicit.

The hosted judged demo uses bundled existing media; it does not use R2, invoke a media provider, or require an OpenAI API key. Provider-backed generation, rendering, and the optional remote Codex Cloud dispatcher are visibly outside the hosted judge path and are not necessary to evaluate the WebMCP collaboration loop.

## Challenges

The hard part was not registering a tool. It was preserving one authority while people, browser agents, workflows, and render workers can all act at different speeds. We had to make revisions, retries, idempotency, cancellation, stale outputs, and reconnects explicit so that an impressive demo could also be a trustworthy one.

We also kept the agent interface intentionally smaller than the internal project model. Agents receive enough context to act safely, but not an unbounded snapshot or any provider credential.

## Accomplishments

- A semantic WebMCP catalog that works against the director's live project context.
- Atomic, revision-checked edits visible in the Studio and its change ledger.
- Checkpoints, human-controlled restore, and deterministic structural QC.
- Durable project, job, media, and event boundaries designed for reconnects and retries.
- A complete local deterministic path with no paid provider dependency.

## What we learned

Human control is more than a confirmation dialog. It comes from shared context, narrow capabilities, visible state transitions, conflict detection, and a reliable way back. WebMCP made it possible to expose those ideas as part of the product itself instead of building a parallel agent-only control surface.

## What's next

Praxis currently supports a focused still, text, audio, cut, dissolve, and fade workflow. Next steps would broaden the fixed render vocabulary, add richer review and proposal flows, and evaluate perceptual QC while preserving the canonical command boundary.

## Built with

The hosted slice uses WebMCP, TypeScript, React, Vite, Cloudflare Workers, Durable Objects, SQLite, and Zod. The broader source path also includes Workflows, R2, FFmpeg, and Vitest.

## Submission-period disclosure

Praxis was created for this challenge. The implementation in the submitted repository was developed during the August 25–September 4, 2026 submission period; no pre-August 25 implementation is included.

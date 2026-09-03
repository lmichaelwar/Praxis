# Demo video script

Target length: **95–115 seconds**. Hard ceiling: **under 3 minutes**. Record one clean browser session with clear voice audio; avoid terminals, admin consoles, notifications, passwords, and private tabs.

## Before recording

- Use the final public deployment in a WebMCP-capable browser.
- Authenticate before recording, then reset the demo.
- Confirm **Synced to control plane** and **WebMCP · 6 bounded tools**.
- Put the browser at a readable zoom and select the first scene.
- Have the agent prompt ready to paste.
- Record at 1080p if practical and make a five-second audio test first.

## Shot list and narration

### 0:00–0:12 — The idea

**Picture:** Full Studio view. Move the pointer across the scene rail, preview, timeline, and ledger.

**Say:**

> This is Praxis: Codex does video without taking the cut away from the director. It is a cooperative production studio where a person and a browser agent work on one live, revisioned project.

### 0:12–0:30 — Human control

**Picture:** Select an unlocked scene, move the playhead, and point out the revision, locks, ledger, and visible **Submission demo · Existing media only** boundary.

**Say:**

> I keep the visible timeline, stage policy, locks, checkpoints, budget, and final decision. Every edit moves through one command path, and the ledger shows what happened. A stale edit gets a revision conflict instead of overwriting a newer cut.

### 0:30–0:52 — WebMCP context

**Picture:** Ask the agent: “Use the Praxis site tools to read the project context and current selection. Do not change anything.” Show the returned title, selection, and revision beside the matching Studio state.

**Say:**

> Praxis registers semantic WebMCP tools with the page. The agent reads the actual open project and my current selection—not pixels, simulated clicks, or a separate copy of the edit.

### 0:52–1:18 — A real tool mutation

**Picture:** Ask the agent to create a checkpoint and change only the selected beat title to **The Signal Answers** at the current revision. Show the title, revision, and ledger update.

**Say:**

> Now the agent creates a checkpoint and applies one bounded project operation. The title changes in the Studio, the canonical revision advances, and the same change is visible to me in the ledger. I can undo it or restore the checkpoint.

### 1:18–1:35 — Verification and architecture

**Picture:** Run QC through the agent, then use the human Restore control on the checkpoint in the ledger. If pacing allows, briefly show `packages/webmcp/src/tools.ts` and `apps/studio/src/usePraxisWebMcp.ts` in the public repository.

**Say:**

> Structural QC is a deterministic tool, while checkpoint restore stays under the director's visible control in this deployment. The six-tool catalog uses bounded JSON schemas and compact results, backed by a durable Cloudflare control plane. The hosted demo uses bundled existing media, so it needs no object store, paid model, or API key.

### 1:35–1:45 — Close

**Picture:** Return to the restored Studio overview and play a few seconds of the preview.

**Say:**

> WebMCP lets the agent act inside the creative context while the director can see, constrain, and reverse the work. That is Praxis.

## Upload check

- Final runtime is under 3:00.
- Voice is intelligible at normal volume.
- The video visibly includes the live Studio and one successful WebMCP tool mutation.
- The narration explains both what Praxis does and how it uses WebMCP.
- No credential, token, local path, private notification, or unrelated browser tab is visible.
- Upload to YouTube as **Public**, wait for processing, watch it once while logged out, then place `{{VIDEO_URL}}` in Devpost.

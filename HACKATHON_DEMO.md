# Praxis: tonight's demo and submission guide

Use the current existing-media release. No live provider generation, new API key, rendering, or deployment is needed for this recording.

**Ready for one browser-agent rehearsal.** The existing-media runtime is release `a7a177c`. On September 4, 250 executed tests and TypeScript checks passed. The public repository and MIT license were verified. The live sign-in page renders, and a fresh HTTP session login → checkpoint → title edit → ledger → restore test passed: revisions **9 → 10 → 11 → 12**, with the original title and script content restored.

**Still unverified:** an actual agent calling the registered WebMCP tools and the human Restore click in your recording browser. The HTTP test is not evidence of a WebMCP invocation, and the six-tool badge alone is not enough. Rehearse the prompt below once before recording. No live generation is installed.

## Get ready in five minutes

1. Open [Praxis](https://praxis-no-api-demo.hofwar.workers.dev/) in Chromium. Sign in before recording using the existing private demo credentials. Close unrelated tabs and private windows; silence notifications.
2. Wait for hydration and working controls. Confirm **Submission demo / Existing media only** and **WebMCP · 6 bounded tools**. Confirm the connected browser agent can actually discover and call those tools. Ordinary Chromium without a working WebMCP agent connection is not sufficient; if the prompt cannot call the tools, stop and report that specific blocker before recording a claimed agent edit.
3. Click **Reset demo**, then select row **01 / The premise** in the left rail. This selects `scene_01` / `beat_01`; do not use the initially selected third scene. Leave the scene unlocked.
4. Arrange the Studio and the agent's tool results so the title, revision, and right-hand **Action ledger** remain readable. Use a comfortable zoom. Keep this guide outside the captured area.
5. Rehearse the prompt below once, then click **Restore** on **Video baseline** yourself. Confirm the title returns to **The premise** and the revision advances. Reset once more and select row 01 for the real take. Do not promise a clean QC report: show whatever it actually reports.

## Copy-paste agent prompt

Paste this whole block into the browser agent connected to the open Praxis tab. It deliberately stops before the human restore.

```text
Use only the registered Praxis WebMCP site tools for this task, not simulated clicks, DOM scraping, direct HTTP requests, or code execution.

First call get_project_context and get_current_selection without changing anything. Require project_fax_oracle, scene_01, and beat_01. If the selection differs, a target is locked, or any required tool is unavailable, stop and tell me; do not select or unlock anything yourself.

Create a checkpoint named "Video baseline" with create_checkpoint at the current revision. Read the project context again for the latest revision.

Call apply_project_operations once, using that latest baseRevision, a fresh idempotencyKey, dryRun false, and exactly this one operation:
{"type":"script.updateBeat","beatId":"beat_01","patch":{"title":"The Signal Answers"}}
Use the reason "Video demo: change one script title". Do not change narration, media, timing, locks, delegation, or any other field.

Read get_change_history and run_qc at the resulting current revision. Briefly report the checkpoint name, resulting revision, recorded change, and actual QC findings. If a revision conflict or other error occurs, stop and report it; do not retry or claim success.

Then stop and say: "Please click Restore on Video baseline in the Action ledger." Do not restore, undo, reset, generate media, render, or make further changes yourself.
```

## Word-for-word narration

160 words; aim for 75–85 seconds. Read naturally. Only say an outcome after it is visible.

Praxis is a video production studio where a director and a browser agent work on the same project. The idea is simple: let the agent help, without taking the cut away from the person.

Here are the scenes, preview, timeline, and action ledger. This submission uses existing media; it is not generating new footage.

Through WebMCP, the agent can read my current selection and project revision. I ask it to save a checkpoint and change just one script title.

Watch the title become “The Signal Answers.” The revision advances, and the change appears in the ledger. This is a semantic project operation, not a sequence of simulated mouse clicks.

The agent also runs structural quality checks. Those checks report project consistency, not artistic quality.

Now I click Restore myself. The original title returns, with a new revision recording that decision.

That is the collaboration loop: shared context, a bounded change, visible evidence, and a human-controlled way back. That is Praxis.

## Matching shot list

| Time | Picture/action | Narration cue |
| --- | --- | --- |
| 0:00–0:15 | Start on the signed-in Studio overview; keep private credentials off screen. | “Praxis is a video production studio…” |
| 0:15–0:24 | Point briefly to scenes, preview, timeline, ledger, and Existing media only. | “Here are the scenes…” |
| 0:24–0:37 | Paste the prompt; show actual context/selection and checkpoint tool activity. | “Through WebMCP…” |
| 0:37–0:54 | Hold on The Signal Answers, the advanced revision, and its ledger entry. | “Watch the title become…” |
| 0:54–1:02 | Show the actual structural QC response, including any findings. | “The agent also runs…” |
| 1:02–1:11 | You click Restore on Video baseline; show The premise and the new revision. | “Now I click Restore myself…” |
| 1:11–1:25 | Restored Studio overview; stop on the visible shared project. | “That is the collaboration loop…” |

Allow real tool calls to finish. If they run longer, wait silently; trim only idle waiting if needed, preserving the real sequence. Never substitute a manual edit for the claimed agent operation. Target 60–90 seconds; keep the submitted video under the existing three-minute ceiling.

## Chromium + Omarchy recording

1. Make a five-second voice test first. Press **Alt + Print Screen** (or use Omarchy's Capture → Screenrecord menu), choose the microphone/voice-over option, and decline webcam. If the menu combines desktop sound and microphone, use that option and mute unrelated audio.
2. Choose the region containing the Studio and relevant agent results. Leave passwords, this guide, terminals, admin pages, and unrelated notifications outside it.
3. Stop with **Alt + Print Screen** again or the recording indicator. Play the test and confirm your voice is audible.
4. Start the actual take the same way. One rehearsal and at most two takes: keep the first clear, honest take.
5. Stop, open the saved recording (normally in the Videos folder), and watch it once. Check that the changed title and your Restore click are legible.

Capture shortcuts and start/stop behavior: [official Omarchy manual](https://learn.omacom.io/books/2/pages/53). Audio choices and recording output: [official recording guide](https://github.com/omacom/omarchy/blob/quattro/manual/12-screenshots-recording.md). Menu wording can vary by installed version.

## Tonight's timeboxes — September 4, EDT

Aim to submit by **01:00 EDT**. The **04:00 EDT / 08:00 UTC** cutoff is recorded in the existing organizer-email-based runbook, not freshly verified here. Do not use the remaining time for new features.

| Time | Finish this |
| --- | --- |
| 00:10–00:20 | Main task completes live verification; sign in and rehearse the exact prompt/Restore loop. |
| 00:20–00:35 | Five-second audio test, then one or two takes. |
| 00:35–00:50 | Upload the chosen video to YouTube as Public; let processing finish. Populate Devpost using existing copy. |
| 00:50–01:00 | Check links, private testing credentials, and video; submit and confirm Submitted, not draft. |
| 01:00–02:30 | Contingency only if not yet submitted: fix access, upload, or required-form blockers. No feature work. |
| 02:30–03:00 | If still unsubmitted, use the first valid video and finish submission now. |
| 03:00–03:30 | Last buffer for submission/access blockers; capture confirmation and freeze. Do not intentionally wait until this slot. |

If a slot has already passed, take the next essential step. Once submitted, freeze immediately; later slots are not permission to revise the submitted artifact.

## Final submission checklist

- [ ] Rehearsal has verified actual agent tool calls, checkpoint, title mutation, visible ledger/revision, QC response, and your Restore click in the intended recording browser. HTTP login/edit/restore is already verified separately.
- [ ] Video shows the successful agent mutation and your Restore action, explains WebMCP, and truthfully says existing media—not live generation or a newly rendered video.
- [ ] Video is intelligible, under three minutes, processed, **Public**, and playable while logged out; no credentials or private material appear.
- [ ] Devpost includes the [live app](https://praxis-no-api-demo.hofwar.workers.dev/), [public repository](https://github.com/lmichaelwar/Praxis), and actual video URL; no `{{VIDEO_URL}}` placeholder remains in submitted fields.
- [ ] Demo username/password are only in Devpost's private testing instructions. Test them in a fresh session; never put them in URLs, public copy, screenshots, or this file.
- [ ] Repository and MIT license are visible while logged out. Main task records the submitted commit and deployment identifier privately.
- [ ] Human completes YouTube publishing and Devpost's final submission/consent steps. Confirm **Submitted**, retain a private confirmation, and stop edits/pushes/redeployments.
- [ ] Leave the authenticated demo and video available through **September 21, 20:00 EDT / September 22, 00:00 UTC**. Reset the shared demo after verification/recording, not in the middle of somebody else's session.

## Source checks behind this guide

Existing [judge walkthrough](docs/submission/testing-instructions.md), [submission copy](docs/submission/devpost.md), and [freeze runbook](docs/submission/freeze-runbook.md) establish the current judged path and recorded deadline. The [six-tool allowlist](apps/studio/src/usePraxisWebMcp.ts), [beat-title view mapping](apps/studio/src/view-model.ts), [human Restore control](apps/studio/src/components/LedgerPanel.tsx), and [safe demo capability defaults](apps/studio/src/studio-capabilities.ts) support the narration. These source checks are not a substitute for the browser-agent rehearsal.

# Submission freeze runbook

The organizer's extension email sets the submission cutoff at **September 4, 2026, 1:00 AM PT / 4:00 AM ET / 08:00 UTC** (`2026-09-04T08:00:00Z`). The public Devpost page may lag, so retain the organizer email as deadline evidence rather than presenting the page as confirmation of the extension.

Our self-imposed final-submission and freeze target is **September 3, 10:00 PM PT / September 4, 1:00 AM ET / 05:00 UTC**, preserving a three-hour upload and submission buffer. Once submitted, make no further changes. In all cases, the absolute no-change boundary is `2026-09-04T08:00:00Z`.

Keep the submitted repository, live site, and public video available and behaviorally unchanged through **September 21, 2026, 5:00 PM PT / 8:00 PM ET**, which is `2026-09-22T00:00:00Z`.

## Before submitting

- [ ] Replace `{{VIDEO_URL}}` in the public submission copy; recheck the already-set live URL.
- [ ] Put demo credentials only in Devpost's private testing instructions.
- [ ] Verify the live app in a clean WebMCP-capable browser with no cached session.
- [ ] Run the exact judge walkthrough, including one discovered tool mutation and human-controlled checkpoint restore.
- [ ] Verify all app, API, and media requests work behind the judge credential.
- [ ] Verify the repository is public while logged out and GitHub detects the MIT license.
- [ ] Confirm ignored local state, evidence, raw planning material, and credentials are absent from the public repository.
- [ ] Confirm the YouTube video is Public, processed, audible, and under three minutes while logged out.
- [ ] Record the final repository URL, commit SHA, release tag, deployment URL, deployment identifier, video URL, and UTC time in private evidence.
- [ ] Save Devpost and verify the project is marked **Submitted**, not draft.

## Freeze boundary

At the self-imposed freeze, and no later than `2026-09-04T08:00:00Z`:

1. Tag the exact submitted commit and retain a local clone or bundle of it.
2. Retain checksums or immutable identifiers for the deployed artifacts.
3. Stop all pushes, merges, releases, content edits, configuration changes, migrations, and routine redeployments against the submitted repository and site.
4. Do not replace, trim, re-upload, or change the visibility of the submitted video.
5. Disable any automation that could deploy on a branch update or dependency refresh.

Do not continue work on a branch in the submitted repository. Put post-submission development in a separate local copy and, if it must be published before judging ends, a separate repository and separate deployment with no shared production route.

## During judging

- Monitor availability without changing the judged artifact.
- Keep the demo credential valid and keep the hosting account, domain, storage, and video online.
- Store monitoring evidence outside the submitted repository.
- If availability fails, do not redeploy, migrate, or edit the judged release during the freeze. Record the incident and contact the human and organizer before an intervention. Only an already-implemented, authorized fail-closed control may be used without changing the release; its existence must not be assumed. The current authority does not permit routine recovery redeployments during judging.
- Never rotate a judge credential without updating the private testing instructions through an organizer-approved path.

## After judging

After `2026-09-22T00:00:00Z` (September 21 at 5:00 PM PT / 8:00 PM ET), confirm judging has ended before unfreezing. Preserve the submitted tag and release as the historical competition artifact, then reconcile later work from the separate continuation repository deliberately.

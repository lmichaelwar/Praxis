# Judge testing instructions

> Copy the relevant portion into Devpost's private testing-instructions field. Replace credential placeholders there only; never commit real credentials to this repository.

## Access

- Live app: <https://praxis-no-api-demo.hofwar.workers.dev>
- Browser: ChatGPT's in-app browser or Chrome with WebMCP enabled
- Username: `{{DEVPOST_USERNAME}}`
- Password: `{{DEVPOST_PASSWORD}}`

Normal browser navigation opens a simple Praxis sign-in page. Enter the private Devpost credential there and submit the form. A successful sign-in sets a secure, HttpOnly session cookie and redirects to the Studio; then allow the project to hydrate. The Studio, API, and media are protected by the same demo-only access boundary. HTTP Basic remains available for compatible automation, but no separate account creation or paid API key is required.

## Clean test

1. Open the live URL in a clean browser profile or incognito window.
2. On the Praxis sign-in page, enter the username and password above and submit the form.
3. Wait for the redirect and project hydration. The Studio header should then show a project revision, **Synced to control plane**, and **WebMCP · 6 bounded tools**.
4. Choose **Reset demo** in the header. This returns the shared judge project to the deterministic Fax Oracle seed.
5. Select the first unlocked scene in the left rail, then give the browser agent this prompt:

   > Use the Praxis site tools. First read the project context and current selection without changing anything. Create a checkpoint named "Judge baseline" at the current revision. Then change only the selected script beat's title to "The Signal Answers", using the latest revision. Finally, read the change history and run structural QC at the resulting revision. Stop and report the current revision if you encounter a revision conflict.

6. Confirm three visible results in the Studio:

   - the project revision advances;
   - the selected scene title becomes **The Signal Answers**;
   - the change appears in the right-hand ledger.

7. In the right-hand ledger, use the human **Restore** control on **Judge baseline**. Confirm that the title reverts and another revision appears. Checkpoint restore is deliberately director-controlled in this deployment.
8. Use **Reset demo** once more when finished so the shared project is ready for the next evaluator.

## What this proves

- The agent discovers and calls tools registered by the live site.
- Read operations use the open browser context and do not mutate state.
- A WebMCP mutation travels through the same revisioned command path as the director UI.
- The resulting state is immediately visible and reversible in the human interface.
- Structural QC reports deterministic project checks; it does not claim aesthetic judgment.

## Troubleshooting

- If the sign-in page reports invalid credentials, re-enter the values exactly as supplied in Devpost. Do not put them in the URL or share them outside the private testing field.
- If the page says **Hydrating project**, wait a few seconds. If it becomes **Project unavailable**, use **Retry connection** once.
- If the status dot says WebMCP is unavailable, confirm that the browser has WebMCP enabled, then reload the page.
- A `REVISION_CONFLICT` is safe behavior, not lost work. Ask the agent to read the current project context and retry once with the new revision.
- Because this is a shared deterministic demo, use **Reset demo** before and after the walkthrough.

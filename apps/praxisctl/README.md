# `praxisctl`

`praxisctl` is the non-interactive membrane for short-lived remote clients. It
prints JSON by default, uses meaningful nonzero exit codes, and never accepts a
token on the command line.

```bash
export PRAXIS_API_BASE_URL=http://127.0.0.1:8787
export PRAXIS_CAPABILITY_TOKEN='...'

npm start --workspace @praxis/praxisctl -- project get --project project_fax_oracle
npm start --workspace @praxis/praxisctl -- command apply --project project_fax_oracle --file command.json
npm start --workspace @praxis/praxisctl -- job create --project project_fax_oracle --file job.json
npm start --workspace @praxis/praxisctl -- job status --project project_fax_oracle --job job_123
npm start --workspace @praxis/praxisctl -- job cancel --project project_fax_oracle --job job_123
```

Authentication uses `PRAXIS_CAPABILITY_TOKEN`, falling back to
`PRAXIS_OWNER_TOKEN` for owner-only local development. Tokens are sent only as
Bearer headers and are redacted from all CLI output.

## Codex Cloud AgentRun session

The one-use claim ticket is the only credential placed in the cloud task
instruction. Claiming does not require a Bearer token:

```bash
npm start --workspace @praxis/praxisctl -- agent claim --ticket "$PRAXIS_AGENT_CLAIM_TICKET"
npm start --workspace @praxis/praxisctl -- agent context
npm start --workspace @praxis/praxisctl -- agent heartbeat
npm start --workspace @praxis/praxisctl -- agent finish --status waiting_on_jobs --summary "Preview render queued."
```

`agent claim` exchanges the ticket once and saves only the resulting run-bound
capability outside the repository: under `$XDG_RUNTIME_DIR/praxis/` when
available, otherwise under the current user's private Praxis directory in the
OS temporary directory. `PRAXIS_AGENT_SESSION_FILE` or `--session-file` may
override that path. The directory is created owner-only; each claim or
heartbeat writes a same-directory `0600` temporary file and atomically replaces
the session with the capability whose expiry matches the durable lease. Neither
the ticket nor capability is printed. Later `agent` commands infer the project
and run from that session and do not fall back to an owner token. Other commands
(such as `command apply` and `job create`) use the claimed session as a fallback
when no reusable token is present and reject a mismatched `--project`.

# `@praxis/remote-client`

Typed, non-interactive access to the Praxis control plane. The client sends an
owner or capability token only as a Bearer authorization header and never logs
requests, headers, or credentials.

```ts
import { PraxisRemoteClient } from "@praxis/remote-client";

const client = new PraxisRemoteClient({
  baseUrl: process.env.PRAXIS_API_BASE_URL!,
  token: process.env.PRAXIS_CAPABILITY_TOKEN,
});

const state = await client.getProject("project_fax_oracle");
```

The SSE subscriber reconnects with both `afterSequence` and `Last-Event-ID`.
Callers receive an explicit gap callback before a non-contiguous event is
delivered, allowing them to refetch authoritative project hydration.

Browser requests include credentials so a Studio session can use the secure,
HttpOnly Praxis cookie. `createBrowserSession()` exchanges the reverse proxy's
verified Access identity at `/auth/session` without forwarding any configured
Bearer token.

AgentRun methods cover create/list/get/context/heartbeat/finish/cancel. The
one-use `claimAgentRun()` exchange is deliberately bearer-free and returns a
short-lived capability that callers must treat as a secret.

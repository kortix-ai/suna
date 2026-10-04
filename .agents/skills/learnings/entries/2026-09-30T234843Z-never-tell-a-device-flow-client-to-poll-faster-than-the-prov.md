---
recorded: 2026-09-30T23:48:43Z
incident_date: 2026-10-01
---
# Never tell a device-flow client to poll faster than the provider's own interval

**Rule:** A device-code OAuth poll answer carries the provider's interval (`interval` from the device-code response), never a faster house default. Seal it into the flow handle and return it as `next_poll_ms`. Treat the provider's transient errors (`server_error`, `temporarily_unavailable`, 5xx) as pending; only `access_denied`, `expired_token`, or the handle's own expiry end the flow.

**Trigger surface:** Adding or changing an OAuth device flow (`apps/api/src/http/projects/provider-oauth.ts`), or a client that polls it (web card, `kortix providers login`).

**Incident:** 2026-10-01, dev, right after OpenCode sign-in shipped (#8520/#8535). The API answered pending polls with `next_poll_ms: 3000`; OpenCode's interval is 5 s. `kortix providers login opencode-go` adopted 3 s. After the person approved the device, OpenCode's token endpoint answered `server_error` to every fast poll until the code expired, and the API ended the flow on the first one. Both dev CLI sign-ins failed; the web card, which kept 5 s, succeeded. A diagnostic that polled one approved code at 3 s saw only `server_error` and `authorization_pending` until `expired_token`.

**Enforcement:** `apps/api/src/__tests__/unit-project-oauth-byos.test.ts` ("a pending poll asks the client to wait the provider interval, never less"), `apps/api/src/services/llm-gateway/credentials/opencode-console.test.ts` ("poll stays pending through a transient console fault").

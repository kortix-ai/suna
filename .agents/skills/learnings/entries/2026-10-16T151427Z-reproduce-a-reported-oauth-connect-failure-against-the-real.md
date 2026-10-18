---
recorded: 2026-10-16T15:14:27Z
incident_date: 2026-10-12
---
# Reproduce a reported OAuth connect failure against the real provider before touching UX, and never swallow the token-exchange error

**Rule:** When a user reports that an OAuth connect fails, run the real authorization against the real provider first: discovery, client registration, authorize, and the code exchange, with the production lifecycle functions and a loopback callback. Read the provider's own error body before you change any UX. In the token request, send exactly one client authentication method: with `client_secret_basic` the client goes in the `Authorization` header only, never also as a body `client_id`. A `catch` that maps a failure to a redirect code (`token_exchange_failed`) must log the cause.

**Trigger surface:** Any change to `apps/api/src/connectors/oauth2-lifecycle.ts`, `oauth2-registration.ts` or `oauth2-store.ts`, and any report of `token_exchange_failed`, `invalid_client` or "connecting an MCP does not work".

**Incident:** 2026-10-12, reported on prod in a screen recording; fixed 2026-10-16 (KRTX-2185). A custom MCP connector whose authorization server accepts both `client_secret_basic` and `client_secret_post` failed every sign-in after the consent screen with `token_exchange_failed`. Kortix sent `Authorization: Basic …` plus a body `client_id`. The server read the body `client_id` as `client_secret_post` and answered `401 invalid_client: Missing client_secret.` The callback `catch` logged nothing, so the cause was invisible for 4 days. The fix was found in under 10 minutes once the exchange ran against the real provider.

**Enforcement:** `apps/api/src/connectors/oauth2-lifecycle.test.ts` ("client_secret_basic sends the client only in the Authorization header") goes red when a body `client_id` comes back with Basic auth. `oauth2-store.ts` logs `[connector] OAuth code exchange failed` with the cause.

---
recorded: 2026-10-06T16:15:53Z
incident_date: 2026-10-06
---
# Give every caching getToken an invalidate hook, or the SDK 401 replay re-sends the dead token

**Rule:** A `getToken` that caches (web 30 s cache, mobile session read) carries `invalidate(rejectedToken)` that forces a fresh token (Supabase `refreshSession`), and drops the cache only when the rejected token is the cached one. Without it the transport 401 replay reads the same cached token and returns the 401.

**Trigger surface:** Wiring `configureKortix`/`createKortix` in a host, or changing a host token cache; touching `packages/sdk/src/core/http/transport.ts`.

**Incident:** 2026-10-06 audit: only the app-viewer helper implemented `invalidate`. On web and mobile a token rejected server-side but not yet expired kept failing for up to 30 s. `invalidateTokenCache()` (SSE auth recovery) was a no-op. Local stack proof: a request with a rejected token returned 401, then a `refresh_token` grant, then the replay returned 200 with no page reload.

**Enforcement:** `packages/sdk/src/core/http/transport.test.ts` (invalidate called once per rejected token, single flight), `apps/web/src/lib/auth-token.test.ts` and `apps/mobile/api/refreshing-token.test.ts` (forced refresh). None yet for a new host that omits `invalidate`: the SDK cannot detect a caching getter.

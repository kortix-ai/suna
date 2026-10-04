---
recorded: 2026-09-30T17:10:47Z
incident_date: 2026-09-30
---
# Re-check a cached credential against its row before handing it out; a revoke on one replica never reaches another replica's memory

**Rule:** An in-process cache of a credential (a token plaintext, a signed handle) must re-validate the credential's row before it hands the credential out. Clearing the cache inside the revoke function is not enough: the revoke runs on one API replica, and every other replica keeps its copy.

**Trigger surface:** adding or changing a `Map`/LRU that holds a credential, and any code path that revokes one (`revokedAt`, status flips, policy saves) while another process may hold it. Related: `2026-08-24T082044Z-provider-traffic-credentials-need-a-cross-replica-refresh-bo.md`.

**Incident:** 2026-09-30, a self-hosted deployment with 2 API replicas. Every access-policy save on an App with `viewer_token_scope: 'api'` revoked its viewer tokens in the DB, but `mintAppViewerToken` on the other replica kept serving the dead token for up to 55 min: 119 of 228 viewer-token API calls (52%) answered `401 Invalid OAuth access token`. Reproduced with 2 local replicas (5 of 10 → 0 of 10 after the fix). The same App's Caddy access log also printed the viewer token and the provider ingress token.

**Enforcement:** `apps/api/src/apps/viewer-token.integration.test.ts` ("a token revoked outside this process is never handed out again") goes red when the cache hit skips the row check. Log redaction: `TestCaddyAccessLogDropsRequestHeaders` in `apps/kortix-app-runtime/main_test.go`.

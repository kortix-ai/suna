---
recorded: 2026-10-01T06:55:38Z
incident_date: 2026-10-01
---
# Never put a per-request GoTrue call on the auth hot path without a full local core run: local GoTrue runs out of ports

**Rule:** Before adding a GoTrue `/user` call to every authenticated request (for example liveness for ES256/JWKS tokens in `apps/api/src/shared/jwt-verify.ts`), run the full local core suite (`pnpm test`) on an isolated-DB worktree and read `docker logs supabase_auth_<project>`. Ship a cached or pooled check, not a per-request call.

**Trigger surface:** Changing `verifySupabaseJwt`, `confirmJwtLive` (`apps/api/src/shared/jwt-liveness.ts`), the `auth.sessions` lookup in it, or any auth middleware that calls GoTrue.

**Incident:** 2026-10-01, near-miss while repairing AUTH-1 after #8559. Routing ES256 tokens through `confirmJwtLive` (TTL 0) fixed the logout assertion. In the full core run, GoTrue then served about 3,200 `/user` calls in about 50 s and logged 235 × `dial tcp …:5432: connect: cannot assign requested address`: it ran out of ephemeral ports for DB connections. 31 of 509 flows failed with `401`, while `auth.sessions` still held the shared OWNER session. The change was reverted before merge. AUTH-1 now proves the revoke through `POST /v1/p/auth`, and the ES256 revocation window is a tracked follow-up.

**Enforcement:** the full `pnpm test` core run (31 flows fail with `401` when GoTrue runs out of ports). No dedicated gate.

**Update 2026-10-20 (#10467):** `confirmJwtLive` no longer calls GoTrue for a token with a `session_id` claim. It reads `auth.sessions` + `auth.users` in the API's own Postgres: one primary-key query per authenticated request, no cache, no staleness window. `SUPABASE_JWT_LIVENESS_TTL_MS` and its per-replica cache are removed. The load moved from GoTrue to the API pool, which uses a direct `:5432` connection on prod: budget one pooled query per authenticated request there. GoTrue `/user` is still called on every request for a token without `session_id` and whenever the DB read fails. A failed DB read logs `jwt-liveness: auth.sessions lookup failed` at most once a minute; a stream of those lines means every request is back on the GoTrue hop and this rule applies again. The lookup assumes the API DB is GoTrue's DB: `--db` worktrees mirror `auth.sessions` from the primary for that reason (`scripts/worktree/lib/branch-db.ts`).

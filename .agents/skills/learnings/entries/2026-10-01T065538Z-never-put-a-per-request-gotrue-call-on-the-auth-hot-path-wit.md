---
recorded: 2026-10-01T06:55:38Z
incident_date: 2026-10-01
---
# Never put a per-request GoTrue call on the auth hot path without a full local core run: local GoTrue runs out of ports

**Rule:** Before adding a GoTrue `/user` call to every authenticated request (for example liveness for ES256/JWKS tokens in `apps/api/src/auth/jwt-verify.ts`), run the full local core suite (`pnpm test`) on an isolated-DB worktree and read `docker logs supabase_auth_<project>`. Ship a cached or pooled check, not a per-request call.

**Trigger surface:** Changing `verifySupabaseJwt`, `confirmJwtLive`, `SUPABASE_JWT_LIVENESS_TTL_MS`, or any auth middleware that calls GoTrue.

**Incident:** 2026-10-01, near-miss while repairing AUTH-1 after #8559. Routing ES256 tokens through `confirmJwtLive` (TTL 0) fixed the logout assertion. In the full core run, GoTrue then served about 3,200 `/user` calls in about 50 s and logged 235 × `dial tcp …:5432: connect: cannot assign requested address`: it ran out of ephemeral ports for DB connections. 31 of 509 flows failed with `401`, while `auth.sessions` still held the shared OWNER session. The change was reverted before merge. AUTH-1 now proves the revoke through `POST /v1/p/auth`, and the ES256 revocation window is a tracked follow-up.

**Enforcement:** the full `pnpm test` core run (31 flows fail with `401` when GoTrue runs out of ports). No dedicated gate.

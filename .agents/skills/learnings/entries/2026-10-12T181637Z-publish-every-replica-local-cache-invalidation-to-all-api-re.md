---
recorded: 2026-10-12T18:16:37Z
incident_date: 2026-10-12
---
# Publish every replica-local cache invalidation to all API replicas; a per-process bust leaves the other replica serving stale authz

**Rule:** A cache that lives in one API process (a `replica-local:` Map or Set) and gates access must be invalidated on every replica. Publish the bust on the shared `pg-broadcast` listener (`apps/api/src/shared/pg-broadcast.ts`) and apply it on receipt; never rely on clearing only the process that took the write. Prove it with two cache instances or two API processes, not one: keep-alive pins a single client to one replica, so a single-replica test passes while the bug ships.

**Trigger surface:** Adding or changing a module-level cache in `apps/api/src/iam/` or any authz, membership, role or grant read path; changing `iam/cache-invalidation.ts`.

**Incident:** 2026-10-12, release gate flow INV-1, red in about 1 of 2 gate runs since it existed. After a member's demotion, `invalidateIamCacheForUser` cleared the role cache only on the replica that handled the demotion. Run 38276250061 against staging (2 API replicas): read 1 after the demotion returned `[]`, read 2 returned the full invite list. The flow's old check, "8 empty reads in a row", passed whenever keep-alive kept it on one replica, so the gate read it as a flake. Prod runs multiple replicas, so a demoted member kept the old role on the other replica until its cache expired.

**Enforcement:** `apps/api/src/__tests__/integration-iam-cache-bust-notify.test.ts` (db-suites) fails when a bust does not reach a second listener. Flow INV-1 now requires every read after the demotion to be empty.

---
recorded: 2026-09-25T03:00:36Z
incident_date: 2026-09-25
commit: b34ef3cb91
---
# A live-schema check that ignores indexes and constraints passes a crippled table

**Rule:** Verify a live environment against a freshly migrated database for
index DEFINITIONS and constraint definitions, not only tables and columns. A
faked baseline copies the ledger, not the objects. **Trigger surface:** faking
or re-baselining an environment, or triaging a slow query on prod only.
**Incident:** prod `credit_ledger` (2.7M rows) had 4 of its 15 indexes, and
`account_memberships` had no primary key. `verify-live-schema.ts` reported OK
because it compared tables and columns only. Account-scoped ledger reads ran
2.0 s mean (4,804 calls); prod-only because dev/staging ran the real baseline.
**Enforcer:** `verify-live-schema.ts` now fails on missing index/constraint
definitions (waivers with evidence in `verify-live-schema-waivers.ts`), PR #7635.

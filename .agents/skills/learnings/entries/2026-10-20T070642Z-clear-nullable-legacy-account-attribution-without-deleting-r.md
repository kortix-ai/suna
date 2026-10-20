---
recorded: 2026-10-20T07:06:42Z
incident_date: 2026-10-18
---
# Clear nullable legacy account attribution without deleting referenced versions

**Rule:** Clear nullable NO ACTION references to a deleted legacy account instead of deleting the referencing rows. Refuse unknown NOT NULL references. Creator attribution does not establish ownership.

**Trigger surface:** Account erasure and cleanup of legacy basejump account references.

**Incident:** KRTX-2754, 2026-10-18. Account erasure deleted creator-attributed agent versions still referenced by another agent's current-version pointer. PostgreSQL refused the delete, leaving erasure retrying.

**Enforcement:** `apps/api/src/billing/services/integration-account-deletion.test.ts` retains another account's current agent version, clears its creator attribution, and refuses an unknown NOT NULL account reference.

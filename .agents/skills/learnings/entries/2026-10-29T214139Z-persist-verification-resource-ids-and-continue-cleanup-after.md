---
recorded: 2026-10-29T21:41:39Z
incident_date: 2026-10-29
---
# Persist verification resource IDs and continue cleanup after deletion failures

**Rule:** Persist non-secret owned resource IDs before the first remote write or login.
Attempt each cleanup independently with bounded retries. Always close the database.
Aggregate cleanup failures and retain failed IDs until deletion read-back succeeds.

**Trigger surface:** Browser or API verification that creates synthetic provider volumes, projects, accounts, or users.

**Incident:** 2026-10-29, Artifact browser verification. A failed Artifact publish was followed by a volume DELETE timeout.
A sequential `finally` stopped before project, account, auth, and local repository cleanup.
Scoped recovery verified one owned volume DELETE204/GET404, project/account counts0, and two synthetic auth users404.

**Enforcement:** `tests/unit/resource-stack-cleanup.test.ts` injects one failure into the existing fixture cleanup stack and proves later resources run.
The operator helper uses per-resource aggregate cleanup and a final database close.
Its isolated `PROOF_CLEANUP_FAULT_TEST=1` check proves one injected failure, four later resource attempts, and database close without creating resources.

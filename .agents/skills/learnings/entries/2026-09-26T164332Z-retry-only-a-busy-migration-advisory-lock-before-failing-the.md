---
recorded: 2026-09-26T16:43:32Z
incident_date: 2026-09-26
---
# Retry only a busy migration advisory lock before failing the dev deploy

**Rule:** Retry node-pg-migrate's exact advisory-lock-busy error for at most 60 seconds. Retry the whole pending-migration runner only after lock acquisition fails. Keep unrelated migration errors fail-closed. Verify the deployed API SHA after the gate succeeds.

**Trigger surface:** `packages/db/scripts/migrate.ts` and the dev migration gate in `deploy-dev.yml`.

**Incident:** On 2026-09-26, dev deploy run 36254970866 failed with `Another migration is already running`. Its API job was skipped while gateway and frontend deployed. The dev API stayed on an older SHA until a later run acquired the lock.

**Enforcement:** `packages/db/scripts/migration-retry.test.ts` fails when the exact lock error is not retried, when the retry limit is ignored, or when deadlock and deterministic-error behavior changes.

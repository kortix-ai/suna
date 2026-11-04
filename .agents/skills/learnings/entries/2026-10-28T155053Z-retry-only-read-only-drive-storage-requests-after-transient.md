---
recorded: 2026-10-28T15:50:53Z
incident_date: 2026-10-28
---
# Retry only read-only Drive storage requests after transient 503 responses

**Rule:** Retry a Drive storage GET after a transient upstream 503 at most twice, after 2 and 3 seconds. Release the failed response body first. Stop when the caller aborts. Never replay a write: the provider may have committed it before returning an error.

**Trigger surface:** `apps/api/src/drives/volumes.ts`, the shared Platinum volume adapter used by Files and background Drive workers.

**Incident:** KRTX-3607: volume metadata and file listing returned upstream 503s in prod. A file-listing request succeeded five seconds after the failed request. The adapter previously exposed the first transient failure immediately.

**Enforcement:** `apps/api/src/drives/volumes-retry.test.ts` verifies recovery, bounded exhaustion, single-attempt writes, non-transient errors and cancellation. Persistent outages still produce the existing typed storage error; this does not hide them from telemetry.

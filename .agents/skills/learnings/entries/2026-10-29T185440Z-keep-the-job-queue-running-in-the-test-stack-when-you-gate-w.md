---
recorded: 2026-10-29T18:54:40Z
incident_date: 2026-10-29
---
# Keep the job queue running in the test stack when you gate workers

**Rule:** When you gate `startJobWorker()` behind a worker switch, keep the deterministic test stack (`tests/src/core/local-stack.ts`) running the job queue. That stack sets `KORTIX_WORKERS_ENABLED=false`, so it now also sets `KORTIX_JOB_WORKER_ENABLED=true`. Held connector calls and Capture ingest run only as queued jobs.

**Trigger surface:** Editing `apps/api/src/bootstrap.ts` worker gating, or adding a feature that runs through `enqueueJob`.

**Incident:** 2026-10-29, dev commit 8bf7060e4e moved `startJobWorker()` under `KORTIX_WORKERS_ENABLED`. Local flows that wait on a queued job timed out: CAP-2 ("every item to index", 92 s) and CONN-42 ("the held call run settles", 46 s). Caught while merging dev into PR #11103; no deploy affected.

**Enforcement:** CAP-2 and CONN-42 in the `core-flows` lane go red when the test stack runs no job worker.

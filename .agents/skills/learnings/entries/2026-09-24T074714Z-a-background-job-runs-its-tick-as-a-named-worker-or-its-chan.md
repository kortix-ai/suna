---
recorded: 2026-09-24T07:47:14Z
incident_date: 2026-09-24
commit: 282dcdd68d
---
# A background job runs its tick as a named worker, or its changes read as API traffic

**Rule:** Wrap every background job's tick in `runWorkerTick('<name>', tick)` (`shared/audit-scope.ts`), at the tick function when handlers also kick it. A tenant-state change the job makes writes its own semantic row, which inherits the worker.

**Near-miss (2026-09-24):** none of the API's 21 background jobs ran with a request context. IAM grant expiry and audit reconciliation rows read `source: api`. Expired tunnel permissions, deleted session branches, App deployment outcomes, and provider transitions wrote no row.

**Enforcement:** `unit-worker-scope-wiring.test.ts` fails when a job stops wrapping its tick, a new `setInterval` file is unclassified, or `index.ts` starts an unclassified job.

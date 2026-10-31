---
recorded: 2026-10-31T21:11:14Z
incident_date: 2026-10-29
---
# Never run a scheduled job on an autoscaled web server: register it in worker/jobs, where only the worker service runs it

**Rule:** A scheduled job is one file in `apps/api/src/worker/jobs/` and one entry in the registry `worker/jobs/index.ts`. Only the lease holder runs it: the worker service (`src/worker.ts`) in production, the single `all` process elsewhere. Web servers run `KORTIX_PROCESS_ROLE=web` and never join the leader election. A loop that every web process must run goes in `replica/` with its reason in `PER_PROCESS`. A job imports no route and no middleware.

**Trigger surface:** adding or changing a background loop, a `setInterval`/`leaderTimer`, `bootstrap.ts`, `shared/leader-election.ts`, or the API's ECS services and deploy roles.

**Incident:** 2026-10-27 to 10-30, prod. The elected leader ran ~30 jobs and served traffic on one 1 vCPU task. Its job CPU (0.94 cores before v0.14.12, 0.73 after) kept the fleet's average CPU near the 55 % target. Autoscaling swung 3 → 9-10 tasks several times a day (65 scaling actions on 10-29), and scale-in kept killing the leader, which restarted the jobs elsewhere. Fixed by the worker service: the PR that adds this entry.

**Enforcement:** `apps/api/src/__tests__/unit-worker-scope-wiring.test.ts` (a worker is in the registry or in `PER_PROCESS`; `bootstrap.ts` starts no job), `unit-worker-entry-imports.test.ts` (the worker's import graph gains no HTTP module), `unit-bootstrap-workers.test.ts` (a `web` process never joins the election), and the `Kortix/Worker` `StaleJobs` and worker running-task alarms.

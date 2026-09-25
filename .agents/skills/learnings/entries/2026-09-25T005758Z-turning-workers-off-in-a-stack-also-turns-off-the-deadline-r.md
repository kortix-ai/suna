---
recorded: 2026-09-25T00:57:58Z
incident_date: 2026-09-24
commit: e6e04788ce
---
# Turning workers off in a stack also turns off the deadline reaper; a shared provider org needs an owner tag on every child box

**Rule:** A stack that sets `KORTIX_WORKERS_ENABLED=false` runs no project
maintenance, so `deadline_at` never stops an idle session box and the
provider's idle timer is the only stop. Never disable workers in a stack that
creates real sandboxes. When several stacks with separate databases share one
provider org and one `kortix.env` tag, stamp every child box with its owning
stack (`KORTIX_INSTANCE_ID` -> `kortix.instance`) BEFORE enabling an orphan
reaper: an unscoped reaper stops every other stack's live boxes, because they
have no row in its database. **Trigger surface:** any `KORTIX_*_ENABLED` change
in `tests/src/core/preview-stack.ts` or a self-host profile; any provider
listing used to stop or delete boxes.

**Incident:** 2026-09-23/24. Preview APIs ran with workers off since #6347
(2026-08-10). 87 idle 4 GB preview session boxes (348 GB, 42 idle > 6 h) plus
9 preview hosts filled the shared 524288 MB Platinum pool. Every preview deploy,
every preview session and every dev session returned `429 org resource pool
exhausted`. Evidence from the provider listing: of 262 stopped preview session
boxes, 85 stopped at 700-740 min idle (the 720 min native timer), versus 4144 of
4779 dev boxes at < 20 min (the deadline reaper). The session boxes carried no
tag naming their preview, so teardown could not find them either.

**Enforcers:** `previewWorkerEnvironment()` enables maintenance only with an
instance id (`tests/unit/preview-stack.test.ts`); `providerBoxBelongsToThisInstance`
lists only exactly-stamped boxes (`platinum-list-managed.test.ts`); teardown,
PR-preview replacement, every deploy and the daily reconcile stop owned,
orphaned and > 6 h idle preview session boxes, never other envs and never hosts
(`preview-session-reaper.test.ts`, `preview-session-teardown.test.ts`); each
deploy logs pool usage and names the top consumers on a `429`.

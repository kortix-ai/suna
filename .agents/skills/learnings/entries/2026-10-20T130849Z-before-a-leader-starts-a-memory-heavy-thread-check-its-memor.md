---
recorded: 2026-10-20T13:08:49Z
incident_date: 2026-10-20
---
# Before a leader starts a memory-heavy thread, check its memory room and persist the item as in progress

**Rule:** Moving heavy work off the event loop into a Worker does not make it safe on a leader that also serves requests. Before the thread starts, check that RSS plus a measured estimate for the item stays under a share of the task's memory limit; otherwise defer the item. Persist the item as "in progress" before the thread starts, so the next leader can tell that a thread killed its process. Count that item as failed, keep the cursor past it, and cap its thread attempts.

**Trigger surface:** Starting a Bun `Worker` or any other memory-heavy step from a `leaderTimer` tick or a leader-only worker (`apps/api/src/workers/`). The first case is the session-log backfill's conversion thread (`apps/api/src/projects/session-log-backfill.ts`).

**Incident:** 2026-10-20, near-miss found in review before any prod run. #10464 moved the conversion of sessions over the capture cap into a Worker. On a 1-vCPU, 4 GB Linux container with 131 MB of JSON, the Worker needs about 1.4–1.5 GB above the process. The prod API task is 4096 MiB. Its CloudWatch MemoryUtilization had a daily max of 61–99 % over Oct 13–19. A busy leader plus the Worker can go over the limit. ECS then kills the task, and every request in flight on it fails. The cursor was saved only at tick end, so the next leader would pick the same session and die too: a crash loop across the service. Fix: the PR that adds this entry. It adds a memory guard (RSS plus 12 × the mirror's JSON bytes under 75 % of cgroup `memory.max`, capped by `SESSION_LOG_BACKFILL_MEMORY_MB`). The session is otherwise `deferred`. It also adds a poison pill: `threadStarted` is saved with the cursor before the thread starts, `threadCrashes` is kept across passes, and a session gets at most 2 thread attempts.

**Enforcement:**

- `apps/api/src/__tests__/integration-session-log-backfill.test.ts`, describe "the conversion thread can never take the leader down twice":
  - an id left in progress by a dead tick counts failed once, and the next pass tries it once more;
  - a session with 2 crashes never starts a thread;
  - the memory guard defers the session.
- No automatic check covers other leader workers that start threads. None yet: an ECS memory alarm on the API service.

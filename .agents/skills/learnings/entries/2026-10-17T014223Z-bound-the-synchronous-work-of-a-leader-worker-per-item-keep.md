---
recorded: 2026-10-17T01:42:23Z
incident_date: 2026-10-16
---
# Bound the synchronous work of a leader worker per item, keep its cursor in the database, and serialize leader handlers

**Rule:** A leader-only worker runs on an API task that also serves requests. Cap or split any synchronous step that scales with one item's size (one session, one file), so that no step blocks the event loop for more than about 1 s. Keep a long pass's cursor and totals in the database, not in the leader's memory: autoscaling moves the leader. Call every worker's stop before the first await in `onRelease`, and never let `onAcquire` run while `onRelease` is still awaiting: a start that sees "already started" does nothing, and the rest of the stop then stops that worker for the whole term.

**Trigger surface:** Writing or reviewing a worker started from `startSingletonWorkers` (`apps/api/src/bootstrap.ts`), a `leaderTimer` tick, a conversion that holds one whole item in memory, or `shared/leader-election.ts`.

**Incident:** 2026-10-16, prod v0.14.0. Facts from CloudWatch, counts only.

- **Trigger.** `SESSION_LOG_BACKFILL=dry` ran from about 21:00Z. One session of about 8.5k messages and about 200 MB of records took 17–18 s to convert synchronously. One tick took 56 s, and API requests on that task stalled meanwhile. The leader passed its renew deadline. The watchdog released the lease (`renew deadline passed`), and the lease tick took it back at once, at 23:53:35Z.
- **Outage (open at 01:57Z).** `stopSingletonWorkers` stopped its first workers, then awaited `stopAuditWebhookWorker()`. The re-acquire ran `startSingletonWorkers` during that await, and the rest of the stop then ran after it. Every worker stopped after that await stayed off for the whole leader term: audit reconciliation, audit partition, audit archive, project snapshot, capture, capture health, grant expiry, OAuth sweep, drive, billing rotation, Slack turn GC, Teams turn GC, account deletion, notifications, session-log purge and session-log backfill. That is 18 worker loops, counting the capture loops one by one. The logs confirm account deletion (70 lines from 20:00Z to 23:53Z, 0 after) and the backfill. The others come from the code. Cron, triggers, maintenance and active-turn renewal kept running. At 01:57Z no leader change had happened since 23:53:35Z.
- **Effects.** Scheduled account deletions, the retention purge, billing rotations, grant expiry and notifications were delayed.
- **Detection.** A person read the logs. No alert fired.
- **End.** TODO (orchestrator): ended by a forced redeploy of the prod API at <time>Z.
- **Second defect, same pass.** The pass cursor lived in the leader's memory. Autoscaling moved the leader between 7 tasks in 3 h, and every new leader started the pass over, so no dry pass completed.
- **Conversion correctness.** Clean in every pass: 0 failed, 0 validation failures, 0 round-trip mismatches.
- **Fix.** The PR that adds this entry:
  - `stopSingletonWorkers` calls every stop, then awaits the drains together.
  - `leader-election.ts` runs `onAcquire` and `onRelease` in call order, and logs how long `onAcquire` waited.
  - `leaderTimer` never overlaps a run.
  - `kortix.session_log_backfill_state` holds the pass.
  - A mirror without a log over the capture cap is `too_large` and is not converted.
  - The conversion yields between its stages.

**Enforcement:**

- `apps/api/src/__tests__/unit-leader-election-flap.test.ts`: a re-acquire while `onRelease` awaits leaves every worker running.
- `apps/api/src/shared/leader-timer.test.ts`: a restart never overlaps a run.
- `apps/api/src/__tests__/integration-session-log-backfill.test.ts`: a new leader resumes the pass; `too_large`.
- TODO: a per-worker last-tick heartbeat with an alarm, so that a silent worker pages within one interval. None exists yet.
- The 1 s per-step bound has no automatic check. None yet: an event-loop lag alarm on the API task.

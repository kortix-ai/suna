---
recorded: 2026-10-30T01:12:35Z
incident_date: 2026-10-29
---
# Never let a leader loop run back to back on progress it keeps in memory or on a count of rows the loop itself cannot fix

**Rule:** A leader-only loop runs at its fixed interval. Do not skip the wait while "a cycle has not completed in this process" or "N rows are still pending": a new leader starts with empty memory, and a row the loop cannot fill keeps N above zero for good. A status write that lands after a delayed delivery updates the existing row and never inserts one: the definition can be gone by then.

**Trigger surface:** writing or changing a worker started from `startSingletonWorkers` that resets its own timer (`lastConnectorSweepAt = 0` style), a "backfill until done" mode, or an `insert … on conflict do update` that records the status of a queued or deferred action (`markTriggerRuntimeDelivered`, `markTriggerRuntimeDeliveryFailed`).

**Incident:** 2026-10-29, prod v0.14.9. The connector sweep ran back to back (55-60 busy min per hour) instead of every 2 min: for 2-3 h after each of 5 leader changes, then for good from 19:00Z after a session reminder was deleted while its prompt waited 16 min and the delivery re-inserted the reminder as a row with no definition. The leader ran at 91-97 % of 1 vCPU and pushed prod autoscaling from 3 to 9-10 tasks several times a day. Fixed in the PR that adds this entry (back-to-back mode removed, delivery writers update only, unchanged computer and channel catalogs no longer rewritten).

**Enforcement:** `apps/api/src/projects/trigger-runtime-delivery.integration.test.ts` (a delivery for a deleted trigger writes no row) and `apps/api/src/connectors/sync-built-catalog.integration.test.ts` (an unchanged built catalog keeps its action rows). None yet for the cadence: a test or lint that flags a leader worker resetting its own interval timer.

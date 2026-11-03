---
recorded: 2026-11-03T13:33:15Z
incident_date: 2026-11-03
---
# A fix to a write path settles the rows the old path left behind

**Rule:** When you fix code that wrote a row in a state no worker can leave (a `running` row with no lock, a lease with no expiry), settle the rows it already wrote in the same change: a migration or a one-off script with a read-back count. A guard that reads that state, such as an overlap or a backpressure check, bounds what it counts by age, so one wedged row cannot hold it for ever.

**Trigger surface:** `session_lifecycle_commands` (`enqueue-commands.ts` inline claims, `command-claims.ts` reclaim arm), `projects/lib/trigger-overlap.ts`, and any check that reads `status IN ('queued','running')` as "work in progress".

**Incident:** 2026-11-03, prod v0.14.17. Inline `create_session` claims from July to September 2026 were written `running` with no `locked_until`. A later fix gave inline claims a lock, so the reclaim arm (`locked_until <= now - grace`) takes new rows, but nothing settled the 257 old ones. The fresh-mode overlap check counted any queued or running trigger create, of any age, as "the previous run is still queued". At least 9 cron triggers in 8 customer projects were skipped on every fire for 1 to 3 months, with 0 sessions; one 2-minute trigger logged 5,040 skips in 7 days. Nobody noticed, because a skip is a normal outcome. Fixed in the `nat-egress` branch: the overlap check counts only commands created in the last 24 hours, the same window it already used for sessions.

**Enforcement:** `integration-trigger-overlap.test.ts` ("a create left running for more than 24 hours does not hold it for good", "a prompt older than 24 hours … not held"). To build: an alert when one trigger records only `skipped` executions for 24 hours.

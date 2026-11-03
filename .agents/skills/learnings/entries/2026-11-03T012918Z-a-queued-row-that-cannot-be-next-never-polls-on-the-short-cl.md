---
recorded: 2026-11-03T01:29:18Z
incident_date: 2026-11-03
---
# A queued row that cannot be next never polls on the short clock

**Rule:** A queued command that waits for another row (a live turn, an older prompt) re-checks on a fallback clock of at least a minute. Only the row that can go next keeps a short clock, and the event that frees it (turn end, head delivered) wakes it. A scheduled producer that feeds one queue skips a fire while its previous item still waits, so a run longer than its schedule cannot stack items without bound.

**Trigger surface:** `projects/session-lifecycle/inbox-admission.ts` (`admitInboxPrompt` backoff), `projects/lib/trigger-overlap.ts`, any new requeue-with-`availableAt` path, and any cron that enqueues into a long-lived session.

**Incident:** 2026-11-03, prod v0.14.16. A 10-minute `pg_stat_statements` delta showed `requeueForAdmission` 29 times a second. Two cron triggers in `keyed`/`reuse` mode fired every 30 minutes into sessions whose turns ran longer than 30 minutes. Overlap applied only to `fresh` mode, so each fire queued one more prompt: 93 prompts in 4 sessions, the oldest from 2026-10-31, one refused 82,915 times. Every queued row, head or not, re-polled every 2 s, and each poll read the session's `session_sandboxes` row twice (~2.8 KB of metadata). That loop and the orphan-box sweep (all ~68k `session_sandboxes` rows per pass) were a large part of the API's 60 GB/day database traffic through the NAT. Fixed in the `nat-egress` branch: non-head rows wait 60 s, overlap covers reuse, pinned and keyed sessions, and the sweep reads only listed boxes.

**Enforcement:** `inbox-admission.test.ts` ("a row behind the head of a live turn re-polls once a minute"), `integration-trigger-overlap.test.ts` (reuse and keyed cases), `integration-prompt-inbox.test.ts`. To build: an alert on `session_lifecycle_commands` rows with `admission_refusals` above 10,000.

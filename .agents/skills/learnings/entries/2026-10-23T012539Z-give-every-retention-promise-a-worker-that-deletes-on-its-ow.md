---
recorded: 2026-10-23T01:25:39Z
incident_date: 2026-10-23
---
# Give every retention promise a worker that deletes on its own, not a backlog that waits for a person

**Rule:** When the DPA, a policy or the legal page promises deletion within N days, a leader-only worker must reach that state before day N with no person in the loop, and must leave an evidence row per decision (ids, dates, outcome, no personal data) that outlives the deleted data. A safety hold such as "leave it for a person" is allowed only with a deadline: the backstop takes the item before the promise expires, and a held item (`skipped_live`, `failed`) shows in the evidence.

**Trigger surface:** Writing or reviewing a deletion, retention or erasure path; adding a hold, pause switch or overdue window to a destructive worker; answering an auditor's question about deletion.

**Incident:** 2026-10-23 SOC 2 review. The DPA promises deletion of a terminated account's personal data within 90 days. The account-deletion worker executes a closure only within 2 days of its date (`MAX_OVERDUE`) and leaves older ones for a person. On 2026-10-14 prod held 431 open closures, most from 2026-04 and long past day 90. The session-log purge removed their session content at day 80, but the account rows, logins and other stores stayed. Fix: the `retention-erasure` worker (`apps/api/src/billing/services/retention-erasure.ts`) and `kortix.retention_erasures`.

**Enforcement:** `apps/api/src/billing/services/integration-retention-erasure.test.ts` (db-suites): selection window, dry_run deletes nothing, execute erases and keeps the evidence row, a failed run retries the partial erasure the next day.

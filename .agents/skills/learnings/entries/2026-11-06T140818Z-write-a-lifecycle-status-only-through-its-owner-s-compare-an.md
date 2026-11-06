---
recorded: 2026-11-06T14:08:18Z
incident_date: 2026-11-06
---
# Write a lifecycle status only through its owner's compare-and-set transition, never a read-then-blind UPDATE

**Rule:** Change a lifecycle status with the owner module's named `{ from, to }`
transition (`shared/status-transition.ts`: `WHERE status IN (from)`, `.returning()`).
Treat 0 rows as a lost race and answer it (409, a no-op, a rollback). Never read
the status, check it in code, then `UPDATE ... WHERE id = ?`. A value you add to a
status column goes into its CHECK in the same PR.

**Trigger surface:** any `.set({ status })` or raw `UPDATE ... SET status`; a
route that pre-checks a status; a webhook or callback that can arrive late.

**Incident:** 2026-11-06 static review (near-miss, no reported outage): about 15
blind writers. A deletion cancel read `cancelled` while the worker erased the
account; a closure's own `subscription.deleted` set `payment_status` back to
`active`; a proxy heal revived an `archived` box; a merged change request read
`closed`. Fixed in the `state-guarded-writes` branch.

**Enforcement:** lint rule `kortix-api/guarded-status` (`apps/api/eslint.config.mjs`,
`GUARDED_STATUS_OWNERS`) refuses a drizzle status write on a guarded table outside
its owner; `unit-guarded-status-lint.test.ts` pins it. Raw-SQL writers are not
covered yet.

---
recorded: 2026-10-06T15:22:54Z
incident_date: 2026-10-06
---
# Run one deletion routine for every path that ends an account, and mark completed only after every step succeeded

**Rule:** Every path that ends an account (immediate route, scheduled worker, auth-user-delete trigger) runs the one routine in `billing/services/account-deletion.ts`: sandboxes and Stripe cancel, then data, then the auth user. A request row reads `completed` only after every step succeeded, and a worker claims it atomically (`UPDATE ... WHERE status='pending' RETURNING`) before any irreversible step. A DB trigger never deletes an account; it schedules it.

**Trigger surface:** Adding or changing a way to delete an account, user or workspace; writing a worker that processes request rows; writing a trigger on `auth.users`.

**Incident:** 2026-10-06 audit. The scheduled worker (14-day grace) only ran sandbox teardown, Stripe cancel and wallet forfeit, then marked the request `completed`. It never deleted account data or the auth user, so users who scheduled deletion kept both. It also loaded the batch once with no claim, so a cancel mid-batch or a second replica still forfeited, and a failed Stripe cancel still read `completed`. The auth-user-delete trigger ran a bare `DELETE FROM accounts` that aborts on RESTRICT FKs, and swallowed the error.

**Enforcement:** `apps/api/src/billing/services/integration-account-deletion.test.ts` (db-suites): both paths, claim race, partial-failure retry, trigger scheduling. `apps/api/src/__tests__/integration-reclaim-accounts-on-user-delete.test.ts` covers the trigger shapes.

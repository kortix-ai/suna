---
recorded: 2026-09-25T03:36:50Z
incident_date: 2026-09-25
commit: ee95a11f71
---
# A dry run that calls up() is not read-only; status reads the ledger, never the runner

**Near-miss.** `pnpm migrate:status` was documented as "dry-run, writes nothing",
and the failed-deploy drill in `packages/db/MIGRATIONS.md` sent operators to run
it against prod. It called node-pg-migrate 8.0.4 `runner({ dryRun: true })`.
That dry run takes the advisory lock, creates the ledger schema and table if
absent, sends `BEGIN` and `COMMIT` unconditionally, and calls every pending
migration's `up()`. Only SQL collected through `pgm.sql()` is skipped. The
statements `up()` runs itself through `pgm.db.query()` execute and commit; four
batched `.concurrent.ts` data passes do that. A disposable PostgreSQL proved it:
the old status committed a pending migration's `INSERT` (`n: 1`, expected `0`).
Found while wiring the DB suites into CI (#7636). No known run against a
database with such a migration pending.

**Rule.** A command that claims to write nothing must not call code that can
write. "Dry run" describes what a library chooses to skip, not what it runs:
read the implementation before you document it as read-only. A status check
reads the ledger itself, inside `BEGIN READ ONLY`, on a session opened with
`default_transaction_read_only = on`, and refuses to run when that setting
did not take.

**Enforcement.** `packages/db/scripts/migration-status.integration.test.ts`
(real PostgreSQL: a pending `pgm.db.query` INSERT stays unwritten and is
reported pending; no ledger is created on an empty database; the session
refuses writes even when the URL's `options=` turns read-only off; the real CLI
lists every migration on an empty database and creates no schema). It failed
on the old status (3 of 5). `migration-status.test.ts` pins that `migrate.ts`
has no `dryRun` and that the status path never calls `runner(`.

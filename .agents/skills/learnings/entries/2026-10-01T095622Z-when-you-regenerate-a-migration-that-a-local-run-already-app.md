---
recorded: 2026-10-01T09:56:22Z
incident_date: 2026-10-01
---
# When you regenerate a migration that a local run already applied, rename its row in the shared local ledger

**Rule:** `pnpm test` flows run `migrate:local` (`local-up`) against the
shared local Supabase database on `54322`, so a branch's migration is applied
there the first time its flows run. If you then regenerate that migration
under a new timestamp (for example to re-chain the Drizzle snapshot after
merging `main`), rename its row in `kortix_migrations.pgmigrations` to the new
file name in the same session, after checking that the SQL is identical:
`update kortix_migrations.pgmigrations set name = '<new>' where name = '<old>'`.
Otherwise the ledger names a file no branch has, and `local-up` re-runs the
new file against a schema that already has its change.

**Trigger surface:** `pnpm migrate:generate` re-run for a migration that
already existed on your branch; resolving a Drizzle snapshot conflict after
merging `main`; any flow run that fails at "local database migration exited
with code 1".

**Incident:** 2026-09-29 to 2026-10-01, local only. A branch's
`chat_identity_mfa_verified` migration was applied to the shared local
database by a `pnpm test` run, then regenerated with a later timestamp after
`main` added its own snapshot (PR #8302). For two days every `pnpm test`
flow run on that machine, in any worktree, failed before its first flow:
`column "mfa_verified_at" of relation "chat_user_identities" already exists`.
Fixed by renaming the ledger row; `local-up` then applied the pending
migrations and CHN-T3, CHN-T5 and CHN-T6 passed.

**Enforcement:** none yet: `local-up` could compare a ledger name that has no
file against a pending file with the same slug and identical SQL, and say so
instead of failing on the duplicate column.

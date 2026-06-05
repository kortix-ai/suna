---
name: migration
description: "How to change the database schema in this repo — Drizzle, and ONLY Drizzle. Covers the two-lane model (generated `kortix.*` DDL vs hand-written `--custom` SQL for functions/RLS/grants/backfills), every `db:*` command, and the mandatory safety drill: review the generated SQL, scan for destructive statements, validate, and apply to a throwaway DB first. Load WHENEVER you add/alter/drop a table, column, enum, index, or constraint; edit `packages/db/src/schema/*.ts`; write or apply anything under `packages/db/drizzle/**`; run `db:generate`/`db:migrate`; or plan a schema/data change. ENFORCES: Drizzle-only (never `db:push`/hand-applied SQL), every migration reviewed before apply, and ZERO data loss."
---

# Migrations (Drizzle only)

This repo's schema is owned by **Drizzle**, in `packages/db`. There is exactly
one migration pipeline and one source of truth — never edit the live DB by hand,
never run ad-hoc `ALTER`/`CREATE` against it, never use `drizzle-kit push`.

- Schema source: `packages/db/src/schema/kortix.ts` (the `kortix` schema — the
  only thing Drizzle diffs; `drizzle.config.ts` has `schemaFilter: ['kortix']`,
  `tablesFilter: ['kortix.*']`).
- Migration files: `packages/db/drizzle/*.sql` + the `meta/_journal.json` ledger
  and `meta/*_snapshot.json` (the recorded schema state). All three are
  committed and append-only.
- New migrations get **timestamp-prefixed** filenames (`prefix: 'timestamp'`),
  so two engineers branching off `main` don't both produce `0003_*.sql` and
  collide. The `0000/0001/0002` files are the curated baseline.

## THE RULES

1. **Drizzle is the only way schema changes happen.** No `psql ... ALTER`, no
   Supabase Studio edits, no `drizzle-kit push`. Every change is a committed
   migration file applied by `db:migrate`.
2. **Never `db:push`.** It diffs the live DB and applies directly with no file
   and no review — it will silently DROP columns/tables to match the schema.
   The script was removed on purpose. Don't add it back or run `bunx
   drizzle-kit push`.
3. **Read every generated migration before applying it.** `generate` is a
   *diff*: if you removed or renamed something in `kortix.ts`, it emits
   `DROP COLUMN` / `DROP TABLE` = permanent data loss. The file is the preview.
4. **Zero data loss, always.** Apply to a throwaway/worktree DB first and verify
   data survives, before dev, before prod. Renames and NOT-NULL additions use
   the safe patterns below — never the naive drop+recreate Drizzle defaults to.
5. **Migrations are forward-only and append-only.** Once a migration is applied
   anywhere, never edit or delete its file — its hash is recorded in
   `drizzle.__drizzle_migrations` and editing it breaks the checksum. To change
   shipped schema, write a NEW migration.
6. **Prod is gated.** The prod DB is live. Applying to prod requires showing the
   exact SQL and getting explicit go-ahead first; probes against prod are
   read-only until then. Choosing the target DB = picking `DATABASE_URL`; see
   the `dotenvx-secrets` skill (local vs dev vs prod).

## The two lanes

Both lanes write files into `packages/db/drizzle/` and are applied together, in
journal order, by one `db:migrate`.

- **Lane A — generated (`kortix.*` tables).** Edit `packages/db/src/schema/
  kortix.ts`, then `db:generate`. Drizzle authors the `CREATE/ALTER TABLE` DDL
  for the `kortix` schema automatically.
- **Lane B — hand-written (`--custom`).** Anything Drizzle can't author —
  Postgres functions, RLS policies, GRANTs, triggers, extensions, data
  backfills, or any object in `basejump`/`public`/`auth`/`storage`. Run
  `db:generate --custom --name <desc>` to create an empty timestamped migration,
  then write the SQL by hand with `--> statement-breakpoint` between statements.

## Commands

Run from `packages/db`, or from the repo root with `pnpm --filter @kortix/db
<script>`. (There are no root-level `db:*` scripts.)

| Command | Needs DB? | What it does |
| --- | --- | --- |
| `pnpm --filter @kortix/db db:generate` | no (offline, diffs snapshots) | Diff `kortix.ts` vs the last snapshot → write a new timestamped migration + update `_journal.json` + snapshot. |
| `pnpm --filter @kortix/db db:generate --custom --name <desc>` | no | Create an **empty** timestamped migration to hand-write (functions/RLS/grants/backfills). |
| `pnpm --filter @kortix/db db:check` | no | Validate the migration set is consistent (journal/snapshots intact, no conflicts). Run after every generate. |
| `pnpm --filter @kortix/db db:migrate` | **yes** (`DATABASE_URL`) | Apply all pending migrations and record them in `drizzle.__drizzle_migrations`. |
| `pnpm --filter @kortix/db db:studio` | yes | Browse the DB to verify data after applying. |

`DATABASE_URL` selects the target: local Supabase for `pnpm dev`, the worktree's
Postgres in a worktree, or the dev/prod URL via `dotenvx` (prod = gated).
Worktrees run `db:migrate` automatically on create/start, so the usual loop is:
edit schema → `db:generate` → review → let the worktree apply it.

## The pre-apply drill (run EVERY time, before `db:migrate`)

1. **Generate, then open the file.** `db:generate`, then read the new
   `packages/db/drizzle/<timestamp>_*.sql` top to bottom. Confirm it contains
   only the change you intended.
2. **Scan for destructive statements.** Grep the new migration for:
   `DROP TABLE`, `DROP COLUMN`, `DROP CONSTRAINT`, `TRUNCATE`,
   `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `DROP DEFAULT`, dropping an enum
   value. Any hit → stop and apply the safe pattern below; do not apply as-is.
3. **Check consistency.** `db:check` — must pass.
4. **Apply to a throwaway DB first.** A worktree (`pnpm worktree create …`) or
   local Supabase. Confirm it applies with no error AND data is intact
   (`db:studio` / a `psql` count on affected tables).
5. **Diff the snapshot.** Ensure `meta/*_snapshot.json` changed only as expected.
6. **Only then** widen to dev; and to prod **only** after showing the SQL and
   getting explicit go-ahead.

## No-data-loss patterns

- **Rename a column/table.** Drizzle models a rename as drop+create (data loss).
  Either hand-edit the generated migration to `ALTER TABLE … RENAME COLUMN old
  TO new;`, or do expand/contract: add the new column → backfill → switch the
  app → drop the old column in a *later* migration.
- **Add a NOT NULL column to a populated table.** A bare `ADD COLUMN … NOT NULL`
  fails on non-empty tables. Add it nullable (or `DEFAULT <v>`), backfill in a
  `--custom` migration, then `SET NOT NULL` in a follow-up.
- **New UNIQUE / PRIMARY KEY on existing data.** Verify there are no duplicates
  first (the migration aborts mid-apply otherwise).
- **Type changes.** `ALTER COLUMN … TYPE` can fail or truncate. Prefer add-new +
  backfill + drop-old over an in-place narrowing cast.
- **Backfills.** Put them in their own `--custom` migration, idempotent where
  possible (`WHERE col IS NULL`, `IF NOT EXISTS`), safe to re-run.
- **Ordering.** Dependent + destructive changes must be ordered so each
  intermediate state is valid; split statements with `--> statement-breakpoint`.

## Don't

- Don't `drizzle-kit push` or hand-apply SQL to any DB.
- Don't edit or delete an already-applied migration file or its snapshot/journal
  entry — write a new migration instead.
- Don't point `db:migrate` at prod without showing the SQL and getting the go.
- Don't manage `basejump`/`public`/`auth`/`storage` objects in `kortix.ts` —
  those are Lane B (`--custom`), outside Drizzle's `tablesFilter`.

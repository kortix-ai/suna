# Squawk retro-lint baseline (2026-07-16)

This is a one-time report: [squawk](https://squawkhq.com) run over every
migration that existed in `packages/db/migrations/` BEFORE the zero-downtime
policy in this repo (squawk + `packages/db/scripts/lint-migrations.ts`) was
introduced. **These files are immutable and were NOT rewritten to satisfy the
new ruleset.** Going forward, squawk and the custom checks only run against
migrations that are *not* listed in `packages/db/grandfathered-migrations.json`
— i.e. every migration written from now on. See
`packages/db/scripts/squawk-lint.ts` and `packages/db/MIGRATIONS.md`.

Regenerate this report at any time with:

```bash
pnpm --filter @kortix/db lint:squawk -- --all
```

(`--all` lints the whole corpus and does not change enforcement — enforcement
is always scoped to non-grandfathered files.)

## Method

- Config: `packages/db/.squawk.toml` (`assume_in_transaction = true`, matching
  `singleTransaction: true` in `scripts/migrate.ts`).
- Excluded: `20260621094136410_baseline.sql`. Squawk's parser doesn't support
  the `SEQUENCE NAME ... START WITH ...` sub-clause pg_dump emits inside
  `ALTER TABLE ... ADD GENERATED ALWAYS AS IDENTITY (...)` (a real parser gap,
  not a rule finding) — this is the one raw pg_dump-style file in the corpus.
  Every other one of the 53 remaining files parses cleanly.

## Totals

**178 findings across 49 of 53 parseable files.**

| Count | Rule | What it means |
|---:|---|---|
| 98 | `require-timeout-settings` | No `lock_timeout`/`statement_timeout` before a potentially slow statement. This is the #1 gap the new migration template (`pnpm migrate:create`) closes — it's pre-filled going forward. |
| 20 | `ban-drop-table` | `DROP TABLE`. Legitimate contract-phase drops (old code already stopped referencing the table in a prior, already-live deploy) — but nothing verified that *at the time*. |
| 15 | `require-concurrent-index-creation` | Plain `CREATE INDEX` on an existing table (blocks writes for the build). None of these used the `.concurrent.ts` escape hatch because it didn't exist yet — see MIGRATIONS.md for the pattern now available. |
| 12 | `ban-drop-column` | `DROP COLUMN`. Same expand/contract caveat as `ban-drop-table`. |
| 11 | `changing-column-type` | `ALTER COLUMN ... TYPE` (`ACCESS EXCLUSIVE`, full table rewrite risk). |
| 9 | `constraint-missing-not-valid` | New constraint added without `NOT VALID` + a follow-up `VALIDATE CONSTRAINT` (full table scan while holding a lock). |
| 5 | `require-concurrent-index-deletion` | Plain `DROP INDEX` (should be `CONCURRENTLY`). **This includes `20260713220001000_project_branch_environments.sql`** — the migration behind this week's mixed-version-deploy incident. Squawk correctly flags the *locking* problem (non-concurrent drop); it has no way to know the *semantic* problem (old code's `ON CONFLICT` upsert still depended on the now-dropped unique index) — that's exactly the gap `scripts/lint-migrations.ts`'s new mixed-version guard closes (see MIGRATIONS.md). |
| 5 | `adding-foreign-key-constraint` | New FK without `NOT VALID` (table scan + `SHARE ROW EXCLUSIVE` lock on both tables). |
| 2 | `adding-not-nullable-field` | `NOT NULL` added without first backfilling. |
| 1 | `identifier-too-long` | A generated FK constraint name exceeds Postgres's 63-byte identifier limit and gets silently truncated. |

## Why these aren't retroactively fixed

- The files are already applied in every environment (dev, staging, prod,
  every self-host image). Rewriting them wouldn't change anything already
  running and would break the "migrations are immutable" invariant the
  `immutability` CI job enforces.
- Most of the findings are procedural gaps (missing timeout headers, missing
  `NOT VALID`) that were survivable because the tables involved were small or
  the deploy windows were short — not free passes to repeat going forward,
  which is exactly what the new squawk gate on **new** migrations prevents.

## What's different going forward

Every migration added after this PR gets:

1. **squawk**, scoped via `grandfathered-migrations.json` (`pnpm --filter
   @kortix/db lint:squawk`, wired into CI) — the mechanical, locking-focused
   checks above, blocking by default.
2. **The mixed-version guard** (`scripts/lint-migrations.ts`) — the semantic
   check squawk can't do: any drop/alter of a constraint, unique index,
   column, or enum value requires an explicit
   `-- mixed-version-safe: <justification>` comment, or it's a hard CI
   failure. This is the check that would have forced a conscious decision on
   `20260713220001000` instead of an incident.
3. **The house-rules template** (`pnpm migrate:create`) — lock_timeout /
   statement_timeout pre-filled, an expand/contract checklist, and the
   annotation slots, so the two most common findings above
   (`require-timeout-settings`, unannotated drops) can't happen by omission.

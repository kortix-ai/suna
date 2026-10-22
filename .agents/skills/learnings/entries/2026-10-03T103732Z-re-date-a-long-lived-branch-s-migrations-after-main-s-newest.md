---
recorded: 2026-10-03T10:37:32Z
incident_date: 2026-10-03
---
# Re-date a long-lived branch's migrations after main's newest before it merges

**Rule:** After every merge of `main` into a branch that adds migrations, each
migration the branch adds must sort after `main`'s newest migration. If one does
not, `git mv` it to a current 17-digit timestamp (content unchanged) before the
merge.

**Trigger surface:** merging `main` into a canonical branch that was cut hours or
days earlier and adds a file under `packages/db/migrations/`; preparing that
branch's PR for merge.

**Incident:** near-miss, 2026-10-03, PR #8848 (R2 reliability). The branch's two
migrations were dated 2026-10-02 23:36 and 23:46. While it was open, `main`
merged and Deploy Dev applied migrations dated up to 2026-10-03 01:01. Merged
as-is, node-pg-migrate's order check would have refused the two older-dated
pending files and halted "Apply DB migrations to dev", and so every later dev
deploy — the same failure as #8846 the same night. Caught before the merge:
re-dated, then proven on a ledger rebuilt from `origin/main`'s files (`migrate
up` applied exactly the two; the old head was refused).

**Enforcement:** `pnpm --filter @kortix/db lint` now runs `lintMigrationSequence`
(`packages/db/scripts/lint-migrations.ts`): every local migration not on
`origin/main` must sort after `origin/main`'s newest, else lint fails. Run
`git fetch origin main` first so the ref is current. `db-migrations.yml`'s
`sequence` job checks the same rule, but only after the merge (a pull request
into `main` runs no CI).

---
recorded: 2026-09-17T01:53:58Z
incident_date: 2026-09-17
commit: 85d1c5f668
---
# Use the loopback migration command when starting an isolated worktree

**When:** an isolated worktree applies its branch migration before an earlier-dated
`main` migration lands. Run `migrate:local` on its loopback database. The strict
`migrate` command rejects the valid local ledger order before starting the app.

**Near-miss (PR #7319):** the pooled worktree applied its migration first. After
merging `main`, `worktree start` failed on the new managed GitHub migration.
`local-up` applied it without deleting the local OAuth and key test data.

**Enforcement:** `runMigrate` calls `migrate:local` for isolated worktrees.
`scripts/worktree/__tests__/contract.test.ts` checks that command exists and is used.

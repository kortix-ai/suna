---
recorded: 2026-10-07T23:05:22Z
incident_date: 2026-10-07
supersedes: 2026-10-07T140831Z-before-a-merge-re-check-that-the-branch-s-new-migration-sort.md
---
# In a fork checkout, give the pre-push guards a dev ref to compare against

**Rule:** When `origin` is your fork, keep the `kortix-ai/suna` remote as `upstream` and run `git fetch upstream dev` before you push. A pre-push guard with no dev ref to compare against cannot refuse anything. After any merge of `dev` into a branch, list the migrations the branch adds (`git diff --diff-filter=A --name-only upstream/dev...HEAD -- packages/db/migrations`) and confirm each one is new.

**Trigger surface:** A push from a fork checkout, or a merge of `dev` into a branch that has squash-merged ancestors (a stacked branch whose base PR was squashed).

**Incident:** 2026-10-07, PR #9360 (near-miss, caught in review before merge). A merge of `dev` into a stacked branch brought back `20261006182246238_session_changed_notify.sql`, the old name of the file #9351 re-timed. Both names held the same bytes. The push came from a fork with no `origin/dev`, so `scripts/check-migration-order.sh` exited 0 without checking. Local and preview runs skip checkOrder, so `pnpm test` stayed green. A merge would have stopped Deploy Dev at migrate, as in the superseded entry.

**Enforcement:** `scripts/check-migration-order.sh` now reads `origin/dev` and `upstream/dev` and compares against the newer of the two. With neither ref, it prints `check skipped` instead of passing in silence. Test: `tests/unit/migration-order-guard.test.ts` (fork, stale-origin and no-ref cases). The "Migrations are sequential" job in `db-migrations.yml` is still the backstop after the merge.

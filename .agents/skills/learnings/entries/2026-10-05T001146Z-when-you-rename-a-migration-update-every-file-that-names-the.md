---
recorded: 2026-10-05T00:11:46Z
incident_date: 2026-10-04
---
# When you rename a migration, update every file that names the old filename

**Rule:** When you rename a migration file, for example to move its timestamp after `main`'s newest migration, run `git grep <old-filename>` and update every hit in the same commit. The integration test that ships with a migration usually opens it by filename.

**Trigger surface:** Renaming or re-timestamping anything in `packages/db/migrations/`, usually while rebasing a migration PR onto a newer `main`.

**Incident:** 2026-10-04. #8927 and #9075 merged with their migrations renamed to `20261004173000002_*` and `20261004173003004_*`, while their integration tests still opened the old `20261004002924533_*` and `20261004003004704_*` files. `main`'s db-suites lane failed with ENOENT for every branch that merged `main`, until #9158 and #9159 fixed the paths.

**Enforcement:** `tests/unit/migration-references.test.ts` (core lane, no database) fails when any `.ts`/`.tsx`/`.js`/`.mjs` file names a `migrations/<timestamp>_<name>.sql` that is not a tracked file. On the tree before #9158 it reports both broken references.

---
recorded: 2026-10-07T14:08:31Z
incident_date: 2026-10-07
---
# Before a merge, re-check that the branch's new migration sorts after dev's newest

**Rule:** Right before you merge a branch that adds a migration, fetch `origin/dev` and confirm the new file's 17-digit timestamp is above every migration there. If it is not, rename the file to a fresh timestamp and re-run `pnpm test`. A merge of `origin/dev` into the branch does not make an old timestamp safe.

**Trigger surface:** A branch that lives longer than a few hours and adds a file under `packages/db/migrations/`, or any merge of `origin/dev` into such a branch.

**Incident:** 2026-10-07. #9312 wrote `20261006182246238_session_changed_notify.sql` on day 1. By merge time `dev` had `20261007073001000_…`. `migrate-db` failed on 2 Deploy Dev runs (~15 min), and the API rollout was skipped on both. The web rolled out alone against the old API. #9351 re-timed the file to `20261007140000000`. Same class as the 2026-09-17 entry. The enforcer that entry asked for did not exist yet.

**Enforcement:** `scripts/check-migration-order.sh`, run from `.githooks/pre-push`, refuses a push whose new migration sorts at or before `origin/dev`'s newest. Test: `tests/unit/migration-order-guard.test.ts`. After the merge, the "Migrations are sequential" job in `db-migrations.yml` stays the backstop. The pre-push guard reads the local `origin/dev` ref, so fetch before you push.

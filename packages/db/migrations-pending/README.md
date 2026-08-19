# migrations-pending — written, reviewed, NOT applied

Files here are real migrations that must **not** run yet. They live outside
`packages/db/migrations/` on purpose: node-pg-migrate loads *every* file in that
directory (`.sql` as raw SQL, anything else via dynamic `import()`), so there is
no in-directory way to park one. A `.sql.pending` suffix inside `migrations/`
would be dynamically imported and crash the runner.

Nothing here is in `kortix_migrations.pgmigrations`. `pnpm migrate:status` will
never list them. `pnpm --filter @kortix/db lint` does not scan this directory.

---

## APPLIED — the cutover shipped

`20260819015727000_rbac_dual_read_views.sql.pending` is **gone**. It landed, with
corrections, as three migrations in `packages/db/migrations/`:

| File | What it does |
|---|---|
| `20260819160000000_rbac_cutover_backfill.concurrent.ts` | Re-runs the six backfill passes (imports the original's `up`, so the passes are byte-identical), then purges project-scope assignments whose project no longer exists, in bounded batches. |
| `20260819160100000_rbac_cutover_views.sql` | The swap. `roles` / `role_permissions` / `group_members` become tables; `project_members` / `project_group_grants` / `iam_policies` / `iam_resource_grants` / `account_members` become views over `kortix.role_assignments`, each with INSTEAD OF triggers; the 15 dual-write mirror triggers are dropped; `account_members` is renamed to `account_memberships` and loses `account_role`; four dead tables and `kortix.scope_effect` are dropped; a `role_assignments.scope_id -> projects` cascade FK is added NOT VALID; the catalog FK on `role_permissions.action` is VALIDATED. |
| `20260819160200000_rbac_validate_assignment_scope_fk.sql` | Validates the new cascade FK. |

### Three corrections to what the parked file assumed

1. **INSTEAD OF triggers, not auto-updatable views.** The parked file assumed the
   legacy shapes would be auto-updatable single-table views, so a straggler WRITE
   would land in the canonical store on its own. Three of the five cannot be:
   `project_members`, `project_group_grants` and `iam_policies` must JOIN the
   role table to render their legacy role column, and a view with a join is not
   auto-updatable at all; `iam_resource_grants.effect` and `account_members.account_role`
   are expressions, which are never assignable. Measured, not assumed:
   `INSERT ... ON CONFLICT (cols) DO UPDATE` against a view fails with *"there is
   no unique or exclusion constraint matching the ON CONFLICT specification"*, and
   five production write sites used exactly that shape. Every legacy name
   therefore carries INSTEAD OF INSERT/UPDATE/DELETE triggers that write
   `role_assignments`.
2. **`DISTINCT ON`, not a plain filter.** `project_members` was keyed
   `(project_id, user_id)` and `project_group_grants` `(project_id, group_id)` —
   at most one row per pair — while `role_assignments` lets a `member` and a
   `manager` assignment for the same pair coexist (1 such pair existed on the
   local dataset). Rendering both would double-count every member list built on
   those names, so the views take the strongest role.
3. **`kortix.sandbox_members` is NOT dropped.** It has 0 rows in every
   environment, but `apps/api/src/router/services/member-spend.ts` still reads and
   writes it for the per-member LLM spend cap. Dropping it would 42P01 the proxy.
   That is a billing surface, not an RBAC one; retiring it belongs with that
   feature, not here.

### Preconditions, and how each was met

1. **PR 2 deployed, verdict parity 0 mismatches.** The parity harness ran during
   the dual-read window and is deleted by this PR along with the engine it
   compared against — there is nothing left to compare.
2. **All write sites go through `assignRole()` / `revokeAssignment()`.** Done for
   every site that wrote a legacy grant table; the pin test
   `unit-iam-gate-codemod-pin.test.ts` fails the build if one comes back
   (`no production module writes a legacy grant table directly`). The INSTEAD OF
   triggers cover what the codebase cannot see: a pre-cutover replica mid-roll,
   `pg_restore`, a support script, a test fixture.
3. **Backfill re-run.** `20260819160000000` does it, immediately before the swap.
4. **Row counts asserted.** `bun apps/api/scripts/rbac-cutover-audit.ts` does the
   anti-join in BOTH directions per store and exits non-zero on any legacy row
   with no canonical counterpart. Run it before and after; it is read-only, so it
   is safe against dev, staging and prod.
5. **Applied by CI**, not by hand.

---

## What still has to happen, and when

### Next release — drop the compatibility layer

The legacy NAMES survive as views for ONE release so a pre-cutover replica keeps
reading and writing during the rolling deploy. When every replica is on the
post-cutover image, a follow-up migration drops them:

```sql
DROP VIEW kortix.project_members;
DROP VIEW kortix.project_group_grants;
DROP VIEW kortix.iam_policies;
DROP VIEW kortix.iam_resource_grants;
DROP VIEW kortix.account_members;
DROP VIEW kortix.iam_roles;
DROP VIEW kortix.iam_role_actions;
DROP VIEW kortix.account_group_members;
-- …and the 15 INSTEAD OF triggers + 5 trigger functions that back them, plus
-- kortix.rbac_project_role_key / rbac_system_role_id / rbac_upsert_assignment.
```

That migration is NOT written yet, deliberately: it cannot land before the code
change that stops naming those relations, and that code change is the drizzle
symbol rename (`iamRoles` -> `roles`, `iamRoleActions` -> `rolePermissions`,
`accountGroupMembers` -> `groupMembers`, and the removal of `projectMembers` /
`projectGroupGrants` / `iamPolicies` / `iamResourceGrants` / `accountMembers`) —
576 occurrences across `apps/` and `packages/`, a purely mechanical change with
no behaviour in it. Doing it in the cutover PR would have buried the parts that
DO change behaviour. Expand, then contract.

### Also outstanding

- **`role_assignments.principal_id` has no FK** — it is polymorphic across
  user / group / service_account / pending, so Postgres cannot cascade for it.
  The two principals that can be deleted now clean up their own assignments in
  the same transaction: `deleteServiceAccount`
  (`apps/api/src/repositories/service-accounts.ts`) and `deleteGroup`
  (`apps/api/src/repositories/iam.ts`, also used by the SCIM group-delete route).
  A `pending` principal is an invite email and has no row to delete. If a third
  principal kind is ever added, it needs the same treatment — there is no
  database-level backstop.
- **627 orphaned project-scope assignments were purged** from the local dataset
  by the backfill migration (410 of them derived from `iam_policies` rows whose
  project had been deleted — that table never had a scope FK). Cost the same
  query on prod before promoting: `select count(*) from kortix.role_assignments ra
  where ra.scope_type='project' and not exists (select 1 from kortix.projects p
  where p.project_id = ra.scope_id)`.


## Pre-promote probe (staging / prod) — run BEFORE promoting the cutover

Long-lived data holds role grants written before the catalog collapse; the
runtime override in `migration-runtime-overrides.ts` reconciles them, but SIZE
them first (and confirm the override fires) with:

```sql
-- role_permissions rows the catalog no longer names (would fail the VALIDATE
-- without the runtime override), split by what the override DOES to them:
--   REMAP  = intent-preserving rename onto the surviving leaf (cr.* -> gitops.*)
--   PURGE  = dropped. By construction these can only be the dead trigger.*
--            family (never asserted by any route, so removing them changes no
--            behaviour) — writes were always validated against VALID_ACTIONS,
--            so no other uncataloged string can exist. If this query ever
--            shows a PURGE row outside trigger.*, STOP and investigate before
--            promoting: that would be a permission the override would drop.
SELECT rp.role_id, rp.action,
       CASE WHEN rp.action IN ('project.cr.open','project.cr.merge') THEN 'REMAP'
            ELSE 'PURGE' END AS override_effect
  FROM kortix.role_permissions rp
  LEFT JOIN kortix.permissions p ON p.action = rp.action
 WHERE p.action IS NULL
 ORDER BY override_effect, rp.role_id;

-- project-scope assignments pointing at deleted projects (purged by the
-- cutover backfill; 629 on the local dataset):
SELECT count(*) FROM kortix.role_assignments ra
 WHERE ra.scope_type = 'project'
   AND NOT EXISTS (SELECT 1 FROM kortix.projects pr WHERE pr.project_id = ra.scope_id);
```

Mixed-version window (learnings register 2026-08-19): old pods 42P10 on the
five upsert writers from migration-apply until the new image rolls. Promote in
a low-traffic window and verify the rollout completes promptly.

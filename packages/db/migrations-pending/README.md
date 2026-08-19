# migrations-pending — written, reviewed, NOT applied

Files here are real migrations that must **not** run yet. They live outside
`packages/db/migrations/` on purpose: node-pg-migrate loads *every* file in that
directory (`.sql` as raw SQL, anything else via dynamic `import()`), so there is
no in-directory way to park one. A `.sql.pending` suffix inside `migrations/`
would be dynamically imported and crash the runner.

Nothing here is in `kortix_migrations.pgmigrations`. `pnpm migrate:status` will
never list them. `pnpm --filter @kortix/db lint` does not scan this directory.

---

## `20260819015727000_rbac_dual_read_views.sql.pending`

The **cutover** step of the canonical-RBAC migration (PR 2 → the cutover PR).

### What it does

Flips which side of each pair is physical:

| Name | Today (after PR 2) | After this file |
|---|---|---|
| `kortix.roles` | view over `iam_roles` | **table** |
| `kortix.role_permissions` | view over `iam_role_actions` | **table** |
| `kortix.group_members` | view over `account_group_members` | **table** |
| `kortix.project_members` | table | **view over `role_assignments`** |
| `kortix.project_group_grants` | table | **view over `role_assignments`** |
| `kortix.iam_policies` | table | **view over `role_assignments`** |
| `kortix.iam_resource_grants` | table | **view over `role_assignments`** |
| `kortix.account_members.account_role` | column | **view column** (`account_members` becomes identity-only + a view) |

The legacy shapes survive as views so a straggler read from a mixed-version
replica keeps working, and — because they are auto-updatable single-table views
over `role_assignments` — a straggler *write* lands in the canonical store
instead of a table nobody reads any more. That is the property a one-shot copy
cannot give and the reason spec §3.3 insists on views rather than a second copy.

### Preconditions — every one of these, in this order

1. **PR 2 is deployed and has been serving for at least 24 h.** The
   verdict-parity harness (`apps/api/scripts/rbac-parity.ts`) must report
   0 mismatches over that window, per spec §5.
2. **P3 has landed**: every one of the 129 write sites in `stores.md` §write
   sites goes through `assignRole()` / `revokeAssignment()`. Nothing writes
   `project_members`, `project_group_grants`, `iam_policies`,
   `iam_resource_grants` or `account_members.account_role` directly — including
   SCIM (`scim/users.ts`, `scim/groups.ts`) and SSO JIT (`iam/sso-sync.ts`),
   which bypass route authz by design but must not bypass the store.
3. **The backfill has been re-run** (`20260819015725000_…concurrent.ts` is
   idempotent) so nothing written between the first run and the cutover is
   stranded. Re-run it by deleting only its `pgmigrations` row and running
   `pnpm migrate`.
4. **Assert the row counts match** before dropping anything:

   ```sql
   select 'project_members' t,
          (select count(*) from kortix.project_members) legacy,
          (select count(*) from kortix.role_assignments
            where scope_type='project' and object_type is null
              and principal_type='user'
              and role_id in (select role_id from kortix.iam_roles
                               where account_id is null and scope_type='project'
                                 and key in ('manager','member'))) canonical;
   ```

   Repeat for the other three tables. A non-zero delta means a writer was
   missed in step 2 — stop, do not run this file.
5. **Move the file into `packages/db/migrations/`** (drop the `.pending`
   suffix), run `pnpm --filter @kortix/db lint`, and let CI apply it. Do not
   apply it by hand.

### What it deliberately does NOT do

- It does not drop `account_members`. The table keeps `user_id`, `account_id`,
  `is_super_admin`, `scim_external_id`, `joined_at` — `is_super_admin` stays a
  column by decision (spec §1: 22,408 of 33,363 local rows carry it; making it a
  role would start exercising folds that have been dead for two thirds of
  principals).
- It does not touch `permissions`, `object_policies` or `role_assignments` —
  those are already canonical.
- It has no `down`. Schema rollback is a new forward migration (MIGRATIONS.md).

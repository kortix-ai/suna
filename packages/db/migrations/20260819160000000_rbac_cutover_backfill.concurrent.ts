// Migration: rbac_cutover_backfill  (NON-TRANSACTIONAL — batched DML)
//
// CUTOVER STEP 1 OF 2. Re-runs the six backfill passes of
// 20260819015725000_rbac_backfill_role_assignments.concurrent.ts, immediately
// before 20260819160100000_rbac_cutover_views.sql turns the legacy stores into
// views over kortix.role_assignments.
//
// WHY IT HAS TO RUN AGAIN
// migrations-pending/README.md precondition 3: the first pass copied the state
// of the legacy stores at ONE instant. Everything written to a legacy store
// after that instant is only in role_assignments if the dual-write mirror
// (20260819015728000) caught it — and the mirror cannot catch what predates
// itself. On the local dataset the gap is real and measured:
// `bun apps/api/scripts/rbac-cutover-audit.ts` reported 1 stranded
// `project_members` row and 2 stranded `account_invitations.bootstrap_grants`
// elements before this migration, and 0 of each after it.
//
// The next migration DROPs those tables. A row that is only in the legacy store
// when that happens is deleted, not migrated. This pass is what makes the DROP
// a rename rather than a data loss.
//
// WHY IT IMPORTS THE ORIGINAL INSTEAD OF RESTATING IT
// The passes must be byte-identical to the ones that produced the rows already
// in role_assignments — a re-implementation that folds one legacy role value
// differently, or picks a different `source`, writes a SECOND assignment for a
// fact that already has one. Migrations are immutable (the `immutability` CI
// job), so the original cannot be refactored into a shared module; importing
// its `up` is the only way to run exactly the code that ran the first time.
// Importing the module does not execute anything — node-pg-migrate calls `up`.
//
// IT ALSO PURGES ORPHANED PROJECT-SCOPE ASSIGNMENTS
// `project_members`, `project_group_grants` and `iam_resource_grants` each had
// `ON DELETE CASCADE` from `kortix.projects`. `role_assignments` never did, so
// every project deleted since the first backfill left its grants behind — 627 of
// them on the local dataset. The next migration puts that cascade on the store
// where it belongs, and an FK cannot be validated against rows that violate it,
// so the orphans are deleted here, in bounded batches, first. They are
// unreachable by construction: every read path joins or filters by a live
// project, so nothing can observe them today.
//
// batched-dml: delegates to the original's six INSERT..SELECT passes, 1,000
// rows per batch, each batch its own transaction (pgm.noTransaction()), each
// keyed on a NOT EXISTS anti-join so a batch only picks up rows it has not
// already copied. Bounded by membership cardinality (34,779 / 1,995 / 7 / 413 /
// 10 / 250 locally), not by an event stream. Re-running is a no-op: every pass
// selects only rows with no matching assignment, and every INSERT carries
// ON CONFLICT DO NOTHING against uq_role_assignments_identity. The orphan purge
// is the same shape: DELETE ... WHERE assignment_id IN (SELECT ... LIMIT 1000),
// looping until a batch removes nothing, bounded by the number of assignments
// whose project no longer exists.
//
// mixed-version-safe: DATA only. No DDL, no legacy row modified, no lock on any
// legacy table definition. Every replica — pre-cutover or post-cutover — reads
// and writes exactly what it read and wrote before this ran. The rows it adds
// are rows the engine should already have been seeing.

import { up as backfill } from './20260819015725000_rbac_backfill_role_assignments.concurrent.ts';

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  // The delegate calls pgm.noTransaction() itself; calling it here too makes the
  // opt-out visible in THIS file, which is what scripts/lint-migrations.ts reads
  // and what a reviewer looks for. It is idempotent.
  pgm.noTransaction();

  // eslint-disable-next-line no-console
  console.log('[rbac_cutover_backfill] re-running the six backfill passes before the view swap');
  await backfill(pgm);

  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '120s'`);

  let purged = 0;
  for (let batch = 0; batch < 100_000; batch += 1) {
    const res = await pgm.db.query(`
      delete from kortix.role_assignments
       where assignment_id in (
         select ra.assignment_id
           from kortix.role_assignments ra
          where ra.scope_type = 'project'
            and not exists (select 1 from kortix.projects p where p.project_id = ra.scope_id)
          limit 1000)
    `);
    const n = res.rowCount ?? 0;
    purged += n;
    if (n === 0) break;
    if (batch === 99_999) {
      throw new Error(
        '[rbac_cutover_backfill] orphan purge still finding rows after 100,000 batches — aborting instead of looping forever',
      );
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[rbac_cutover_backfill] orphaned project-scope assignments purged: ${purged}`);

  // eslint-disable-next-line no-console
  console.log('[rbac_cutover_backfill] done — every legacy fact is now in kortix.role_assignments');
};

export const down = false;

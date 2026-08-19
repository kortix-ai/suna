// Migration: project_role_editor_to_manager  (NON-TRANSACTIONAL — batched DML)
//
// WHAT THIS DOES
// The built-in project role `editor` is removed (owner decision, 2026-08-18).
// Two project roles remain: `member` (read + run) and `manager` (everything).
// Every stored `editor` assignment becomes `manager` — `editor` already held
// every permission `manager` holds except `project.members.manage` and
// `project.delete`, so this is the only fold that loses nobody access.
//
// Three places carry a project role, and all three are rewritten here:
//   1. kortix.project_members.project_role        (enum column — direct grants)
//   2. kortix.project_group_grants.role           (enum column — group grants)
//   3. kortix.account_invitations.bootstrap_grants (jsonb array — a pending
//      invite's ride-along "join the org AND get this project role" grant)
// `kortix.workspace_members` / `kortix.workspace_group_grants` are VIEWS over
// (1) and (2), so they follow automatically. `kortix.iam_roles` never stores a
// built-in preset (`builtin:*` ids are synthetic, in code), so custom roles are
// untouched by design.
//
// WHY .concurrent.ts AND NOT .sql
// A plain .sql migration runs inside ONE transaction, so a full-table UPDATE
// holds its row locks until the very end and every writer queues behind it —
// the 2026-08-10 `centralized_audit_v2` outage (see MIGRATIONS.md "Never
// backfill data inside a single-transaction migration" and the `learnings`
// skill). `pgm.noTransaction()` + `pgm.db.query()` gives each batch its own
// implicit transaction, so locks are released every BATCH_SIZE rows and the
// pass is interruptible and re-runnable. This file contains no
// CREATE/DROP INDEX CONCURRENTLY: the escape hatch is used here for the OTHER
// reason it exists — incremental commits — which is what
// `// batched-dml:` below declares to scripts/lint-migrations.ts.
//
// batched-dml: three UPDATE passes in 1,000-row batches, each batch its own
// transaction, keyed on ctid so no table needs a scannable single-column PK.
// Row counts are bounded by membership cardinality (grants and pending
// invites), not by an event stream — orders of magnitude below the audit-table
// case that motivated the guard. Re-running is a no-op: every pass selects only
// rows that still say `editor`.
//
// mixed-version-safe: DATA only — no DDL, no lock on the table definition, and
// the `editor` enum VALUE is deliberately left in place (Postgres cannot drop
// one). An API replica still running the pre-removal code reads `manager` and
// grants strictly MORE than it did, so nothing 403s during the rollout; the
// post-removal code folds any `editor` it still sees to `manager` on read
// (`normalizeProjectRole`) and rejects it on write, so a straggler replica that
// writes `editor` after this runs is also handled. Nothing reads the value
// after both halves are deployed.

export const shorthands = undefined;

const BATCH_SIZE = 1000;

/**
 * Run `sql` until it stops updating rows. Each call is its own implicit
 * transaction (pgm.noTransaction()), so locks are released between batches.
 * `maxBatches` is a safety stop: an unbounded loop against a table something
 * else is concurrently re-inserting `editor` into must fail the migration
 * loudly, not spin forever.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
async function drain(pgm, label, sql) {
  let total = 0;
  for (let batch = 0; batch < 10_000; batch += 1) {
    const res = await pgm.db.query(sql);
    const n = res.rowCount ?? 0;
    total += n;
    if (n === 0) {
      // eslint-disable-next-line no-console
      console.log(`[project_role_editor_to_manager] ${label}: ${total} row(s) updated`);
      return total;
    }
  }
  throw new Error(
    `[project_role_editor_to_manager] ${label}: still finding 'editor' rows after 10,000 batches — aborting instead of looping forever`,
  );
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();

  // Per-batch ceilings. lock_timeout keeps a batch from parking behind a
  // long-running writer; statement_timeout bounds a single batch, never the
  // whole pass (which is what the batching buys).
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '60s'`);

  // 1. Direct project memberships.
  await drain(
    pgm,
    'project_members',
    `update kortix.project_members
        set project_role = 'manager', updated_at = now()
      where ctid in (
        select ctid from kortix.project_members
         where project_role = 'editor'
         limit ${BATCH_SIZE}
      )`,
  );

  // 2. Group → project grants (the SCIM/SSO bulk channel).
  await drain(
    pgm,
    'project_group_grants',
    `update kortix.project_group_grants
        set role = 'manager', updated_at = now()
      where ctid in (
        select ctid from kortix.project_group_grants
         where role = 'editor'
         limit ${BATCH_SIZE}
      )`,
  );

  // 3. Pending invites' ride-along project grants. The array also holds
  //    `{ group_id }` entries with no role at all, so only elements that
  //    actually carry a project_id + role = 'editor' are rewritten; every other
  //    element is passed through byte-identical.
  await drain(
    pgm,
    'account_invitations.bootstrap_grants',
    `update kortix.account_invitations a
        set bootstrap_grants = (
          select jsonb_agg(
                   case
                     when e ? 'project_id' and e->>'role' = 'editor'
                       then jsonb_set(e, '{role}', '"manager"'::jsonb)
                     else e
                   end
                   order by ord
                 )
            from jsonb_array_elements(a.bootstrap_grants) with ordinality as t(e, ord)
        )
      where a.ctid in (
        select ctid from kortix.account_invitations
         where bootstrap_grants @> '[{"role": "editor"}]'::jsonb
         limit ${BATCH_SIZE}
      )`,
  );
};

export const down = false;

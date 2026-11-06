// Migration: workspaces_mark_and_name  (NON-TRANSACTIONAL -- batched data pass)
//
// Workspaces M2 (design: .agents/skills/learnings/work/workspaces/design.md §2).
// Runs after 20261106153010000_workspaces_expand.sql, before
// 20261106153030000_workspaces_one_per_account.concurrent.ts builds the
// 1:1 unique index.
//
// batched-dml: (a) ONE statement marks split_pending = true on the active
// projects of every account with 2+ active projects (prod estimate 2026-11-05:
// 1,034 rows in 401 accounts). (b) The name backfill: for every account with
// exactly 1 active project whose name differs from the project's, the old name
// goes to kortix.workspace_name_backups and accounts.name becomes the project
// name, 1,000 accounts per batch (prod estimate: 8,055 accounts, so ~9
// batches). A renamed account leaves the selection, so the loop ends when a
// batch changes nothing; MAX_BATCHES is a bound, not an expectation.
//
// Why a .concurrent.ts and not a .sql: the backfill guard forbids top-level
// DML in a single-transaction .sql migration (2026-08-10 v0.12.7 outage).
// Each statement commits on its own, so a writer waits at most for one batch.
//
// Mixed-version deploy: old code never reads split_pending, and reads
// accounts.name as a display name only. A renamed 1:1 account shows its
// project's name, which is the workspace name.
//
// Re-runnable: (a) only touches unmarked rows; (b) keeps the FIRST backup row
// per account (ON CONFLICT DO NOTHING), so old_name is always the original.
//
// ROLL BACK the names (no down migration, repo policy). The M1 trigger
// accounts_name_sync copies accounts.name onto the account's only active
// project, so a bare UPDATE would rename ~8k projects to the old account
// names, with no backup of the project names. Disable that one trigger for
// the transaction (ALTER TABLE ... DISABLE TRIGGER takes SHARE ROW EXCLUSIVE:
// writes to kortix.accounts wait, reads do not):
//   BEGIN;
//   SET LOCAL lock_timeout = '5s';
//   ALTER TABLE kortix.accounts DISABLE TRIGGER accounts_name_sync;
//   UPDATE kortix.accounts a SET name = b.old_name
//     FROM kortix.workspace_name_backups b WHERE a.account_id = b.account_id;
//   ALTER TABLE kortix.accounts ENABLE TRIGGER accounts_name_sync;
//   COMMIT;
// Check before COMMIT: projects.name of those accounts is unchanged.

export const shorthands = undefined;

const BATCH = 1000;
// A bound, not an expectation: every batch shrinks its own selection.
const MAX_BATCHES = 1000;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the statements below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  // (a) Legacy multi-project accounts: not one workspace yet. The marked rows
  // are exempt from uq_projects_workspace_account until the split moves them.
  await pgm.db.query(`
    update kortix.projects p
       set split_pending = true
     where p.status = 'active'
       and not p.split_pending
       and p.account_id in (
         select q.account_id
           from kortix.projects q
          where q.status = 'active'
          group by q.account_id
         having count(*) > 1
       )
  `);

  // (b) One name per 1:1 workspace: the project name wins (decisions.md
  // "Defaults taken"). The accounts_name_sync trigger fires on each rename and
  // finds the project name already equal, so it writes nothing.
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { rowCount } = await pgm.db.query(`
      with batch as (
        select a.account_id, a.name as old_name, p.name as new_name
          from kortix.accounts a
          join kortix.projects p
            on p.account_id = a.account_id
           and p.status = 'active'
           and not p.split_pending
         where a.name is distinct from p.name
           and not exists (
             select 1
               from kortix.projects o
              where o.account_id = a.account_id
                and o.status = 'active'
                and o.project_id <> p.project_id
           )
         order by a.account_id
         limit ${BATCH}
      ),
      backed_up as (
        insert into kortix.workspace_name_backups (account_id, old_name, new_name)
        select account_id, old_name, new_name from batch
        on conflict (account_id) do nothing
      )
      update kortix.accounts a
         set name = b.new_name, updated_at = now()
        from batch b
       where a.account_id = b.account_id
    `);
    if (!rowCount) return;
  }
  throw new Error('workspaces_mark_and_name: batch bound reached');
};

export const down = false;

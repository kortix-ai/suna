// Migration: workspaces_one_per_account  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Workspaces M3 (design: .agents/skills/learnings/work/workspaces/design.md §1.2, §2).
// Builds the permanent 1:1 guarantee:
//
//   uq_projects_workspace_account  UNIQUE (account_id)
//     WHERE status = 'active' AND NOT split_pending
//
// An account holds at most ONE active project that is not split-pending. The
// legacy multi-project accounts were marked split_pending by
// 20261106153020000_workspaces_mark_and_name.concurrent.ts.
//
// The race, and the loop that closes it: an old API pod can create a second
// active project in a 1:1 account between M2 and this build. CREATE UNIQUE
// INDEX CONCURRENTLY then fails with 23505 and leaves an INVALID index. So
// each attempt (at most 3):
//   1. re-marks split_pending on every account that has 2+ active projects;
//   2. if the index exists and is VALID, stops;
//   3. drops an INVALID leftover (DROP INDEX CONCURRENTLY);
//   4. builds the index CONCURRENTLY; on 23505 it tries again.
// After the index is valid, an old pod's second project gets 23505 (a 500 in
// the old image); the new image answers 409 `workspace_has_project` first.
//
// mixed-version-safe: the only DROP here is DROP INDEX CONCURRENTLY of
// uq_projects_workspace_account when THIS migration's own earlier build left it
// INVALID. An INVALID index enforces nothing and serves no reads, and no old
// code names it, so dropping it changes no behavior.
//
// lock_timeout 180s: CREATE INDEX CONCURRENTLY waits for every transaction
// older than it, and lock_timeout governs that wait (lint floor 120s,
// MIGRATIONS.md "Roll-forward safety"). It holds only ShareUpdateExclusive on
// kortix.projects, which blocks no query or write.
//
// ROLL BACK: a forward migration with
//   drop index concurrently if exists kortix.uq_projects_workspace_account

export const shorthands = undefined;

const INDEX = 'uq_projects_workspace_account';
const MAX_ATTEMPTS = 3;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
async function indexState(pgm) {
  const { rows } = await pgm.db.query(`
    select i.indisvalid as valid
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = '${INDEX}'
       and c.relnamespace = 'kortix'::regnamespace
  `);
  if (rows.length === 0) return 'missing';
  return rows[0].valid ? 'valid' : 'invalid';
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: the loop needs each result before the next step.
  await pgm.db.query(`set lock_timeout = '180s'`);
  await pgm.db.query(`set statement_timeout = '30min'`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // 1. Any account that gained a second active project since M2 is legacy too.
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

    const state = await indexState(pgm);
    if (state === 'valid') return;
    if (state === 'invalid') {
      await pgm.db.query(`drop index concurrently if exists kortix.${INDEX}`);
    }

    try {
      await pgm.db.query(`
        create unique index concurrently if not exists ${INDEX}
          on kortix.projects using btree (account_id)
          where status = 'active' and not split_pending
      `);
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (code !== '23505' || attempt === MAX_ATTEMPTS) throw error;
      continue;
    }
    if ((await indexState(pgm)) === 'valid') return;
  }
  throw new Error(`workspaces_one_per_account: ${INDEX} is not valid after ${MAX_ATTEMPTS} attempts`);
};

export const down = false;

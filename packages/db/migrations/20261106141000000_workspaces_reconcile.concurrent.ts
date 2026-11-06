// Migration: workspaces_reconcile  (NON-TRANSACTIONAL -- batched data pass)
//
// Workspaces M6 (design: .agents/skills/learnings/work/workspaces/design.md §3.3).
// Fills kortix.workspaces for every existing account: one
// kortix.workspaces_reconcile_account(account_id) per account, 500 accounts
// per statement, keyset on accounts.account_id (prod 2026-11-06: ~49k
// accounts, so ~98 statements). The M5 triggers keep every account written
// after them in sync; this pass covers the accounts nobody wrote since.
// Then it deletes table rows whose account no longer exists (none on a first
// run; a rerun after a deletion sweep may find some).
//
// batched-dml: each statement reconciles at most 500 accounts and commits on
// its own (pgm.noTransaction), so a writer of one account waits at most for
// one statement. Row locks only: the reconcile takes FOR NO KEY UPDATE on each
// account row of its batch (foreign-key checks still pass) and writes only
// kortix.workspaces.
//
// Why a .concurrent.ts and not a .sql: the backfill guard forbids top-level
// DML in a single-transaction .sql migration (2026-08-10 v0.12.7 outage).
//
// Idempotent: the reconcile rewrites a row only when its content differs, so
// a rerun after a failure finishes the rest and changes nothing else.
//
// Mixed-version deploy: the old image never names kortix.workspaces.
//
// ROLL BACK: no down migration (repo policy). TRUNCATE kortix.workspaces
// empties it; the M5 triggers refill each account on its next write.

export const shorthands = undefined;

const BATCH = 500;
// A bound, not an expectation: ~98 batches on prod.
const MAX_BATCHES = 100_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the statements below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  let after = '00000000-0000-0000-0000-000000000000';
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (!UUID_RE.test(after)) throw new Error(`workspaces_reconcile: bad keyset ${after}`);
    const { rows } = await pgm.db.query(`
      with batch as (
        select a.account_id
          from kortix.accounts a
         where a.account_id > '${after}'::uuid
         order by a.account_id
         limit ${BATCH}
      ),
      done as (
        select b.account_id, kortix.workspaces_reconcile_account(b.account_id) as ok
          from batch b
      )
      select max(account_id::text) as last, count(*)::int as n from done
    `);
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) break;
    after = String(rows[0].last);
    if (n < BATCH) break;
  }

  await pgm.db.query(`
    delete from kortix.workspaces w
     where not exists (
       select 1 from kortix.accounts a
        where a.account_id = coalesce(w.legacy_account_id, w.former_account_id))
  `);
};

export const down = false;

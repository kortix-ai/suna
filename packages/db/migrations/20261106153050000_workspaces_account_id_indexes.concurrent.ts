// Migration: workspaces_account_id_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Workspaces M4 support (design: .agents/skills/learnings/work/workspaces/design.md §3.3, §6.2).
// kortix.workspaces_reconcile_account (20261106153100000_workspaces_table.sql)
// runs kortix.workspace_fill_account when an account's live workspace id moves
// (a new workspace's first project, a split move, a transfer). The fill runs
//   UPDATE kortix.<t> SET workspace_id = $1 WHERE account_id = $2
// on every expand table, inside the caller's transaction. Six expand tables
// have no index that leads with account_id, so each such UPDATE was a
// sequential scan on the sign-up path:
//   oauth_access_tokens, oauth_authorization_codes, app_runtimes, app_volumes,
//   cli_device_grants, capture_device_grants
// This file builds idx_<table>_account_id (account_id) on each, CONCURRENTLY,
// before the trigger exists (its timestamp sorts before M4).
//
// Each index: an INVALID leftover of this file's own earlier attempt is dropped
// (DROP INDEX CONCURRENTLY), then CREATE INDEX CONCURRENTLY IF NOT EXISTS.
//
// mixed-version-safe: the only DROP is DROP INDEX CONCURRENTLY of an index this
// migration names and created, and only while it is INVALID: an INVALID index
// enforces nothing and serves no reads, and no code names these indexes.
//
// lock_timeout 180s: CREATE INDEX CONCURRENTLY waits for every transaction
// older than it, and lock_timeout governs that wait (lint floor 120s,
// MIGRATIONS.md "Roll-forward safety"). It holds only ShareUpdateExclusive on
// each table, which blocks no query or write. Time at prod row counts: the six
// tables together hold under 2 GB (design.md §6.2); expect seconds to a few
// minutes, dominated by oauth_access_tokens.
//
// ROLL BACK: a forward migration with
//   drop index concurrently if exists kortix.idx_<table>_account_id   (each of the six)

export const shorthands = undefined;

const TABLES = [
  'oauth_access_tokens',
  'oauth_authorization_codes',
  'app_runtimes',
  'app_volumes',
  'cli_device_grants',
  'capture_device_grants',
];

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
async function indexState(pgm, name) {
  const { rows } = await pgm.db.query(
    `select i.indisvalid as valid
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
      where c.relname = $1
        and c.relnamespace = 'kortix'::regnamespace`,
    [name],
  );
  if (rows.length === 0) return 'missing';
  return rows[0].valid ? 'valid' : 'invalid';
}

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, one statement each: CONCURRENTLY cannot run in a multi-statement string.
  await pgm.db.query(`set lock_timeout = '180s'`);
  await pgm.db.query(`set statement_timeout = '30min'`);
  for (const table of TABLES) {
    const name = `idx_${table}_account_id`;
    const state = await indexState(pgm, name);
    if (state === 'valid') continue;
    if (state === 'invalid') await pgm.db.query(`drop index concurrently if exists kortix.${name}`);
    await pgm.db.query(`create index concurrently if not exists ${name} on kortix.${table} (account_id)`);
  }
};

export const down = false;

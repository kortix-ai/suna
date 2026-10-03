// Migration: drop_project_access_requests_status_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_project_access_requests_status` (btree (status)) on
// kortix.project_access_requests: the Supabase performance advisor reports it
// as unused (lint unused_index) and pg_stat_user_indexes confirms it --
// idx_scan = 0, idx_tup_read = 0, idx_tup_fetch = 0 since stats began, while
// every sibling index on the table has scans (pending_unique 23897, project
// 40, account 10, requester 4, pkey 8 at reporting time). Every extra index
// costs an index write on each INSERT/UPDATE, for nothing.
//
// Nothing needs it. The only production queries on the table filter
// project_id (+ requester_user_id) AND status = 'pending'
// (apps/api/src/projects/routes/access-requests.ts,
// apps/api/src/channels/core/identity.ts): the partial unique index
// idx_project_access_requests_pending_unique
// (project_id, requester_user_id) WHERE status = 'pending' serves those
// paths, and idx_project_access_requests_project covers the project side. No
// query filters status alone, and the table is tiny anyway (22 rows, 8 kB
// heap at reporting time) -- the planner seq-scans it regardless. Postgres
// never references an index by name in a query, so a drop can only change
// plan choice, never break a statement.
//
// Unlike public.idx_agents_account_non_suna (KRTX-1083), this index IS built
// by the Kortix baseline (20260621094136410_baseline.sql), so the drop runs
// on every database -- fresh ones included -- and kortix.ts no longer
// declares the index, keeping the schema contract (scripts/schema-contract.ts)
// and the drizzle snapshot aligned.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it, and that wait blocks
// nobody. IF EXISTS keeps a re-run safe.
//
// mixed-version-safe: drops only a never-scanned non-unique index. No code
// names it (a grep of the name over the repo finds only the baseline that
// builds it), no constraint, ON CONFLICT clause, view or policy depends on a
// plain non-unique btree, and old code plans the same queries through
// idx_project_access_requests_pending_unique and
// idx_project_access_requests_project or a seq scan of a 22-row table.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_project_access_requests_status`);
};

// Forward-only: the advisor flagged this index as unused; a query that grows
// to need a status index declares and CONCURRENTLY-builds a new one.
export const down = false;

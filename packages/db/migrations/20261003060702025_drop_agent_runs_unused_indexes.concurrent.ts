// Migration: drop_agent_runs_unused_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the ten public.agent_runs indexes that the Supabase performance advisor
// flags as unused (lint unused_index; KRTX-1219) and that prod
// pg_stat_user_indexes confirms with idx_scan = 0 (lifetime counters:
// pg_stat_database.stats_reset is NULL; read-only query, 2026-10-03). Together
// they are ~735 MB of the table's 26 GB. public.agent_runs is the retired Suna
// backend's run table (~1.56M rows): no current app code reads or writes it —
// the only repo reader is apps/api/src/scripts/legacy-transfer, an on-demand
// local export tool that scans whole tables and never names an index — and prod
// shows 0 INSERTs and 0 UPDATEs against it. The six indexes with reads stay
// (agent_runs_pkey, idx_agent_runs_created_at, idx_agent_runs_agent_id,
// idx_agent_runs_agent_version_id, idx_agent_runs_thread_id,
// idx_agent_runs_thread_agent_created_desc).
//
//   idx_agent_runs_metadata               gin (metadata)                        190 MB
//   idx_agent_runs_status_created_desc    btree (status, created_at DESC)       133 MB
//   idx_agent_runs_thread_created_desc    btree (thread_id, created_at DESC)     97 MB
//   idx_agent_runs_created_at_desc        btree (created_at DESC)                89 MB
//   idx_agent_runs_started_at             btree (started_at DESC)                72 MB
//   idx_agent_runs_thread_status          btree (thread_id, status)              70 MB
//   idx_agent_runs_thread_status_started  btree (thread_id, status, started_at DESC) WHERE status = 'running'   34 MB
//   idx_agent_runs_status_running         btree (status, started_at DESC) WHERE status = 'running'             32 MB
//   idx_agent_runs_status                 btree (status)                         18 MB
//   idx_agent_runs_status_thread          btree (status, thread_id) WHERE status = 'running'                   392 kB
//
// public.agent_runs is a legacy table the Kortix baseline never creates, so a
// fresh/self-host database finds no index and `IF EXISTS` makes this a no-op
// there. It only exists on databases that predate the Kortix baseline (prod,
// and dev/staging if seeded from it).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer. It cannot run in a transaction, hence this .concurrent.ts file
// (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the statement
// waits for transactions that began before it (learnings 2026-08-19), and that
// wait blocks nobody.
//
// Ten statements, one file: each is IF EXISTS and independent, so a re-run
// after a partial failure is safe and no state needs all-or-nothing. They stay
// separate pgm.sql() calls: a multi-statement string is an implicit transaction
// and CONCURRENTLY would fail inside it.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names any of these
// indexes (a git grep of all ten names over the repo finds nothing), and no
// code reads or writes public.agent_runs at all. None of the ten is unique,
// and prod pg_depend lists no constraint, view or policy behind them (only the
// auto index-to-table row), so no ON CONFLICT clause or constraint can target
// them. A still-running older image plans the same queries after the drop:
// there are none.
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql("set lock_timeout = '180s'");
  pgm.sql("set statement_timeout = '30min'");
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_metadata');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_status_created_desc');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_thread_created_desc');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_created_at_desc');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_started_at');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_thread_status');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_thread_status_started');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_status_running');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_status');
  pgm.sql('drop index concurrently if exists public.idx_agent_runs_status_thread');
};

// Forward-only: every dropped index is a no-read legacy index; re-creating it
// would re-impose its footprint for nothing.
export const down = false;

// Migration: drop_agents_duplicate_non_suna_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `public.idx_agents_account_non_suna` on the legacy `public.agents`
// table: it is byte-identical to `public.idx_agents_account_non_default`
// (btree (account_id) WHERE ((metadata ->> 'is_suna_default')::boolean IS NOT
// TRUE)), reported by the Supabase performance advisor (lint duplicate_index).
// Every extra index costs an index write on each agents INSERT/UPDATE, for
// nothing. The kept twin serves the same reads; the planner does not know or
// care which name it plans (Postgres never references an index by name).
//
// `public.agents` is the retired Suna backend's table (KRTX-1083). The Kortix
// baseline never creates it, so a fresh/self-host database finds no index and
// `IF EXISTS` makes this a no-op there. It only exists on databases that
// predate the Kortix baseline (prod, and dev/staging if seeded from it).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops only one of two identical indexes. No code names
// either index (a git grep of both names over the repo finds nothing) and no
// constraint, ON CONFLICT clause, view or policy depends on them (they are
// plain non-unique partial indexes; verified via pg_depend on the prod
// database). A still-running older image plans the same queries through the
// kept twin, so the drop cannot change a query plan's availability.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists public.idx_agents_account_non_suna`);
};

// Forward-only: the kept twin rebuilds this index whenever a query needs it.
export const down = false;

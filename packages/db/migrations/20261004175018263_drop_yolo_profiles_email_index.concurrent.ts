// Migration: drop_yolo_profiles_email_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the unused btree index `profiles_email_idx` (email) on the LLM gateway's
// `kortix_yolo.profiles` table, reported by the Supabase performance advisor
// (lint unused_index, observed 2026-10-03T10:26Z, KRTX-1217). Prod
// `pg_stat_user_indexes` reads idx_scan = idx_tup_read = idx_tup_fetch = 0 for
// it. Every extra index costs an index write on each INSERT/UPDATE for nothing.
// The pkey and `profiles_role_idx` stay: the advisor flagged `profiles_role_idx`
// alongside it when this issue was filed (2026-10-02T20:47Z and still at
// 09:10Z), but that index registered its first read and the advisor stopped
// flagging it at 10:26Z (idx_scan = 1, one scan over the 250-row table) — it no
// longer meets the issue's own "confirm the index has no reads" precondition,
// so this migration leaves it in place.
//
// `kortix_yolo` is the gateway service's own schema. The Kortix baseline never
// creates it (no migration names the schema), so on a fresh/self-host/CI-shadow
// database `IF EXISTS` makes the statement a no-op (Postgres skips a drop whose
// schema is absent with a NOTICE). The index only exists on databases that
// carry the gateway schema (prod, and dev/staging if seeded from it). Same
// situation as 20261002234046650 (the legacy public.agents drop).
//
// DROP INDEX CONCURRENTLY cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). It holds only ShareUpdateExclusive
// — it blocks no reader and no writer. lock_timeout is 180s, not the 2-5s house
// value: the statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops a plain non-unique index. No repo code names it (a
// git grep over the repo finds nothing — the gateway is a separate service) and
// no constraint, ON CONFLICT clause, view or policy depends on it. A
// still-running older gateway image plans the same queries by seq scan (250-row
// table; the planner never referenced this index — zero scans since stats
// begin). Rollback is the plain CREATE INDEX CONCURRENTLY of the same
// definition (recorded in the PR body).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists "kortix_yolo"."profiles_email_idx"`);
};

// Forward-only: the index re-creates with its plain CREATE INDEX CONCURRENTLY
// definition if a gateway read path ever needs it.
export const down = false;

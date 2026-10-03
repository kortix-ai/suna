// Migration: agent_versions_fk_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// The Supabase performance advisor reports two foreign keys on the legacy
// `public.agent_versions` table without a covering index:
//
//   agent_versions_created_by_fkey           (created_by -> basejump.accounts.id)
//   agent_versions_previous_version_id_fkey  (previous_version_id -> public.agent_versions.version_id)
//
// Both are ON DELETE/UPDATE NO ACTION, so deleting or re-keying a referenced
// row makes Postgres scan agent_versions to prove no row still points at it.
// No existing index leads with either column: the two unique constraints and
// idx_agent_versions_agent_version_desc all lead with agent_id, and the
// remaining indexes are on unrelated columns (the agent_id FK is already
// covered by idx_agent_versions_agent_id). The table holds ~385k rows on prod,
// so those scans are the cost the advisor flags.
//
// This file exists ONLY because CREATE INDEX CONCURRENTLY cannot run inside a
// transaction, and every plain .sql migration here runs inside the single batch
// transaction node-pg-migrate wraps around `pnpm migrate` (singleTransaction:
// true, see packages/db/scripts/migrate.ts). `pgm.noTransaction()` is the
// supported opt-out: node-pg-migrate COMMITs the outer transaction, runs this
// file standalone, then re-opens BEGIN for the migrations that follow. See
// MIGRATIONS.md "Roll-forward safety".
//
// Why it is guarded at all: `public.agent_versions` is a legacy table that
// predates the Kortix baseline. Prod, dev and staging carry it; a fresh
// database (local, CI shadow-db, self-host) never had it. A bare CREATE INDEX
// on a missing relation aborts the whole batch, so `up` first checks
// `to_regclass` and does nothing where the table is absent. Recorded as
// applied either way, so the ledger stays consistent. Every database that does
// carry the table has both columns (same legacy lineage, verified on prod
// 2026-10-02: ordinals 12 and 15).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. IF NOT EXISTS keeps a re-run safe; the learnings rule is one CIC
// per TABLE at a time, and the runner executes every queued statement strictly
// serially, so the two builds below do not starve each other. An INVALID
// leftover from a killed build must be dropped by hand first (MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();

  // Read-only: a database without the legacy table has nothing to index.
  const { rows } = await pgm.db.query(
    "select to_regclass('public.agent_versions') is not null as present",
  );
  if (!rows[0]?.present) return;

  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block through the simple query protocol, which
  // silently defeats noTransaction() and fails CONCURRENTLY.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_agent_versions_created_by
      on public.agent_versions (created_by)
  `);
  pgm.sql(`
    create index concurrently if not exists idx_agent_versions_previous_version_id
      on public.agent_versions (previous_version_id)
  `);
};

// One-way in practice: an index build needs no down migration (MIGRATIONS.md).
export const down = false;

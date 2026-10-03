// Migration: user_roles_granted_by_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Clears the Supabase performance advisor's `unindexed_foreign_keys` finding on
// public.user_roles: the foreign key user_roles_granted_by_fkey (granted_by ->
// auth.users) has no covering index, so every DELETE on auth.users must seq-scan
// the table to enforce it (the pkey only covers the user_id FK). Indexes
// idx_user_roles_role and idx_user_roles_user_role cover `role` and `user_id`.
//
// public.user_roles is pre-kortix-schema legacy state (8 rows on prod, last write
// 2025-12-22; the live roles live in kortix.platform_user_roles). The migrations
// neither create nor manage it — it is not in the baseline and not declared in
// src/schema/kortix.ts. A bare CREATE INDEX would fail on every fresh database
// (self-host bootstrap, CI shadow, preview) where the table does not exist, so
// the build is guarded by to_regclass and only runs where the legacy table is.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY waits
// for every transaction that began before it, and lock_timeout governs that wait
// (learnings 2026-08-19). IF NOT EXISTS keeps a re-run safe; an INVALID leftover
// from a failed build must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // The guard is a read: it runs during up() on the runner's connection and
  // branches before anything is queued. The DDL below goes through pgm.sql(),
  // NOT pgm.db.query: the runner only breaks its wrapping single transaction
  // around the QUEUED steps (Migration._apply splices COMMIT/BEGIN around
  // pgm.getSqlSteps()), so a statement issued directly from up() — like the
  // SELECT here — would run inside the still-open transaction and CONCURRENTLY
  // would fail with 25001.
  const legacy = await pgm.db.query(`select to_regclass('public.user_roles') as reg`);
  if (legacy.rows[0]?.reg) {
    // One statement per pgm.sql() call: a multi-statement string is an implicit
    // transaction block and CONCURRENTLY fails inside it.
    pgm.sql(`set lock_timeout = '180s'`);
    pgm.sql(`set statement_timeout = '30min'`);
    pgm.sql(
      `create index concurrently if not exists idx_user_roles_granted_by
         on public.user_roles using btree (granted_by)`,
    );
  }
};

export const down = false;

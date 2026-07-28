// Migration: multi_connections_per_connector  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY cannot run
// inside a transaction, and every plain .sql migration here runs inside the
// single batch transaction node-pg-migrate wraps around `pnpm migrate`.
// `pgm.noTransaction()` is the supported opt-out. See MIGRATIONS.md
// "Roll-forward safety".
//
// WHAT THIS DOES
// Lets ONE connector hold MANY connections: several shared team accounts
// (support@ + sales@ on one `gmail` connector) and several personal ones per
// member ("Work", "Personal"). Two partial unique indexes previously capped it
// at one connection per owner and one default per connector.
//
//   - `label` becomes the identity discriminator, so one owner may hold several
//     connections while reconcile stays idempotent (same label updates in place,
//     a new label adds one). The replacement is a NEW index name
//     (`…_owner_label`) precisely so it can be built BEFORE the old one is
//     dropped -- see the ordering note below.
//   - The single one-default-per-connector index becomes a PER-OWNER pair:
//     exactly one team default (`…_default_project`) and at most one default per
//     member/agent/external owner (`…_default_owner`). Split in two because
//     project rows carry owner_id NULL, where SQL NULLs compare distinct and one
//     composite index would not cap them.
//   - `…_project_label` keeps the TEAM set unique by label (the owner index is
//     partial on owner_id IS NOT NULL, so it cannot dedupe project rows).
//
// ORDERING -- EXPAND BEFORE CONTRACT. All four replacements are created first,
// then the two originals are dropped. Uniqueness is therefore never unenforced
// at any point, even if this migration fails partway: the old indexes are
// strictly STRICTER than the new ones (old `(connector_id, owner_type,
// owner_id)` implies the new 4-column uniqueness; old one-default-per-connector
// implies at most one default in either new partial index), so every existing
// row already satisfies the new indexes and both sets can coexist.
//
// Every statement is IF NOT EXISTS / IF EXISTS: a CONCURRENTLY build can fail
// partway and leave an INVALID index, so this migration is safe to re-run.
//
// mixed-version-safe: dropping these two indexes cannot break an OLD app version
// still running against the NEW schema. They are pure uniqueness ENFORCEMENT --
// no query plan depends on them existing (the reads that matter go through the
// profile PK or the (connector_id, ...) lookups still covered by the new
// indexes), and the one upsert on this table,
// `reconcileConnectionProfileRow` (apps/api/src/projects/routes/r4.ts), is a
// SELECT-then-UPDATE whose INSERT uses a bare `.onConflictDoNothing()` with NO
// inferred arbiter index -- so it is unaffected by which unique indexes exist.
// (That inferred-arbiter mismatch is exactly the "Worked example #1" incident in
// MIGRATIONS.md; it does not apply here because no ON CONFLICT target is named.)
// Dropping only RELAXES uniqueness, so old code can never fail a write it would
// previously have succeeded at.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string --
  // Postgres treats a multi-statement simple query as an implicit transaction
  // block, which silently defeats noTransaction() for CONCURRENTLY.
  pgm.sql(`set lock_timeout = '2s'`);

  // ── EXPAND: build every replacement first ────────────────────────────────
  pgm.sql(`
    create unique index concurrently if not exists idx_executor_connection_profiles_default_project
      on kortix.executor_connection_profiles (connector_id)
      where is_default = true and owner_type = 'project'
  `);
  pgm.sql(`
    create unique index concurrently if not exists idx_executor_connection_profiles_default_owner
      on kortix.executor_connection_profiles (connector_id, owner_type, owner_id)
      where is_default = true and owner_id is not null
  `);
  pgm.sql(`
    create unique index concurrently if not exists idx_executor_connection_profiles_owner_label
      on kortix.executor_connection_profiles (connector_id, owner_type, owner_id, label)
      where owner_id is not null
  `);
  pgm.sql(`
    create unique index concurrently if not exists idx_executor_connection_profiles_project_label
      on kortix.executor_connection_profiles (connector_id, label)
      where owner_id is null
  `);

  // ── CONTRACT: only now retire the originals ──────────────────────────────
  pgm.sql(`drop index concurrently if exists kortix.idx_executor_connection_profiles_default`);
  pgm.sql(`drop index concurrently if exists kortix.idx_executor_connection_profiles_owner`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// this repo doesn't write down migrations).
export const down = false;

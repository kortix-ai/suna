// Migration: drop_account_model_preferences_scope_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY (and a
// handful of other operations: REINDEX CONCURRENTLY, DETACH PARTITION
// CONCURRENTLY) cannot run inside a transaction -- and every plain .sql
// migration in this repo runs inside the single batch transaction
// node-pg-migrate wraps around `pnpm migrate` (singleTransaction: true,
// see packages/db/scripts/migrate.ts). `pgm.noTransaction()` is
// node-pg-migrate's own supported opt-out: when it hits a migration that
// called this, it COMMITs the outer transaction, runs THIS migration
// standalone (no transaction), then re-opens BEGIN for whatever runs after
// it in the same batch. See MIGRATIONS.md "Roll-forward safety".
//
// Rules for this file:
//   - ONE concurrent operation. Don't smuggle other DDL in here -- you lose
//     the all-or-nothing guarantee the moment you opt out of the transaction.
//   - Always use IF NOT EXISTS / IF EXISTS -- a CONCURRENTLY build can fail
//     partway through and leave an INVALID index; the migration must be safe
//     to re-run (check pg_index.indisvalid before retrying by hand if it does).
//   - lock_timeout still matters for the brief catalog-level lock the build
//     takes at the very end; statement_timeout should be generous (index
//     builds on large tables can legitimately run long) or left unset.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add `// mixed-version-safe: <justification>` above `up` if this drops
//     something old code might still read (see MIGRATIONS.md).

export const shorthands = undefined;

// Contract step 5/5 of the agent-model-pin project-scoping fix (see the doc
// comment on accountModelPreferences in packages/db/src/schema/kortix.ts).
// By the time this runs, every row is already covered by one of the two
// replacement partial indexes created in the two migrations immediately
// before this one (…scope_global_index, …scope_project_index), so dropping
// the old unconditional index never leaves ANY row's uniqueness unenforced.
//
// mixed-version-safe: this DOES change the arbiter index that
// upsertAccountModelPreference's `INSERT … ON CONFLICT (account_id, scope,
// scope_key)` (no predicate) infers against -- verified live against a local
// Postgres 17 instance that a predicate-less ON CONFLICT target fails with
// "no unique or exclusion constraint matching the ON CONFLICT specification"
// once only the two partial indexes remain, because Postgres only infers a
// partial index as arbiter when the caller's ON CONFLICT clause repeats its
// WHERE predicate (it doesn't, for the pre-fix code). This is the exact
// class of incident documented as "Worked example #1" in MIGRATIONS.md. The
// risk is accepted rather than split into a second deploy because: (1) this
// table is written ONLY on an explicit user action (Settings UI / `kortix
// agents model` CLI / a project's PUT model-defaults) -- never a per-request
// hot path like the projects.account_id/repo_url incident was: (2) the app
// code in THIS SAME PR always supplies a matching targetWhere alongside the
// column target, so only an OLD pod (previous release, still draining
// mid-rollout) can hit the mismatch; and (3) the failure mode is a single
// 500 on that one write attempt, trivially retried once the rollout
// finishes -- no data loss or corruption, self-healing within the normal
// drain window.

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    drop index concurrently if exists kortix.idx_account_model_preferences_scope
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;

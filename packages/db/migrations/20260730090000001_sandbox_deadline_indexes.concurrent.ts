// Migration: sandbox_deadline_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// BOUNDED SANDBOX LIFETIME, step 2/7.
//
// This file exists ONLY because CREATE INDEX CONCURRENTLY cannot run inside a
// transaction, and every plain .sql migration here runs inside the single batch
// transaction node-pg-migrate wraps around `pnpm migrate`. `pgm.noTransaction()`
// is the supported opt-out. See MIGRATIONS.md "Roll-forward safety".
//
// Two indexes, and the ORDER matters -- both are built BEFORE the backfill
// (step 3) because the backfill reads through the second one.
//
//   idx_session_sandboxes_deadline
//     Partial on the kill query's EXACT predicate:
//       status IN ('active','provisioning') AND deadline_at <= now()
//     The overwhelming majority of session_sandboxes rows are terminal
//     (stopped/archived) and can never be candidates, so a partial index keeps
//     the sweep's scan proportional to the live fleet rather than to history.
//     `provisioning` is in the predicate because a row parked at provisioning
//     WITH an external_id is otherwise invisible to every existing killer: the
//     reaper filters status='active', staleProvisioningReason bails on exactly
//     that shape, and reconcileStuckActiveSessions only touches project_sessions.
//     A VM is running and nothing sees it.
//
//   idx_usage_events_session_created
//     usage_events already has an index on session_id ALONE (see the baseline
//     migration), which makes a per-session `max(created_at)` an index scan plus
//     heap fetches for every row of that session -- and usage_events is one of
//     the largest tables here. Both the backfill (step 3) and the reaper's
//     existing loadLastUsageBySession do exactly that lookup. Partial on
//     session_id IS NOT NULL because a NULL session id can never join to a
//     sandbox, and today a non-trivial share of rows carry one.
//
// Neither index is declared in packages/db/src/schema/kortix.ts, following the
// pattern documented at 20260727113441903_project_sessions_account_active_index
// .concurrent.ts: a declared index makes `db:generate` emit a conflicting plain
// CREATE INDEX against the one already built here.
//
// IF NOT EXISTS makes each statement a no-op where the index already exists, so
// this is safe to re-run. Purely additive: CREATE INDEX CONCURRENTLY never
// blocks reads or writes.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls -- a multi-statement simple query is an
  // implicit transaction block, which silently defeats noTransaction().
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_session_sandboxes_deadline
      on kortix.session_sandboxes (deadline_at)
      where status in ('active', 'provisioning')
  `);
  pgm.sql(`
    create index concurrently if not exists idx_usage_events_session_created
      on kortix.usage_events (session_id, created_at desc)
      where session_id is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md).
export const down = false;

// Migration: provider_events_account_created_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// The audit reconciliation's per-account window
// (`reconcileAuditEvents`, apps/api/src/shared/audit-reconciliation.ts) scans
// every source ledger with `account_id = $1 AND <time> >= $since` — and
// where two time columns are in play, `created_at >= $since OR
// resolved/updated_at >= $since`. Without a composite, every arm of that
// predicate degraded to "heap-fetch the account's WHOLE history": the pass
// that must read "rows newer than the 6 h mark" read 58,341 lifecycle
// commands (payload TOAST included) or 937,464 connector calls for the
// largest accounts, ran 5–10 s waiting on IO/DataFileRead, and regularly
// blew the 25 s statement timeout (18 page failures + account skips in one
// 6 h prod window). While those scans ran, every other query on the
// instance slowed behind them — that is the fleet-wide DB-stall episode
// behind KRTX-797's `GET /v1/runtime-assets/chunk/:id` p95 tail (its own
// requests are auth + a 1 MiB positional read; every >1 s request spent
// ~all of its wall time in `auth`/`db` Server-Timing stages).
//
// Index built here: kortix.provider_events (account_id, created_at).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait (see packages/db/MIGRATIONS.md). IF NOT EXISTS keeps a re-run
// safe; an INVALID leftover from a failed build must be dropped by hand first.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_provider_events_account_created
      on kortix.provider_events (account_id, created_at)
  `);
};

export const down = false;

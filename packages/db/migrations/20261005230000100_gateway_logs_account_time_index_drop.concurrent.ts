// Migration: gateway_logs_account_time_index_drop  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Drops idx_gateway_logs_account_time, the bare (account_id, created_at) index
// that 20261005230000000_gateway_logs_account_cost_index.concurrent.ts
// replaces with idx_gateway_logs_account_cost: the same key columns plus
// INCLUDE (project_id, session_id, provider, resolved_model, billing_mode,
// final_cost_precise, upstream_cost_precise), i.e. a strict read superset for
// every (account_id, created_at) equality/range query on
// kortix.gateway_request_logs (cost rollups, session costs, usage rollup).
//
// The drop is load-bearing, not cosmetic: measured on a 2.15M-row fixture with
// default shared_buffers, with BOTH indexes present the planner still picked
// the narrower one (heap fetches per row) and only the covering index survived
// as an index-only scan after the drop. Keeping both would also pay double
// write amplification on the gateway ingest path for one usable index.
//
// mixed-version-safe: every query the dropped index served plans against the
// replacement (same key columns, strictly more INCLUDEd columns); older
// releases lose nothing they could read.
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF
// EXISTS so a re-run is safe, lock_timeout 180s (never the 2-5s
// plain-migration value), generous statement_timeout.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    drop index concurrently if exists kortix.idx_gateway_logs_account_time
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;

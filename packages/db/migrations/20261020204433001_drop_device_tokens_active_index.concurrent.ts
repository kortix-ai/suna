// Supabase unused_index on public.device_tokens (KRTX-1231). The issue's
// 2026-10-04 read-only check records zero scans for this secondary index.
// This legacy table is absent from fresh installations; IF EXISTS is a no-op.
// mixed-version-safe: no product code uses public.device_tokens; notifications
// use kortix.push_device_tokens. Primary and unique constraints are unchanged.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // Concurrent DDL waits for older transactions without blocking DML.
  pgm.sql("set lock_timeout = '180s'");
  pgm.sql("set statement_timeout = '30min'");
  pgm.sql('drop index concurrently if exists public.idx_device_tokens_active');
};

// Forward-only: recreate concurrently in a new migration if needed.
export const down = false;

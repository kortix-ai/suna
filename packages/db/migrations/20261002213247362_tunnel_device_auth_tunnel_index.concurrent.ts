// Migration: tunnel_device_auth_tunnel_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Covers the tunnel_id foreign key of kortix.tunnel_device_auth_requests →
// kortix.tunnel_connections(tunnel_id) (ON DELETE SET NULL, built by the
// 20260621094136410 baseline): a DELETE on tunnel_connections has to find this
// table's matching rows with no index that leads with tunnel_id. Supabase's
// performance advisor reports the table twice under unindexed_foreign_keys
// because prod carries the constraint twice — the baseline constraint
// tunnel_device_auth_requests_tunnel_id_tunnel_connections_tunnel and an
// out-of-band auto-named duplicate, tunnel_device_auth_requests_tunnel_id_fkey,
// with the same definition. One index on tunnel_id covers both; the duplicate
// constraint itself is prod-only drift no committed migration owns
// (verify-live-schema prints it as information only).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY waits
// for every transaction that began before it, and lock_timeout governs that wait.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build must
// be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_tunnel_device_auth_tunnel
      on kortix.tunnel_device_auth_requests using btree (tunnel_id)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;

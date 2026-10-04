// Migration: drop_unused_oauth_clients_account_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// The Supabase advisor's unused_index lint flags `idx_oauth_clients_account`
// (observed 2026-10-02, KRTX-1190): the index was built 2026-08-26 for
// `/accounts/{id}/iam/oauth-clients`, and pg_stat_user_indexes shows
// idx_scan = idx_tup_read = idx_tup_fetch = 0 since creation -- no read path
// has ever used it. Dropping it removes dead write overhead.
//
// `.concurrent.ts` because DROP INDEX CONCURRENTLY cannot run inside the
// single-transaction batch `pnpm migrate` wraps (MIGRATIONS.md
// "Roll-forward safety"). lock_timeout is 180s, not the 2-5s house value:
// a CONCURRENTLY drop waits on every transaction that holds the index and
// blocks no user while it waits (learnings 2026-08-19). IF EXISTS keeps the
// re-run safe after a cancelled drop.
//
// mixed-version-safe: a plain (non-unique) index is never needed for
// correctness; dropping it only removes a redundant access path. No query
// plan depends on its presence (verified: idx_scan = 0 in prod, and the only
// account_id-filtered read, listOAuthClients in
// repositories/oauth-clients.ts, has never run against prod stats). Old and
// new code tolerate its absence.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs inside
  // Postgres's implicit transaction and CONCURRENTLY fails anyway.
  await pgm.sql(`set lock_timeout = '180s'`);
  await pgm.sql(`set statement_timeout = '30min'`);
  await pgm.sql(`drop index concurrently if exists "kortix"."idx_oauth_clients_account"`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;

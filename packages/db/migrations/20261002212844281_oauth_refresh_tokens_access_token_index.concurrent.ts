// Migration: oauth_refresh_tokens_access_token_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds idx_oauth_refresh_tokens_access_token (kortix.ts), the covering index
// for the FK oauth_refresh_tokens_access_token_id_oauth_access_tokens_id_fk
// (access_token_id -> oauth_access_tokens.id, ON DELETE CASCADE). Every delete
// of an access token cascaded over this table with a sequential scan, and the
// RFC 7009 revocation path (apps/api/src/oauth/index.ts) looks live refresh
// tokens up by access_token_id. The table's other FK (client_id) is already
// covered by idx_oauth_refresh_tokens_client.
//
// One CONCURRENTLY build per file and per table (learnings: one CREATE INDEX
// CONCURRENTLY per table at a time).
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait. The one lock it holds (ShareUpdateExclusive) blocks no user.
// IF NOT EXISTS keeps a re-run safe; an INVALID leftover from a failed build
// must be dropped by hand first (see packages/db/MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_oauth_refresh_tokens_access_token
      on kortix.oauth_refresh_tokens using btree (access_token_id)
  `);
};

export const down = false;

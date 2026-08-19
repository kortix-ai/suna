// Migration: account_tokens_session_id_index  (CONCURRENTLY)
//
// kortix.account_tokens has 5,950 rows locally and NO index on session_id, yet
// two hot writers filter on exactly that column:
//   * remintSessionAgentGrant (projects/lib/session-token-grant.ts:61) rewrites
//     agent_grant for every live token of a session — it runs on EVERY prompt
//     via pre-prompt-env-sync.
//   * revokeSessionConnectorTokens (repositories/account-tokens.ts:338) revokes
//     them on session delete and on provider-removed reconciliation.
// Both seq-scan today. stores.md §8.4 flags it as the one index the RBAC
// migration must add before the table grows.
//
// Partial: 1,559 of 5,950 rows carry a session_id, and no query looks for
// session_id IS NULL, so the index only needs the session rows.
//
// One CREATE INDEX CONCURRENTLY, on one table, in its own migration — the
// learnings rule after the v0.12.7 audit-v2 pass, where two parallel CIC builds
// on the same table 55P03-thrashed each other. IF NOT EXISTS is deliberately
// NOT used: it silently keeps an INVALID shell from a killed builder.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();

  // One statement per pgm.sql() call: a multi-statement string goes through the
  // simple query protocol, which wraps it in an implicit transaction, and
  // CONCURRENTLY then fails with "cannot run inside a transaction block".
  await pgm.sql(`set lock_timeout = '5s'`);
  await pgm.sql(`set statement_timeout = '30min'`);
  await pgm.sql(
    `create index concurrently idx_account_tokens_session_id
       on kortix.account_tokens (session_id)
      where session_id is not null`,
  );
};

export const down = false;

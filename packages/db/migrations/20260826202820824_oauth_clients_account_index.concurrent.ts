// Migration: oauth_clients_account_index (NON-TRANSACTIONAL — CREATE INDEX CONCURRENTLY + FK VALIDATE)
//
// Companion to 20260826202820823_sign_in_with_kortix_oauth: the account_id
// column is new, so the index that lets `/accounts/{id}/iam/oauth-clients`
// list a tenant's clients is built without blocking writes. `oauth_clients`
// is small everywhere, but house rules keep every index on an existing table
// off the transactional path.
//
// lock_timeout is 180s, not the 2–5s house value: CREATE INDEX CONCURRENTLY
// waits on every transaction that started before it and blocks nobody while
// it waits (learnings 2026-08-19 "CIC under a 5-second lock_timeout").
//
// mixed-version-safe: index only. No code path depends on its presence.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  await pgm.sql(`set lock_timeout = '180s'`);
  await pgm.sql(`set statement_timeout = '30min'`);
  await pgm.sql(
    `create index concurrently if not exists "idx_oauth_clients_account" on "kortix"."oauth_clients" using btree ("account_id")`,
  );
  // The FK was added NOT VALID in the transactional sibling. account_id is a
  // new all-NULL column, so this scan finds nothing to reject; it runs here so
  // the VALIDATE is its own transaction (squawk constraint-missing-not-valid).
  await pgm.sql(
    `alter table "kortix"."oauth_clients" validate constraint "oauth_clients_account_id_accounts_account_id_fk"`,
  );
};

export const down = false;

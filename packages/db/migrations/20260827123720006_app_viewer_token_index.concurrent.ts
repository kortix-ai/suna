// Migration: app_viewer_token_index (NON-TRANSACTIONAL — CREATE INDEX CONCURRENTLY + VALIDATE)
//
// Companion to 20260827123720005_app_viewer_token. `oauth_clients.app_id` is a
// new all-NULL column: the unique index (one implicit OAuth client per Kortix
// App) is built without blocking writes, and the two NOT VALID constraints
// from the sibling are validated here, each in its own transaction.
//
// lock_timeout is 180s, not the 2–5s house value: CREATE INDEX CONCURRENTLY
// waits on every transaction that started before it and blocks nobody while it
// waits (learnings 2026-08-19 "CIC under a 5-second lock_timeout").
//
// mixed-version-safe: index + validation only. Old replicas never write
// app_id (the column did not exist for them) and never write a
// viewer_token_scope other than the default.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  await pgm.sql(`set lock_timeout = '180s'`);
  await pgm.sql(`set statement_timeout = '30min'`);
  await pgm.sql(
    `create unique index concurrently if not exists "idx_oauth_clients_app" on "kortix"."oauth_clients" using btree ("app_id")`,
  );
  await pgm.sql(
    `alter table "kortix"."oauth_clients" validate constraint "oauth_clients_app_id_apps_app_id_fk"`,
  );
  await pgm.sql(`alter table "kortix"."apps" validate constraint "apps_viewer_token_scope_check"`);
};

export const down = false;

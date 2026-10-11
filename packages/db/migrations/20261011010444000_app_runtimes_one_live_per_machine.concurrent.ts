// Migration: app_runtimes_one_live_per_machine  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// A release runs many machines (process groups x scale), so "one live runtime
// per deployment" becomes "one live instance per machine of a deployment".
// A row from before machines has no machine id; its runtime id stands in, so
// those rows stay unique exactly as before.
//
// Declared in packages/db/src/schema/kortix.ts (schema contract requires every
// built index to be declared there). The old index is dropped by the next
// migration, after this one exists.
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe, lock_timeout 180s, generous statement_timeout.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // Separate pgm.sql() calls: one multi-statement string runs as an implicit
  // transaction block and CONCURRENTLY fails inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create unique index concurrently if not exists app_runtimes_one_live_per_machine
      on kortix.app_runtimes using btree (deployment_id, coalesce(machine_id, runtime_id))
      where status in ('provisioning', 'starting', 'running', 'stopping')
  `);
};

export const down = false;

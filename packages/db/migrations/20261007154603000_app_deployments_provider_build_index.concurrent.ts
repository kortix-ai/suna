// Migration: app_deployments_provider_build_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Shared App images (`apps/api/src/apps/images.ts`) count the deployments that
// use an image by `provider_build_id = <image name>`: once per build claim,
// once per image release, and once per image in each maintenance reclaim
// pass. Without this index each count scans every deployment row.
//
// Declared in packages/db/src/schema/kortix.ts (schema contract requires every
// built index to be declared there).
//
// House .concurrent.ts rules (lint-enforced): ONE concurrent operation, IF NOT
// EXISTS so a re-run is safe, lock_timeout 180s (CONCURRENTLY waits on every
// older transaction and lock_timeout governs that wait), generous
// statement_timeout.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // Separate pgm.sql() calls: one multi-statement string runs as an implicit
  // transaction block and CONCURRENTLY fails inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists app_deployments_provider_build_idx
      on kortix.app_deployments using btree (provider_build_id)
  `);
};

export const down = false;

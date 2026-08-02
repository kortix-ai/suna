// Migration: agent_profile_open_cr_unique  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// The API reuses one open profile change request per agent. Concurrent publish
// requests need a database guard after both requests pass the reuse lookup.
// The fallback keeps compatibility with requests created by the older agent
// configuration flow, which uses the same branch and files.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_change_requests_open_agent_profile_agent
      on kortix.change_requests (
        project_id,
        ((coalesce(
          metadata->'agent_profile'->>'agent_name',
          metadata->'agent_config'->>'agent_name'
        )))
      )
      where status = 'open'
        and coalesce(
          metadata->'agent_profile'->>'agent_name',
          metadata->'agent_config'->>'agent_name'
        ) is not null
  `);
};

export const down = false;

// Migration: open_agent_config_cr_unique  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Direct agent creation opens branch-backed change requests. The API checks for
// an existing open agent CR before it creates a branch, but concurrent requests
// need a database guard too. This partial unique index reserves one open
// agent-config change request per (project_id, agent_name).
//
// CREATE INDEX CONCURRENTLY avoids write blocking on the change_requests table.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create unique index concurrently if not exists idx_change_requests_open_agent_config_agent
      on kortix.change_requests (
        project_id,
        ((metadata->'agent_config'->>'agent_name'))
      )
      where status = 'open'
        and metadata ? 'agent_config'
        and metadata->'agent_config'->>'agent_name' is not null
  `);
};

export const down = false;

// Build the legacy backup's key without blocking readers or writers.
// Production read-only preflight: 3,614 rows, no null or duplicate ids.
// The baseline does not create this table, so fresh installations skip it.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  const { rows } = await pgm.db.query("select to_regclass('public.agent_workflows_backup') is not null as present");
  if (!rows[0].present) return;
  pgm.sql(`create unique index concurrently if not exists agent_workflows_backup_pkey on public.agent_workflows_backup (id)`);
};

export const down = false;

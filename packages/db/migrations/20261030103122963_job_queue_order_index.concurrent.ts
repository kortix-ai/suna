export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`create index concurrently if not exists idx_job_queue_order on kortix.job_queue (queue, order_key, order_seq) where status = 'queued'`);
};

export const down = false;

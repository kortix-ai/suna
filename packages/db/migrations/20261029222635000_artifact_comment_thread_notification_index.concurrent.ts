// idx_notifications_artifact_thread: supports cascade deletion of notifications for an Artifact or comment thread.
// Concurrent index builds wait for older transactions without blocking ordinary writes.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`create index concurrently if not exists idx_notifications_artifact_thread on kortix.notifications (artifact_thread_id) where artifact_thread_id is not null`);
};

export const down = false;

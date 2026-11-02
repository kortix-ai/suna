// KRTX-2754: usage attribution seeks the newest message-bearing turn for
// every gateway request. Command turns have no message_id; including them in
// the existing session index makes each seek scan past the same command tail.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`create index concurrently if not exists session_turns_message_time_idx
    on kortix.session_turns (session_id, started_at desc nulls last)
    where message_id is not null`);
};

export const down = false;

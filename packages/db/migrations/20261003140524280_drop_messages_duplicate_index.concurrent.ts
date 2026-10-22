import type { MigrationBuilder } from 'node-pg-migrate';

// The production catalog has identical (thread_id, type, created_at DESC)
// definitions: the _desc twin is valid; the unsuffixed index is invalid.
// mixed-version-safe: removes a non-unique, non-constraint duplicate while
// retaining the valid _desc index. Queries do not reference either index name.
// IF EXISTS also covers fresh databases without the legacy public.messages.
export const up = (pgm: MigrationBuilder) => {
  pgm.noTransaction();
  // Concurrent DDL waits for older transactions without blocking their writes.
  // Keep each statement separate to avoid an implicit transaction.
  pgm.sql("set lock_timeout = '180s'");
  pgm.sql("set statement_timeout = '30min'");
  pgm.sql('drop index concurrently if exists public.idx_messages_thread_type_created');
};

export const down = false;

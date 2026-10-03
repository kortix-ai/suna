import type { MigrationBuilder } from 'node-pg-migrate';

export const shorthands = undefined;

// KRTX-1076: equality filters, then the time range; INCLUDE covers the actor aggregate.
// PostgreSQL cannot build a partitioned parent CONCURRENTLY. Build leaves serially,
// then attach them to an ON ONLY parent (metadata only). Future partitions inherit it.
// The session lock shares ensure_partitions' key and survives the runner's COMMIT.
// On failure the runner closes its connection, releasing the lock. An INVALID leaf
// fails closed: use MIGRATIONS.md's DROP INDEX CONCURRENTLY recovery before retrying.
export const up = async (pgm: MigrationBuilder): Promise<void> => {
  pgm.noTransaction();
  await pgm.db.query(`set lock_timeout = '180s'`);
  await pgm.db.query(
    `select pg_advisory_lock(hashtextextended('kortix.audit_events_ensure_partitions', 0))`,
  );
  const partitions = await pgm.db.query(`
    select n.nspname as schema, c.relname as table, c.oid
    from pg_inherits h join pg_class c on c.oid = h.inhrelid
    join pg_namespace n on n.oid = c.relnamespace
    where h.inhparent = 'kortix.audit_events'::regclass order by c.oid
  `);
  if (partitions.rows.length === 0) throw new Error('audit_events must have partitions');
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const parent = 'kortix.idx_audit_events_account_actor_type_time';
  // Queue DDL: node-pg-migrate commits the outer batch BEFORE executing these steps.
  // Immediate pgm.db.query(CREATE INDEX CONCURRENTLY) would still be transactional.
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`select set_config('lock_timeout', '2s', false)`);
  pgm.sql(`create index if not exists idx_audit_events_account_actor_type_time
    on only kortix.audit_events (account_id, actor_type, occurred_at) include (actor_user_id)`);
  for (const partition of partitions.rows) {
    if (
      typeof partition.schema !== 'string' ||
      typeof partition.table !== 'string' ||
      typeof partition.oid !== 'number'
    ) {
      throw new Error('Unexpected audit partition catalog row');
    }
    const index = `idx_audit_actor_${partition.oid}`;
    const qualifiedIndex = `${quote(partition.schema)}.${quote(index)}`;
    pgm.sql(`set lock_timeout = '180s'`);
    pgm.sql(`create index concurrently if not exists ${quote(index)}
      on ${quote(partition.schema)}.${quote(partition.table)}
      (account_id, actor_type, occurred_at) include (actor_user_id)`);
    pgm.sql(`select set_config('lock_timeout', '2s', false)`);
    pgm.sql(`alter index ${parent} attach partition ${qualifiedIndex}`);
  }
  pgm.sql(
    `select pg_advisory_unlock(hashtextextended('kortix.audit_events_ensure_partitions', 0))`,
  );
};

export const down = false;

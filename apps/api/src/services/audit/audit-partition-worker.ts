// Keeps `kortix.audit_events` supplied with weekly partitions. The table is partitioned by
// occurred_at; an INSERT whose week has no partition lands in the default partition, where
// retention never reaches it. Every tick makes sure the next 8 weeks exist. The SQL function is
// idempotent and serialises concurrent callers, so a leader change or a second replica is safe.
// The timer is in workers/audit-partitions.ts.
import { sql } from 'drizzle-orm';
import { auditDb } from './audit-db';

const WEEKS_AHEAD = 8;

export async function ensureAuditPartitions(
  weeksAhead = WEEKS_AHEAD,
): Promise<{ created: number; defaultPartitionHasRows: boolean }> {
  const db = auditDb();
  const [created] = Array.from(
    await db.execute<{ n: number }>(
      sql`SELECT kortix.audit_events_ensure_partitions('kortix.audit_events', current_date, ${weeksAhead}::integer) AS n`,
    ),
  );
  const [stray] = Array.from(
    await db.execute<{ present: boolean }>(
      sql`SELECT EXISTS (SELECT 1 FROM kortix.audit_events_default) AS present`,
    ),
  );
  return { created: Number(created?.n ?? 0), defaultPartitionHasRows: Boolean(stray?.present) };
}

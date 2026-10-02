// Keeps `kortix.audit_events` supplied with weekly partitions. The table is partitioned by
// occurred_at; an INSERT whose week has no partition lands in the default partition, where
// retention never reaches it. Every tick makes sure the next 8 weeks exist. The SQL function is
// idempotent and serialises concurrent callers, so a leader change or a second replica is safe.
// Recursive setTimeout keeps ticks serial per process.
import { sql } from 'drizzle-orm';
import { auditDb } from './audit-db';
import { runWorkerTick } from './audit-scope';

const WEEKS_AHEAD = 8;
const TICK_MS = 6 * 60 * 60_000;
// A failed tick (a lock timeout behind a long statement) retries soon: 8 weeks of runway means no
// urgency, but nothing should wait a whole tick for a transient failure.
const RETRY_MS = 5 * 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

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

async function tickAndRearm(): Promise<void> {
  let delay = TICK_MS;
  try {
    const result = await runWorkerTick('audit-partitions', () => ensureAuditPartitions());
    if (result?.created) console.info('[audit partitions] created', result.created, 'weekly partition(s)');
    if (result?.defaultPartitionHasRows) {
      console.warn('[audit partitions] kortix.audit_events_default holds rows: an instant had no weekly partition');
    }
  } catch (err) {
    delay = RETRY_MS;
    console.error('[audit partitions] tick failed', err);
  }
  if (!stopped) timer = setTimeout(tickAndRearm, delay);
}

export function startAuditPartitionWorker(): void {
  if (timer) return;
  stopped = false;
  void tickAndRearm();
}

export function stopAuditPartitionWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

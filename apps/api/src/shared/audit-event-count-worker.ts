// Keeps `kortix.audit_event_counts` supplied with exact per-5-minute counts of
// `kortix.audit_events` rows, so the ops dashboard's "audit events in the last
// 24 h" metric never scans `audit_events` on the request path.
//
// Why not count `audit_events` directly: an exact count over a time window
// visits every row in it — an index-only scan over `occurred_at` still fetches
// each row's heap page for the visibility check, because rows written since
// the last vacuum have no visibility-map bit. Measured on prod 2026-10-02:
// 65,007 rows / 10 min = 1.03 s, 268,641 rows / 1 h = 54.5 s — a 24 h count
// exceeds the API's 25 s statement_timeout on every call, so the metric
// degraded to null (apps/api/src/ops/index.ts). Partitioning bounds the scan
// range, not the row count, so the count itself needs a bounded source. The
// ingest path stays untouched (no per-row or per-batch writes): the counting
// happens here, off the request path, one bounded slot at a time.
//
// Each tick counts the closed slots that are missing (newest first, at most
// MAX_SLOTS_PER_TICK), upserting each slot's EXACT count — idempotent by
// recomputation, so concurrent replicas or a restart cannot double-count. A
// slot becomes eligible two slot boundaries after it began, which the
// 5-minute tick reaches 5–10 min after the slot closed: a relay retry that
// lands minutes late still carries its original occurred_at and falls in its
// own slot. ponytail: a fixed grace window — retries later than it land in an
// already-counted slot and undercount that slot; widen GRACE_SLOTS if
// incident forensics show drift. Slots older than 7 days are pruned by the
// same tick.
//
// Recursive setTimeout keeps ticks serial per process.
import { sql } from 'drizzle-orm';
import { runWorkerTick } from './audit-scope';
import { db } from './db';

/** Length of one counted slot. The dashboard sums 288 slots for 24 h. */
export const SLOT_MS = 5 * 60_000;
/** A slot becomes eligible this many slot boundaries after it started (the
 * late-relay-retry grace). */
export const GRACE_SLOTS = 2;
/** Catch-up window: a restart after an outage backfills the dashboard's 24 h
 * window plus one slot, never older history the dashboard does not read. */
const LOOKBACK_MS = 26 * 60 * 60_000;
/** At most this many slot counts per tick, so a long outage backfills over
 * several ticks instead of one long burst of scans. */
export const MAX_SLOTS_PER_TICK = 12;
const TICK_MS = 5 * 60_000;
// A failed tick (a slot count that hit the 25 s statement_timeout) retries on
// the next tick; the missing slot is picked up then. No separate retry delay.
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export function slotStartOf(ms: number): number {
  return Math.floor(ms / SLOT_MS) * SLOT_MS;
}

/** Slot starts the next pass should count: closed at least {@link GRACE_SLOTS}
 * ago, inside the lookback window, not yet counted, newest first, at most
 * `opts.max` of them. */
export function pendingSlotStarts(
  nowMs: number,
  counted: ReadonlySet<number>,
  opts?: { lookbackMs?: number; max?: number },
): number[] {
  const newest = slotStartOf(nowMs) - GRACE_SLOTS * SLOT_MS;
  const oldest = slotStartOf(nowMs - (opts?.lookbackMs ?? LOOKBACK_MS));
  const max = opts?.max ?? MAX_SLOTS_PER_TICK;
  const out: number[] = [];
  for (let start = newest; start >= oldest && out.length < max; start -= SLOT_MS) {
    if (!counted.has(start)) out.push(start);
  }
  return out;
}

/** One pass: count every eligible missing slot, then prune expired ones.
 * `nowMs` pins the clock for tests; production reads the database's own clock
 * so the pass shares the clock the data was written against. */
export async function countPass(nowMs?: number): Promise<{ counted: number }> {
  let now = nowMs;
  if (now === undefined) {
    const [nowRow] = Array.from(await db.execute<{ now: string | Date }>(sql`SELECT now() AS now`));
    now = nowRow ? new Date(nowRow.now).getTime() : Date.now();
  }
  const windowStart = new Date(slotStartOf(now - LOOKBACK_MS));
  const windowEnd = new Date(slotStartOf(now));
  const countedSlots = Array.from(
    await db.execute<{ slot_start: string | Date }>(sql`
      SELECT slot_start FROM kortix.audit_event_counts
      WHERE slot_start >= ${windowStart} AND slot_start < ${windowEnd}
    `),
  );
  const counted = new Set(countedSlots.map((row) => new Date(row.slot_start).getTime()));
  const pending = pendingSlotStarts(now, counted);
  for (const start of pending) {
    const end = new Date(start + SLOT_MS);
    const [countRow] = Array.from(
      await db.execute<{ count: string | number }>(sql`
        SELECT count(*)::bigint AS count FROM kortix.audit_events
        WHERE occurred_at >= ${new Date(start)} AND occurred_at < ${end}
      `),
    );
    const events = Number(countRow?.count ?? 0);
    await db.execute(sql`
      INSERT INTO kortix.audit_event_counts (slot_start, events, counted_at)
      VALUES (${new Date(start)}, ${events}, now())
      ON CONFLICT (slot_start) DO UPDATE
        SET events = EXCLUDED.events, counted_at = now()
    `);
  }
  await db.execute(sql`
    DELETE FROM kortix.audit_event_counts
    WHERE slot_start < now() - interval '7 days'
  `);
  return { counted: pending.length };
}

async function tickAndRearm(): Promise<void> {
  try {
    const result = await runWorkerTick('audit-event-counts', () => countPass());
    if (result.counted) console.info('[audit event counts] counted', result.counted, 'slot(s)');
  } catch (err) {
    // The next tick retries whatever is still missing; nothing waits a whole
    // cycle for a transient failure, and nothing doubles (counts are exact).
    console.error('[audit event counts] tick failed', err);
  }
  if (!stopped) timer = setTimeout(tickAndRearm, TICK_MS);
}

export function startAuditEventCountWorker(): void {
  if (timer) return;
  stopped = false;
  void tickAndRearm();
}

export function stopAuditEventCountWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * Bounded, batched, asynchronous writer for `kortix.audit_events`.
 *
 * Why this exists: `auditApiRequest` (shared/audit.ts) runs on every `/v1/*`
 * request and used to `await` a single-row INSERT into a 14-index table before
 * the response was released. On staging that put the audit write on the
 * critical path of every authenticated request: pg_stat_statements measured the
 * INSERT at a 8,134 ms mean over 8,885 calls under release-gate load, and the
 * resulting request times (up to 37 s) turned into ALB 5xx.
 *
 * The fix is to decouple emission from the request. Callers enqueue a fully
 * built row and return immediately; a flusher drains the queue into multi-row
 * INSERTs. The queue is bounded and drops the OLDEST rows on overflow, so a
 * database stall degrades audit completeness instead of degrading availability.
 *
 * Invariants:
 *  - `enqueue` never throws and never blocks on I/O.
 *  - a flush never throws into a caller; failures are logged and the batch is
 *    dropped (retrying in-process would amplify the stall that caused it).
 *  - the batch INSERT uses `onConflictDoNothing()`, which preserves the
 *    `idx_audit_events_source_phase` partial-unique dedup semantics
 *    (source_ledger, source_record_id, phase, coalesce(source_revision,''))
 *    used by the OpenCode relay ledger. Without it a single duplicate row would
 *    fail an entire batch.
 */
import { type Database, auditEvents } from '@kortix/db';

export type AuditRow = typeof auditEvents.$inferInsert;

/** The minimum surface the queue needs from Drizzle — keeps tests db-free. */
export type AuditInsertClient = Pick<Database, 'insert'>;

export interface AuditQueueOptions {
  /** Flush at most this long after the first row of a batch is enqueued. */
  flushMs?: number;
  /** Flush immediately once the queue holds this many rows. */
  flushMax?: number;
  /** Hard ceiling on buffered rows. Overflow drops the oldest. */
  queueMax?: number;
  /** Minimum gap between "dropped N events" warnings. */
  dropLogIntervalMs?: number;
  now?: () => number;
  onError?: (error: unknown, rowCount: number) => void;
  onDrop?: (droppedTotal: number, sinceLastLog: number) => void;
}

export const AUDIT_FLUSH_MS_DEFAULT = 250;
// 100, lowered from 500 (Essentia convoy fix): each row's BEFORE INSERT trigger
// takes a per-session FOR UPDATE lock held to the batch's COMMIT, so a large
// batch holds every touched session's lock for the whole commit and cross-blocks
// the other replica. Smaller batches commit sooner. Tunable via KORTIX_AUDIT_FLUSH_MAX.
export const AUDIT_FLUSH_MAX_DEFAULT = 100;
export const AUDIT_QUEUE_MAX_DEFAULT = 5_000;
const DROP_LOG_INTERVAL_MS = 60_000;

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AuditQueueStats {
  queued: number;
  enqueued: number;
  written: number;
  dropped: number;
  failed: number;
  flushes: number;
}

export class AuditQueue {
  private readonly rows: AuditRow[] = [];
  private readonly flushMs: number;
  private readonly flushMax: number;
  private readonly queueMax: number;
  private readonly dropLogIntervalMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown, rowCount: number) => void;
  private readonly onDrop: (droppedTotal: number, sinceLastLog: number) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  /** `null` = never warned yet. The FIRST overflow must always warn. */
  private lastDropLogAt: number | null = null;
  private droppedSinceLastLog = 0;

  private enqueued = 0;
  private written = 0;
  private dropped = 0;
  private failed = 0;
  private flushes = 0;

  constructor(
    private readonly client: AuditInsertClient,
    options: AuditQueueOptions = {},
  ) {
    this.flushMs = options.flushMs ?? AUDIT_FLUSH_MS_DEFAULT;
    this.flushMax = options.flushMax ?? AUDIT_FLUSH_MAX_DEFAULT;
    this.queueMax = options.queueMax ?? AUDIT_QUEUE_MAX_DEFAULT;
    this.dropLogIntervalMs = options.dropLogIntervalMs ?? DROP_LOG_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onError =
      options.onError ??
      ((error, rowCount) => {
        console.error(
          `[audit] Dropped a batch of ${rowCount} events after a write failure:`,
          error,
        );
      });
    this.onDrop =
      options.onDrop ??
      ((droppedTotal, sinceLastLog) => {
        console.warn(
          `[audit] Queue full — dropped ${sinceLastLog} oldest events (${droppedTotal} total). Audit writes are falling behind; raise KORTIX_AUDIT_QUEUE_MAX or investigate database latency.`,
        );
      });
  }

  /**
   * Buffer one row. Returns synchronously — never awaits I/O, never throws.
   * The row must already be fully built (request context resolved) because it
   * is written long after the request's AsyncLocalStorage scope has ended.
   */
  enqueue(row: AuditRow): void {
    this.enqueued += 1;
    this.rows.push(row);

    if (this.rows.length > this.queueMax) {
      // Drop OLDEST: under sustained overload the newest events describe the
      // incident in progress and are the ones worth keeping.
      const overflow = this.rows.length - this.queueMax;
      this.rows.splice(0, overflow);
      this.dropped += overflow;
      this.droppedSinceLastLog += overflow;
      this.maybeLogDrops();
    }

    if (this.rows.length >= this.flushMax) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  private maybeLogDrops(): void {
    const now = this.now();
    if (this.lastDropLogAt !== null && now - this.lastDropLogAt < this.dropLogIntervalMs) return;
    this.lastDropLogAt = now;
    const sinceLastLog = this.droppedSinceLastLog;
    this.droppedSinceLastLog = 0;
    this.onDrop(this.dropped, sinceLastLog);
  }

  private scheduleFlush(): void {
    if (this.timer !== null || this.rows.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    // Never hold the process open for a pending audit flush; `flush()` on the
    // shutdown path is what guarantees the tail is written.
    this.timer.unref?.();
  }

  /**
   * Drain the queue into batched INSERTs. Safe to call concurrently: overlapping
   * callers await the in-flight drain instead of racing it. Never rejects.
   */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.drain().finally(() => {
      this.inFlight = null;
      // A row enqueued while the drain was running still needs a timer.
      this.scheduleFlush();
    });
    this.inFlight = run;
    return run;
  }

  private async drain(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.rows.length > 0) {
      const batch = this.rows.splice(0, this.flushMax);
      this.flushes += 1;
      try {
        await this.client.insert(auditEvents).values(batch).onConflictDoNothing();
        this.written += batch.length;
      } catch (error) {
        // Re-queuing would amplify whatever stalled the database, and the audit
        // trail is best-effort by construction. Account for it and move on.
        this.failed += batch.length;
        this.onError(error, batch.length);
      }
    }
  }

  /** Flush everything and stop the timer. Used by the shutdown path. */
  async shutdown(): Promise<void> {
    await this.flush();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  stats(): AuditQueueStats {
    return {
      queued: this.rows.length,
      enqueued: this.enqueued,
      written: this.written,
      dropped: this.dropped,
      failed: this.failed,
      flushes: this.flushes,
    };
  }
}

let queue: AuditQueue | null = null;

/** Lazily built so importing this module never touches the database. */
export function getAuditQueue(client: AuditInsertClient): AuditQueue {
  if (!queue) {
    queue = new AuditQueue(client, {
      flushMs: positiveInt(process.env.KORTIX_AUDIT_FLUSH_MS, AUDIT_FLUSH_MS_DEFAULT),
      flushMax: positiveInt(process.env.KORTIX_AUDIT_FLUSH_MAX, AUDIT_FLUSH_MAX_DEFAULT),
      queueMax: positiveInt(process.env.KORTIX_AUDIT_QUEUE_MAX, AUDIT_QUEUE_MAX_DEFAULT),
    });
  }
  return queue;
}

/** Test seam. */
export function resetAuditQueueForTests(): void {
  queue = null;
}

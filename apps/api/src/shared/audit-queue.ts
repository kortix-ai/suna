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
 *  - a flush never throws into a caller.
 *  - a batch that fails on lock/connection CONTENTION (55P03/57014/40001/
 *    40P01, or the database being unreachable) is requeued for a later flush,
 *    with exponential backoff, and is NEVER dropped for that reason alone —
 *    only the queue-overflow path above may drop rows, under sustained
 *    overload. Only a genuinely POISON batch (a data error: a constraint, a
 *    bad value) is logged loudly and dead-lettered, because retrying that can
 *    never succeed.
 *  - the batch INSERT uses `onConflictDoNothing()`, which preserves the
 *    `idx_audit_events_source_phase` partial-unique dedup semantics
 *    (source_ledger, source_record_id, phase, coalesce(source_revision,''))
 *    used by the OpenCode relay ledger. Without it a single duplicate row would
 *    fail an entire batch.
 */
import { type Database, auditEvents } from '@kortix/db';
import { errorSqlstate, innermostMessage, isAuditContentionError } from './error-cause';
import { exponentialBackoffMs } from './backoff';

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
  /** Called for a genuinely poison batch (a data error) that is dead-lettered. */
  onError?: (error: unknown, rowCount: number) => void;
  onDrop?: (droppedTotal: number, sinceLastLog: number) => void;
  /**
   * Called when a contended batch is reported. Rate-limited to at most one
   * call per `retryLogIntervalMs`; every requeued row is still counted in
   * `stats().contended`.
   */
  onRetry?: (error: unknown, rowCount: number, attempt: number, delayMs: number) => void;
  /** Minimum gap between "Write contended" warnings. */
  retryLogIntervalMs?: number;
  /** Base of the exponential backoff applied between contended retries. */
  retryBaseMs?: number;
  /** Ceiling the backoff never exceeds, however many consecutive contentions. */
  retryMaxMs?: number;
  /** Source of jitter for the backoff. Injectable so a test is deterministic. */
  random?: () => number;
  /** How long `shutdown()` keeps retrying contended rows before giving up. */
  shutdownDeadlineMs?: number;
  /** Sleep primitive `shutdown()` uses between contended retries. */
  sleep?: (ms: number) => Promise<void>;
}

export const AUDIT_FLUSH_MS_DEFAULT = 250;
// 100 rows per statement. Tunable via KORTIX_AUDIT_FLUSH_MAX.
export const AUDIT_FLUSH_MAX_DEFAULT = 100;
export const AUDIT_QUEUE_MAX_DEFAULT = 5_000;
const DROP_LOG_INTERVAL_MS = 60_000;
// A contended batch is retried, never dropped, so a stuck session used to emit
// one warn PER RETRY ATTEMPT. Prod, 2026-09-28: 8,528 of these lines in one
// day, 100% expected backpressure, 0% data loss (the queue's `dropped` stayed
// 0). It read as a new warn-pattern spike and paged. Rate-limit it like the
// overflow warning: the FIRST contention is always reported, then at most one
// line per interval. `stats().contended` still counts every requeued row.
const RETRY_LOG_INTERVAL_MS = 60_000;

// A contended batch is requeued, never dropped, so it must be retried without
// hammering the same session lock every `flushMs`. Exponential backoff with
// equal jitter (half fixed, half random) keeps the floor predictable while
// still spreading concurrent replicas' retries apart.
export const AUDIT_RETRY_BASE_MS_DEFAULT = 200;
export const AUDIT_RETRY_MAX_MS_DEFAULT = 10_000;
export const AUDIT_SHUTDOWN_DEADLINE_MS_DEFAULT = 10_000;

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
  /** Poison batches (a data error) dead-lettered — these can never succeed. */
  failed: number;
  /** Contention (lock/connection) failures requeued for a later attempt. */
  contended: number;
  flushes: number;
}

/**
 * Exponential backoff with equal jitter: half the capped delay is fixed, half
 * is random, so the delay is never near-zero (which would just re-hammer the
 * lock) and never unbounded. `attempt` is 1 for the first retry.
 */
export function retryBackoffMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  randomValue: number,
): number {
  const capped = exponentialBackoffMs({ attempt, baseMs, capMs: maxMs });
  const half = capped / 2;
  return Math.floor(half + randomValue * half);
}

/**
 * Split one flush snapshot into statements of at most `max` rows, in arrival order.
 * No statement holds a per-session lock any more (the BEFORE INSERT trigger only
 * sets the source columns), so rows of different sessions share a statement.
 */
export function statementBatches(rows: AuditRow[], max: number): AuditRow[][] {
  const batches: AuditRow[][] = [];
  for (let offset = 0; offset < rows.length; offset += max) {
    batches.push(rows.slice(offset, offset + max));
  }
  return batches;
}

/**
 * What actually went wrong, in one bounded line.
 *
 * Passing the error object straight to `console.error` printed a
 * `DrizzleQueryError`, whose `.message` is the entire generated statement —
 * 48 column names, 44 placeholders — followed by `params:` and every bound
 * value. The SQLSTATE that says WHY is not in there at all; it lives on
 * `.cause` (see the audit-db learning: a wrapper error hides its cause, so
 * never read `.message`). Prod dropped ~600 audit events over 48 hours and no
 * line in the log could tell anyone which failure it was.
 *
 * Two problems, one fix. The bound values are audit payloads: IP addresses,
 * user agents, account and project ids. They do not belong in an error log at
 * all, and they were the reason each of these lines ran to several kilobytes.
 *
 * So: the SQLSTATE first, then the innermost cause's own message, truncated.
 * No statement text, no parameters.
 */
export function describeAuditWriteFailure(error: unknown): string {
  const sqlstate = errorSqlstate(error);
  const detail = innermostMessage(error) ?? 'no error message available';
  const trimmed =
    detail.length > AUDIT_FAILURE_DETAIL_MAX
      ? `${detail.slice(0, AUDIT_FAILURE_DETAIL_MAX)}…`
      : detail;
  return sqlstate ? `sqlstate=${sqlstate} ${trimmed}` : trimmed;
}

const AUDIT_FAILURE_DETAIL_MAX = 300;

export class AuditQueue {
  private readonly rows: AuditRow[] = [];
  private readonly flushMs: number;
  private readonly flushMax: number;
  private readonly queueMax: number;
  private readonly dropLogIntervalMs: number;
  private readonly retryLogIntervalMs: number;
  private readonly now: () => number;
  private readonly onError: (error: unknown, rowCount: number) => void;
  private readonly onDrop: (droppedTotal: number, sinceLastLog: number) => void;
  private readonly onRetry: (
    error: unknown,
    rowCount: number,
    attempt: number,
    delayMs: number,
  ) => void;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly random: () => number;
  private readonly shutdownDeadlineMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  /** `null` = never warned yet. The FIRST overflow must always warn. */
  private lastDropLogAt: number | null = null;
  private droppedSinceLastLog = 0;
  /** `null` = never warned yet. The FIRST contention must always warn. */
  private lastRetryLogAt: number | null = null;
  /**
   * Consecutive contention events across flushes, reset by any flush that
   * completes with zero contention. Backs off `scheduleFlush`'s delay so a
   * stuck session lock is retried on a growing interval, not every `flushMs`.
   */
  private consecutiveContentions = 0;
  /** Earliest time the NEXT flush may run. 0 means no active backoff. */
  private nextEligibleFlushAt = 0;

  private enqueued = 0;
  private written = 0;
  private dropped = 0;
  private failed = 0;
  private contended = 0;
  private flushes = 0;

  constructor(
    private readonly client: AuditInsertClient,
    options: AuditQueueOptions = {},
  ) {
    this.flushMs = options.flushMs ?? AUDIT_FLUSH_MS_DEFAULT;
    this.flushMax = options.flushMax ?? AUDIT_FLUSH_MAX_DEFAULT;
    this.queueMax = options.queueMax ?? AUDIT_QUEUE_MAX_DEFAULT;
    this.dropLogIntervalMs = options.dropLogIntervalMs ?? DROP_LOG_INTERVAL_MS;
    this.retryLogIntervalMs = options.retryLogIntervalMs ?? RETRY_LOG_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.retryBaseMs = options.retryBaseMs ?? AUDIT_RETRY_BASE_MS_DEFAULT;
    this.retryMaxMs = options.retryMaxMs ?? AUDIT_RETRY_MAX_MS_DEFAULT;
    this.random = options.random ?? Math.random;
    this.shutdownDeadlineMs = options.shutdownDeadlineMs ?? AUDIT_SHUTDOWN_DEADLINE_MS_DEFAULT;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          const t = setTimeout(resolve, ms);
          t.unref?.();
        }));
    this.onError =
      options.onError ??
      ((error, rowCount) => {
        // A poison batch is a DEFECT, not backpressure: retrying a constraint
        // violation or a bad value can never succeed, so it is logged loudly
        // (with the count, per incident policy) and dead-lettered once.
        console.error(
          `[audit] Dead-lettered a poison batch of ${rowCount} events (data error, cannot be retried): ${describeAuditWriteFailure(error)}`,
        );
      });
    this.onDrop =
      options.onDrop ??
      ((droppedTotal, sinceLastLog) => {
        console.warn(
          `[audit] Queue full — dropped ${sinceLastLog} oldest events (${droppedTotal} total). Audit writes are falling behind; raise KORTIX_AUDIT_QUEUE_MAX or investigate database latency.`,
        );
      });
    this.onRetry =
      options.onRetry ??
      ((error, rowCount, attempt, delayMs) => {
        // Expected backpressure, not a defect: warn, don't page. The batch is
        // still buffered and will be retried — it is never dropped for this.
        console.warn(
          `[audit] Write contended — requeuing ${rowCount} events for retry #${attempt} in ${delayMs}ms: ${describeAuditWriteFailure(error)}`,
        );
      });
  }

  /** The delay before the next contended retry, given the current streak. */
  private retryDelayMs(): number {
    return retryBackoffMs(
      this.consecutiveContentions,
      this.retryBaseMs,
      this.retryMaxMs,
      this.random(),
    );
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

    // Under an active contention backoff, reaching flushMax must NOT trigger
    // an immediate flush — that would re-hammer the same session lock on
    // every arriving row instead of honoring the backoff window, defeating
    // the whole point of it. Fall through to `scheduleFlush`, which respects
    // `nextEligibleFlushAt`.
    if (this.rows.length >= this.flushMax && this.now() >= this.nextEligibleFlushAt) {
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
    const delay = Math.max(this.flushMs, this.nextEligibleFlushAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    // Never hold the process open for a pending audit flush; `flush()` on the
    // shutdown path is what guarantees the tail is written.
    this.timer.unref?.();
  }

  /**
   * Write a snapshot of the queue. Rows added after this call remain buffered
   * for the next flush, so a read barrier cannot be extended by live traffic.
   * Concurrent snapshots run in order and never race their INSERTs.
   */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.rows.splice(0);
    if (snapshot.length === 0) return this.inFlight ?? Promise.resolve();

    const previous = this.inFlight;
    const run: Promise<void> = (previous ?? Promise.resolve())
      .then(() => this.write(snapshot))
      .finally(() => {
        if (this.inFlight === run) {
          this.inFlight = null;
          this.scheduleFlush();
        }
      });
    this.inFlight = run;
    return run;
  }

  /**
   * Write a snapshot. A batch that fails on lock/connection CONTENTION
   * (55P03/57014/40001/40P01, or the database being unreachable) is requeued
   * for a later flush — never dropped. Only a genuinely POISON batch (a data
   * error: a constraint, a bad value) is dead-lettered, because retrying that
   * can never succeed.
   *
   * Prod, 2026-09-24 through 2026-09-27: every drop this queue logged was
   * sqlstate=55P03 (lock_timeout), i.e. 100% backpressure, 0% poison — and
   * every one of them was silently discarded audit history. See the
   * `learnings` entry for this incident.
   */
  private async write(snapshot: AuditRow[]): Promise<void> {
    const requeue: AuditRow[] = [];
    // Only the first contention of the flush is ever logged (see below), so
    // keep that one, not the whole list.
    let firstContention: { error: unknown; rowCount: number } | null = null;
    for (const batch of statementBatches(snapshot, this.flushMax)) {
      this.flushes += 1;
      try {
        await this.client.insert(auditEvents).values(batch).onConflictDoNothing();
        this.written += batch.length;
      } catch (error) {
        if (isAuditContentionError(error)) {
          // Backpressure, not a defect. Keep the rows — in their original
          // relative order, restored below — for the next flush attempt.
          this.contended += batch.length;
          requeue.push(...batch);
          firstContention ??= { error, rowCount: batch.length };
        } else {
          // A poison batch can never succeed on retry: dead-letter it once,
          // loudly, with the count, and move on.
          this.failed += batch.length;
          this.onError(error, batch.length);
        }
      }
    }

    if (requeue.length > 0) {
      // Prepend: these rows arrived before anything enqueued DURING this
      // flush (already at the tail of `this.rows`), so putting them back at
      // the front preserves arrival order, which the (time-ordered) event_id
      // assigned at INSERT then reflects.
      this.rows.unshift(...requeue);
      this.consecutiveContentions += 1;
      const delayMs = this.retryDelayMs();
      const now = this.now();
      this.nextEligibleFlushAt = now + delayMs;
      // Report the FIRST contention immediately, then at most one line per
      // interval — expected backpressure must not flood the log. Every
      // requeued row is still counted in `stats().contended`, and the rows
      // themselves are never dropped.
      if (
        firstContention &&
        (this.lastRetryLogAt === null || now - this.lastRetryLogAt >= this.retryLogIntervalMs)
      ) {
        this.lastRetryLogAt = now;
        this.onRetry(
          firstContention.error,
          firstContention.rowCount,
          this.consecutiveContentions,
          delayMs,
        );
      }
    } else {
      this.consecutiveContentions = 0;
      this.nextEligibleFlushAt = 0;
    }
  }

  /**
   * Flush everything and stop the timer. Used by the shutdown path.
   *
   * A contended row is never dropped by `write()`, so a database that stays
   * down would otherwise spin this loop forever and wedge the process exit.
   * Bound it: sleep out the backoff between attempts (never spin-hammer the
   * lock), and give up after `shutdownDeadlineMs` — at that point the process
   * is exiting regardless, and whatever is still buffered is lost with it
   * exactly as it would be if the process were killed mid-request. Logged
   * loudly so this is never a silent loss.
   */
  async shutdown(): Promise<void> {
    const deadline = this.now() + this.shutdownDeadlineMs;
    while (this.rows.length > 0 || this.inFlight) {
      await this.flush();
      // Rows can remain buffered for two reasons: a benign race (something
      // enqueued while this flush ran — loop again immediately, same as
      // before this fix) or an active contention backoff. Only the second
      // needs a bounded sleep and a deadline.
      if (this.rows.length > 0 && this.consecutiveContentions > 0) {
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          console.error(
            `[audit] Shutdown deadline reached with ${this.rows.length} events still contended — the process is exiting and these will NOT be written.`,
          );
          break;
        }
        await this.sleep(Math.min(this.retryDelayMs(), remaining));
      }
    }
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
      contended: this.contended,
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
      retryBaseMs: positiveInt(process.env.KORTIX_AUDIT_RETRY_BASE_MS, AUDIT_RETRY_BASE_MS_DEFAULT),
      retryMaxMs: positiveInt(process.env.KORTIX_AUDIT_RETRY_MAX_MS, AUDIT_RETRY_MAX_MS_DEFAULT),
    });
  }
  return queue;
}

/** Test seam. */
export function resetAuditQueueForTests(): void {
  queue = null;
}

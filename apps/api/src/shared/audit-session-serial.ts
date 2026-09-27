/**
 * Process-local, per-session serialization of audit writes.
 *
 * WHY THIS EXISTS
 * ---------------
 * `kortix.audit_prepare_event` allocates a per-session sequence and hash-chain
 * head out of `kortix.audit_session_sequences`, and PostgreSQL holds that row
 * lock until the inserting statement's transaction COMMITs. The append-only
 * chain genuinely requires that one session's rows serialize, but it does NOT
 * require two writers in the SAME API process to fight over the row.
 *
 * They do, for the hottest route we have. Every `POST
 * /v1/projects/:p/sessions/:s/audit/events` is written twice by the same
 * process, at the same moment, for the same `sessionId`:
 *
 *   1. the sandbox ingest route inserts the batch in 25-row chunks, and
 *   2. the audit queue flushes the request's OWN inbound audit row
 *      (`sessionIdForSnapshot` returns the path session id).
 *
 * Under load the ingest's chunk holds the session row for up to its 10 s
 * `statement_timeout`, so it dies with `57014` and answers `503`. The queue's
 * competing row loses the same lock at the 2.5 s `lock_timeout` (`55P03`) and is
 * permanently dropped (`[audit] Dropped a batch …`). Prod 2026-09-26: every 5xx
 * on that route was this `57014`, and the queue dropped 632 rows in one hour.
 *
 * WHAT THIS DOES
 * --------------
 * A tiny FIFO async mutex keyed by `sessionId`. Every in-process writer of a
 * session's audit rows takes it, so at most one INSERT for a session is in
 * flight at a time and the second writer waits in MEMORY instead of opening a
 * second Postgres lock wait. Waiting in memory cannot be dropped by
 * `lock_timeout`, and it cannot burn a pooled backend on a lock wait.
 *
 * Rows with no `sessionId` take no session row lock at all (the trigger skips
 * the sequence block), so they are not serialized here either.
 *
 * The lock is deliberately bounded where the caller is on a request path: a
 * waiter that cannot acquire within its budget throws
 * {@link AuditSessionLockTimeoutError}, which both callers already classify as
 * retryable backpressure. The queue, which is off the request path, waits
 * without a timeout and then performs an uncontended insert — the behaviour its
 * `55P03` drop could never reach.
 *
 * Scope: ONE process. Two API replicas still serialize in Postgres, which is
 * why the lock is an additional layer, never a replacement for the pool's
 * `lock_timeout`. The mutex is intentionally small and self-cleaning: it holds
 * no timers, no I/O and no database handle.
 */

/** Thrown when a bounded waiter cannot acquire a session's audit lock in time. */
export class AuditSessionLockTimeoutError extends Error {
  /** A stable marker both callers classify as retryable backpressure. */
  readonly code = 'AUDIT_SESSION_LOCK_TIMEOUT';

  constructor(
    readonly sessionId: string,
    readonly waitedMs: number,
  ) {
    super(`audit write for session waited ${waitedMs}ms for the in-process session lock`);
    this.name = 'AuditSessionLockTimeoutError';
  }
}

export function isAuditSessionLockTimeout(error: unknown): error is AuditSessionLockTimeoutError {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof AuditSessionLockTimeoutError) return true;
  return (error as { code?: unknown }).code === 'AUDIT_SESSION_LOCK_TIMEOUT';
}

interface SessionGate {
  /** Resolves when the last queued holder releases. Callers chain onto this. */
  tail: Promise<void>;
  /** Callers currently holding or waiting. Zero means the entry can be freed. */
  waiting: number;
}

const gates = new Map<string, SessionGate>();

export interface AuditSessionLockOptions {
  /**
   * Milliseconds to wait for our turn. Omit to wait indefinitely (the audit
   * queue, which is off the request path). A bounded wait throws
   * {@link AuditSessionLockTimeoutError} instead of running past a request
   * deadline.
   */
  timeoutMs?: number;
}

/**
 * Run `fn` while holding the process-local lock for `sessionId`.
 *
 * `fn`'s rejection still releases the lock and propagates unchanged.
 */
export async function withAuditSessionLock<T>(
  sessionId: string | null | undefined,
  fn: () => Promise<T>,
  options: AuditSessionLockOptions = {},
): Promise<T> {
  const key = typeof sessionId === 'string' ? sessionId.trim() : '';
  // No session, no `audit_session_sequences` row, no lock to take.
  if (!key) return fn();

  const gate = gates.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
  gates.set(key, gate);
  gate.waiting += 1;

  // Our slot resolves only when we release it. The NEXT caller chains onto it,
  // so release order is FIFO and a rejected `fn` cannot wedge the queue.
  const previous = gate.tail;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.tail = previous.then(() => held);

  try {
    if (options.timeoutMs === undefined) {
      await previous;
    } else {
      await waitWithTimeout(previous, options.timeoutMs, key);
    }
    return await fn();
  } finally {
    release();
    gate.waiting -= 1;
    // Free the entry when nobody holds or waits — the map must not grow with
    // every session the process has ever audited.
    if (gate.waiting === 0 && gates.get(key) === gate) gates.delete(key);
  }
}

function waitWithTimeout(
  previous: Promise<void>,
  timeoutMs: number,
  sessionId: string,
): Promise<void> {
  if (timeoutMs <= 0) {
    return previous.then(() => undefined);
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AuditSessionLockTimeoutError(sessionId, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
    previous.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Test seam: how many sessions currently hold or wait on a lock. */
export function auditSessionLockCountForTest(): number {
  return gates.size;
}

/** Test seam: drop all gates so cases cannot leak state into each other. */
export function resetAuditSessionLocksForTest(): void {
  gates.clear();
}

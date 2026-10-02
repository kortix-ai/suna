/**
 * Reading the truth out of a wrapped error. No imports — every module that
 * needs this is one a database module must be able to depend on, or one that
 * must stay database-free. A leaf keeps both true.
 *
 * The rule this encodes (learnings, 2026-09-10): a wrapper error hides its
 * cause, so never read `.message`. `DrizzleQueryError.message` is the whole
 * generated statement plus its bound parameters; the SQLSTATE that says what
 * actually failed is on `.cause`.
 */

/**
 * The first `code` found walking down the cause chain.
 *
 * FIRST, not deepest, and deliberately so: this is the behaviour
 * `auditErrorSqlstate` has had in production, and it decides whether an audit
 * write is retried. Drizzle's wrapper carries no `code`, so the first hit is
 * the driver's SQLSTATE anyway; the two rules only diverge for an error that
 * synthesises its own code above a driver error, and in that case the outer
 * code is the one the thrower meant us to act on.
 */
export function errorSqlstate(error: unknown): string | null {
  return walk(
    error,
    (node) => {
      const code = (node as { code?: unknown }).code;
      return typeof code === 'string' && code.length > 0 ? code : null;
    },
    'first',
  );
}

/**
 * Complement to a consistent lock order (never a substitute): a deadlock victim (40P01) rolled back
 * whole, so re-running the idempotent transaction is safe. Two retries, short
 * jittered backoff; any other error, or the third deadlock, propagates.
 */
export async function retryOnDeadlock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= 3 || errorSqlstate(err) !== '40P01') throw err;
      await Bun.sleep(50 * attempt + Math.random() * 50);
    }
  }
}

/**
 * Deepest `message` on the chain. Drizzle wraps the driver error, and it is the
 * driver's message ("canceling statement due to statement timeout") that names
 * the fault.
 */
export function innermostMessage(error: unknown): string | null {
  return walk(
    error,
    (node) => {
      const message = (node as { message?: unknown }).message;
      return typeof message === 'string' && message.length > 0 ? message : null;
    },
    'last',
  );
}

/**
 * Walk `.cause`, returning either the first or the last non-null `pick`.
 *
 * Bounded and cycle-safe. These run on an error path, where a hang is the worst
 * possible outcome — worse than a missing detail — so the walk refuses to
 * revisit a node and gives up after 16 links.
 */
function walk(
  error: unknown,
  pick: (node: object) => string | null,
  take: 'first' | 'last',
): string | null {
  let current = error;
  let found: string | null = null;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && current != null; depth++) {
    if (typeof current !== 'object') break;
    if (seen.has(current)) break;
    seen.add(current);
    const value = pick(current);
    if (value !== null) {
      if (take === 'first') return value;
      found = value;
    }
    const cause = (current as { cause?: unknown }).cause;
    if (cause == null) break;
    current = cause;
  }
  return found;
}

/**
 * PostgreSQL SQLSTATEs that mean "another writer holds what this one needs",
 * not "this write is wrong".
 *
 * Until 2026-10 `audit_prepare_event` serialized every row of a session behind
 * one `audit_session_sequences` row lock held to COMMIT; the lock is gone, but a
 * slow INSERT on the audit pool still surfaces as 57014 (statement_timeout, the
 * SampleCo signature: 445 x 500 in 3h, each at ~10s) or 55P03 at the pool's
 * `lock_timeout`, e.g. behind DDL. Callers must report
 * these as retryable backpressure, never as a 500 or a silent drop: a 500
 * makes the sandbox relay retry a batch that has already been rejected, and a
 * drop just loses the events (prod, 2026-09-24 through 2026-09-27: hundreds of
 * "[audit] Dropped a batch" per hour, 100% sqlstate=55P03).
 *
 * Lives here, not in `audit-db.ts`: that module `import`s `./db`, which builds
 * a real connection pool at module scope, so anything that imports it can no
 * longer be database-free. `audit-queue.ts`'s flush path must stay
 * database-free (its own tests mock `@kortix/db` without a live pool), so the
 * classifier — like `errorSqlstate` above — lives in this leaf and is
 * re-exported from `audit-db.ts` for its existing callers.
 */
const AUDIT_CONTENTION_SQLSTATES = new Set([
  '57014', // query_canceled — statement_timeout fired while queued on a lock
  '55P03', // lock_not_available — lock_timeout fired
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  // ── The database went away, which is also not "this write is wrong". ──
  //
  // A restart, failover or connection recycle is the single largest source of
  // audit write failures in production: `PostgresError: the database system is
  // shutting down`, 21,102 exceptions across 244 users since 2026-07-04, of
  // which 19,193 landed on ONE day (2026-08-14) and 142 in a 90-second window
  // on 2026-09-09. Each one threw, answered 500, and dropped the batch — and a
  // 500 is precisely what makes the sandbox relay re-send a batch on its flat
  // retry, which is how the convoy re-forms after every restart.
  //
  // Retrying is the correct client behaviour for all of these: the batch is
  // still in the relay's spool and the database is coming back. Answering 503
  // with `Retry-After` says exactly that. Only errors that describe the DATA
  // (a constraint, a bad value, a type) stay 500 — those must keep paging,
  // because retrying them can never work.
  '57P01', // admin_shutdown — "terminating connection due to administrator command"
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — "the database system is shutting down/starting up"
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure — includes CONNECTION_CLOSED / ECONNREFUSED
  '53300', // too_many_connections
]);

/**
 * Connection-class failures do not always carry a SQLSTATE.
 *
 * `postgres.js` raises `CONNECTION_CLOSED` / `CONNECTION_ENDED` and Node raises
 * `ECONNREFUSED` / `ECONNRESET` as `code` values that are not SQLSTATEs at all,
 * and prod carries all of them (`connect ECONNREFUSED 3.11.30.79:5432`, `write
 * CONNECTION_CLOSED db.…supabase.co:5432`). They mean the same thing as 08006
 * and must be retryable for the same reason.
 */
const AUDIT_TRANSIENT_DRIVER_CODES = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'CONNECTION_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

/**
 * True when a failed audit write is backpressure (retry it) rather than a
 * defect (dead-letter it). Mirrors `errorSqlstate`'s cause-walk but checks
 * EVERY node's own code against the contention sets, not only the first code
 * found on the chain — a synthetic wrapper code that itself isn't in either
 * set must not shadow a genuinely contended cause underneath it.
 */
export function isAuditContentionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (AUDIT_CONTENTION_SQLSTATES.has(code)) return true;
    if (AUDIT_TRANSIENT_DRIVER_CODES.has(code)) return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause != null && cause !== error ? isAuditContentionError(cause) : false;
}

/**
 * Rate-limit marked dead-credential warnings by method, normalized route,
 * status and reason. Responses and emitted message text stay unchanged.
 * A ten-minute window permits six lines per route/reason per process per hour.
 * Suppression counts are best-effort: they appear only on the next warning.
 * A final quiet burst, eviction or process restart can lose pending counts;
 * use request-completion logs or auth audits for exact refusal accounting.
 */
import type { HTTPException } from 'hono/http-exception';

const WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_MESSAGES = 10_000;

const UUID_PATTERN = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi;

/**
 * The throttle bucket key for a dead-credential refusal: method, route,
 * status and a reason with every token id normalized OUT. KRTX-1564 named the
 * dead row in the refusal (`project token <id> is revoked`); keyed verbatim,
 * every revoked token would open its own bucket and the per-route/reason
 * window this limiter exists for (the KRTX-1039 warn spike) would shard into
 * one-bucket-per-token noise. The printed LINE keeps the id — only the bucket
 * key hides it.
 */
export function deadCredentialLogKey(method: string, path: string, status: number, reason: string): string {
  return `${method} ${path} ${status} ${reason}`.replace(UUID_PATTERN, ':id');
}

const deadCredentials = new WeakSet<HTTPException>();

type Window = { loggedAt: number; suppressed: number };
// replica-local: a log-noise limiter; each replica rate-limits its own lines.
const windows = new Map<string, Window>();

/** Mark an exception as a dead-credential refusal. Called by the one
 *  constructor that builds the typed dead-credential 401. */
export function markDeadCredential(err: HTTPException): void {
  deadCredentials.add(err);
}

/** True for an exception `markDeadCredential` marked. */
export function isDeadCredential(err: HTTPException): boolean {
  return deadCredentials.has(err);
}

/** First warning logs immediately; the next window reports pending suppression. */
export function deadCredentialLogDecision(key: string, now: number): { log: boolean; suppressed: number } {
  const window = windows.get(key);
  if (window && now - window.loggedAt < WINDOW_MS) {
    window.suppressed += 1;
    return { log: false, suppressed: 0 };
  }
  const suppressed = window?.suppressed ?? 0;
  if (!window && windows.size >= MAX_TRACKED_MESSAGES) {
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }
  windows.set(key, { loggedAt: now, suppressed: 0 });
  return { log: true, suppressed };
}

/** Test seam. */
export function resetDeadCredentialLogForTests(): void {
  windows.clear();
}

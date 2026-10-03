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

const deadCredentials = new WeakSet<HTTPException>();

type Window = { loggedAt: number; suppressed: number };
// replica-local: the window map only drives best-effort log suppression. A
// replica cannot see a sibling's counts, so at worst every replica logs the
// first line of a window (3 first lines, never more); responses, the emitted
// message text and exact refusal accounting are unchanged either way, and
// the auth audit stays the source of truth.
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

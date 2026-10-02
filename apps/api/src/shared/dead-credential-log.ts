/**
 * Dead-credential 401s: the log throttle for the refusal the API repeats.
 *
 * `deadCredential401` (middleware/auth.ts) answers a credential the API can
 * never take back — a revoked PAT, an expired one, a session lease that is no
 * longer live — with the typed 401 whose body says `code:
 * session_token_revoked`, so a client that reads its bodies stops. A client
 * that does not (an in-sandbox agent CLI retrying per streamed step, an old
 * image before the daemon's dead-credential breaker) keeps refusals coming
 * forever, and the global error handler logged one `warn` line per refusal:
 * one enterprise workspace's stuck loop produced ~1.19M
 * `-> 401 [HTTPException] PAT not found or revoked` lines in ten days across
 * the sandbox relay routes (KRTX-1039), and the log-anomaly sweep pages on
 * exactly that volume.
 *
 * The response is correct and stays byte-identical. Only the LOG is
 * rate-limited, per the two standing learnings: an alertable line marks the
 * transition into a state, never a repeat of it (2026-09-28), and an
 * expected-backpressure warning is rate-limited to first occurrence + one per
 * interval without losing the accounting (KRTX-614, 2026-09-28). The first
 * refusal always logs; further refusals of the same message inside the window
 * are counted; the next logged line carries the count in a `suppressed` field,
 * so the true volume stays queryable while the line rate stays flat. The
 * message text never changes — a new text starts a fresh Better Stack baseline
 * and reads as a spike even when nothing got worse.
 *
 * Window: the API runs 3–10 prod tasks (infra/terraform/environments/prod),
 * and the map is per process, so the worst-case line rate is 6/h per task at
 * the 10-minute window — ≤ 60 lines/h fleet-wide, below the 79/h baseline the
 * anomaly was filed against at every scale setting.
 */
import type { HTTPException } from 'hono/http-exception';

const WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_MESSAGES = 10_000;

const deadCredentials = new WeakSet<HTTPException>();

type Window = { loggedAt: number; suppressed: number };
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

/**
 * Decide whether this dead-credential denial logs now. `key` is the log
 * message the handler is about to emit (method + path + status + reason) —
 * the same string Better Stack groups on.
 *
 * First refusal of a message: `{ log: true, suppressed: 0 }`. Refusals inside
 * the window: `{ log: false }`, counted. The refusal that reopens the window
 * logs with the count the previous window suppressed. A count belongs to its
 * own window: silence longer than the window does not carry old volume
 * forward.
 */
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

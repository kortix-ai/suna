/**
 * Rate-limit marked dead-credential warnings by method, normalized route,
 * status and reason. Responses and emitted message text stay unchanged.
 * A ten-minute window permits six lines per route/reason per process per hour.
 * Suppression counts are best-effort: they appear only on the next warning.
 * A final quiet burst, eviction or process restart can lose pending counts;
 * use request-completion logs or auth audits for exact refusal accounting.
 */
import { HTTPException } from 'hono/http-exception';

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

/** Mark an exception as a dead-credential refusal. Called by
 *  `deadCredential401`, the one constructor every gate that refuses a
 *  credential that cannot come back throws — PAT/secret-key auth and the
 *  per-account session gate alike. */
export function markDeadCredential(err: HTTPException): void {
  deadCredentials.add(err);
}

/**
 * Stable error code a gate's 401 carries when the presented credential can
 * never come back: missing, revoked, expired, its sandbox lease closed, or
 * the session the per-account session policy revoked. The body keeps the
 * global `{error, message, status}` shape and adds this `code`, so a
 * retrying client can branch on it and stop instead of hammering the gate
 * forever — prod 2026-09-26/27: one fleet of boxes that outlived their
 * session credential produced ~10k 401s/h across
 * `/v1/platform/runtime-projection`, `/turn-stream` and `/audit/events`,
 * every one a plain untyped 401 no client could tell apart from a transient
 * one. Mirrors the typed-error pattern of `buildDenialError`
 * (`code:'account_mfa_required'`) and `impersonation.ts`
 * (`code:'impersonation_invalid'`): an HTTPException built with an explicit
 * `res` is returned verbatim by the global error handler
 * (apps/api/src/index.ts), so the body arrives untyped nowhere.
 * Consumers: apps/kortix-sandbox-agent-server's `session-token-health.ts`
 * breaker classifies the body; the SDK's ApiError lifts `code` from error
 * bodies. Keep the string in sync with that breaker.
 */
export const SESSION_TOKEN_REVOKED_CODE = 'session_token_revoked';

/**
 * Build the typed dead-credential 401: a credential that can never come
 * back. The gates that refuse one (PAT/secret-key auth, the per-account
 * session gate) call this so the body carries
 * `code: 'session_token_revoked'` and the global error handler
 * rate-limits the warn line. Every consumer keeps its own refusal message;
 * the code is the shared contract.
 */
export function deadCredential401(message: string): HTTPException {
  const err = new HTTPException(401, {
    message,
    res: new Response(
      JSON.stringify({ error: true, message, status: 401, code: SESSION_TOKEN_REVOKED_CODE }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
  });
  // The body above already tells a reading client to stop. One that does not
  // (an in-sandbox agent CLI retrying per step) would otherwise put one warn
  // line per refusal into the API log — the KRTX-1039 spike. The mark routes
  // this exception through the global error handler's log throttle without
  // touching the response.
  markDeadCredential(err);
  return err;
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

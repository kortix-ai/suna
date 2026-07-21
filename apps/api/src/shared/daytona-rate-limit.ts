/**
 * Daytona provider rate-limit classification.
 *
 * Daytona's SDK turns any HTTP 429 from the Daytona API into a typed
 * `DaytonaRateLimitError` (a subclass of `DaytonaError`, which extends
 * `Error`). The org-wide throttler surfaces this as
 * `DaytonaRateLimitError: ThrottlerException: Too Many Requests`.
 *
 * An EXPECTED, transient provider 429 is NOT a 500-worthy crash — it is the
 * provider working as designed, and every call site that hits Daytona (preview
 * link resolution, transcript / public-share reads, lease discover, reaper
 * health, env-sync fan-out, snapshot reconciliation, …) must NOT page Sentry
 * for it. Prior PRs (#3567, #4605) guarded specific call sites one-by-one, but
 * new call sites kept reintroducing the same Better Stack fingerprint
 * (`ec26b248…`) because the 429 still propagated to `app.onError` →
 * `captureException` → Sentry → Better Stack whenever a caller forgot the
 * try/catch.
 *
 * This module gives `app.onError` a single, robust classifier that recognizes
 * a Daytona 429 / `ThrottlerException` rate limit (no matter which call site
 * threw it) so it can be downgraded to a retryable 503 + `Retry-After` WITHOUT
 * paging Sentry — mirroring the established `PlatinumSandboxNotRunningError`,
 * `GitOperationError:timeout`, and `RequestDeadlineHTTPException` patterns.
 * Every OTHER Daytona failure (404 missing box, 409 conflict, 5xx outage,
 * timeout, connection error, disk quota) still throws a generic error and
 * falls through to the generic capture below, so unexpected failures stay loud.
 *
 * The classifier is deliberately conservative — it only matches errors that
 * are clearly the Daytona org-wide throttler, never a generic HTTP 429 from an
 * unrelated upstream. It checks, in order:
 *   1. `instanceof DaytonaRateLimitError` (best — exact SDK class),
 *   2. the error's `name === 'DaytonaRateLimitError'` (robust across the
 *      SDK being imported twice / a different SDK version, since the class is
 *      not unique per module instance),
 *   3. a `DaytonaError`-shaped error (`statusCode === 429` + a Daytona-typed
 *      `errorCode` / `ThrottlerException` message) — catches a raw axios 429
 *      that escaped the SDK's own wrapper.
 */

// Imported lazily so a missing / broken SDK install never breaks the classifier
// (the classifier is on the global error path — it must always load). The
// import is best-effort: instanceof is the strongest signal but the
// name / statusCode / message fallbacks below cover every other shape too.
type DaytonaRateLimitErrorCtor = abstract new (...args: unknown[]) => Error;
let DaytonaRateLimitErrorClass: DaytonaRateLimitErrorCtor | null | undefined;
async function loadDaytonaRateLimitErrorClass(): Promise<DaytonaRateLimitErrorCtor | null> {
  if (DaytonaRateLimitErrorClass !== undefined) return DaytonaRateLimitErrorClass;
  try {
    const mod = (await import('@daytonaio/sdk')) as {
      DaytonaRateLimitError?: DaytonaRateLimitErrorCtor;
    };
    DaytonaRateLimitErrorClass = mod.DaytonaRateLimitError ?? null;
  } catch {
    DaytonaRateLimitErrorClass = null;
  }
  return DaytonaRateLimitErrorClass;
}

/**
 * True when `err` is a Daytona org-wide throttler 429
 * (`DaytonaRateLimitError: ThrottlerException: Too Many Requests`).
 *
 * Pure / synchronous so `app.onError` can call it on the hot path without
 * awaiting an import. The instanceof path is only available once the SDK
 * module has been loaded elsewhere in the process (it always is in prod, since
 * `getDaytona()` runs at provisioning time); the name / statusCode / message
 * fallbacks cover the first-thrown-before-import case and any module-duplication
 * edge case.
 */
export function isDaytonaRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // 1. Exact SDK class (the common case — SDK is loaded by the time any
  //    Daytona call throws). Per-instance unique, so no module-duplication gap.
  const cls = DaytonaRateLimitErrorClass;
  if (cls && err instanceof cls) return true;

  // 2. Error name (the SDK sets `this.name = new.target.name`, so a
  //    `DaytonaRateLimitError` always has `name === 'DaytonaRateLimitError'`,
  //    even if the class identity differs across module copies).
  if (err.name === 'DaytonaRateLimitError') return true;

  // 3. DaytonaError-shaped 429 with the throttler signal. `statusCode === 429`
  //    alone is too broad (a non-Daytona upstream could 429), so require the
  //    Daytona-specific `errorCode` OR the `ThrottlerException` message
  //    substring that Daytona's own throttler returns.
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  const errorCode = (err as { errorCode?: unknown }).errorCode;
  const message = err.message ?? '';
  if (statusCode === 429) {
    if (typeof errorCode === 'string' && errorCode.toLowerCase().includes('throttle')) {
      return true;
    }
    if (typeof message === 'string' && message.includes('ThrottlerException')) {
      return true;
    }
  }

  // 4. The exact Better Stack fingerprint message (`DaytonaRateLimitError:
  //    ThrottlerException: Too Many Requests`) — covers a re-thrown / wrapped
  //    error that lost its `statusCode`/`errorCode` but kept the message. JS's
  //    default Error.toString() prepends the class name, which is exactly the
  //    shape Better Stack records.
  if (
    typeof message === 'string' &&
    message.includes('DaytonaRateLimitError') &&
    message.includes('ThrottlerException')
  ) {
    return true;
  }

  return false;
}

/**
 * Pre-load the SDK's `DaytonaRateLimitError` class so the synchronous
 * `isDaytonaRateLimitError` instanceof path is available. Called once during
 * app bootstrap (after the SDK is otherwise initialized). Safe to call
 * multiple times; never throws.
 */
export async function primeDaytonaRateLimitClassifier(): Promise<void> {
  await loadDaytonaRateLimitErrorClass();
}

/**
 * Daytona provider transient-gateway classification.
 *
 * The Daytona SDK turns any non-2xx response from the Daytona API into a
 * subclass of `DaytonaError` via `createAxiosDaytonaError` →
 * `createDaytonaError`. Only a handful of status codes get their own typed
 * subclass (400/401/403/404/409/429); every OTHER status code — including
 * 502 / 503 / 504 from the Daytona API's gateway — becomes a GENERIC
 * `DaytonaError` whose `message` is the raw upstream response body. When the
 * Daytona API is behind an nginx/Cloudflare-style gateway that 502s with an
 * HTML error page, that HTML body becomes the error message verbatim — which
 * is exactly what surfaced as the recurring Better Stack pattern
 * `e98d61f1…` (`DaytonaError` with message `<html>…<h1>502 Bad
 * Gateway</h1>…</html>`).
 *
 * A transient provider gateway blip (502/503/504, connection reset, timeout,
 * DNS) is EXPECTED — it is the upstream provider momentarily unavailable, not
 * a Kortix code bug — and every call site that hits Daytona (preview-link
 * resolution, transcript / public-share reads, lease discover, reaper health,
 * env-sync fan-out, snapshot reconciliation, …) must NOT page Sentry for it.
 * The 429 throttler case is owned by `shared/daytona-rate-limit.ts`
 * (PR #5167 — `isDaytonaRateLimitError`). This module is the sibling
 * classifier for the OTHER transient Daytona failure classes:
 *   - HTTP 502 / 503 / 504 from the Daytona API gateway (HTML body or JSON),
 *   - `DaytonaConnectionError` (network-level failure — `ECONNRESET`,
 *     `ETIMEDOUT`, socket hang up, idle connection dropped, …),
 *   - `DaytonaTimeoutError` (the SDK's own bounded-call timeout).
 *
 * `app.onError` calls `isDaytonaTransientProviderError` AFTER
 * `isDaytonaRateLimitError` so the 429 path stays specific (the throttler
 * has its own Retry-After semantics) and every other transient provider
 * failure class is downgraded to a retryable 503 + `Retry-After` WITHOUT
 * paging Sentry — mirroring the established
 * `PlatinumSandboxNotRunningError`, `GitOperationError:timeout`, and
 * `RequestDeadlineHTTPException` patterns. Non-transient Daytona failures
 * (404 missing box, 409 conflict, 401/403 auth, 400 validation, disk quota,
 * unexpected 5xx with a JSON body, …) still throw a generic error and fall
 * through to the generic capture below, so unexpected failures stay loud.
 *
 * The classifier is deliberately conservative — it only matches errors that
 * are clearly a transient Daytona provider gateway / connection / timeout
 * failure, never a generic HTTP 502 from an unrelated upstream (LLM gateway,
 * GitHub, Stripe, …). It checks, in order:
 *   1. `instanceof DaytonaTimeoutError` / `instanceof DaytonaConnectionError`
 *      (best — exact SDK class),
 *   2. the error's `name === 'DaytonaTimeoutError'` /
 *      `'DaytonaConnectionError'` (robust across module duplication / a
 *      different SDK version),
 *   3. a `DaytonaError`-shaped error whose `statusCode` is 502/503/504 (the
 *      generic-class case from `createDaytonaError` — covers the prod
 *      `e98d61f1…` 502-HTML-body fingerprint),
 *   4. the Daytona-typed message substrings the SDK uses for connection /
 *      timeout failures (`socket hang up`, `ECONNRESET`, `Operation timed
 *      out`, …) when the SDK failed to construct a typed subclass.
 */

// Imported lazily so a missing / broken SDK install never breaks the classifier
// (the classifier is on the global error path — it must always load). The
// import is best-effort: instanceof is the strongest signal but the
// name / statusCode / message fallbacks below cover every other shape too.
type DaytonaErrorCtor = abstract new (...args: unknown[]) => Error;
type LoadedDaytonaClasses = {
  DaytonaTimeoutError: DaytonaErrorCtor | null;
  DaytonaConnectionError: DaytonaErrorCtor | null;
};
let loadedClasses: LoadedDaytonaClasses | undefined;

async function loadDaytonaTransientClasses(): Promise<LoadedDaytonaClasses> {
  if (loadedClasses !== undefined) return loadedClasses;
  try {
    const mod = (await import('@daytonaio/sdk')) as {
      DaytonaTimeoutError?: DaytonaErrorCtor;
      DaytonaConnectionError?: DaytonaErrorCtor;
    };
    loadedClasses = {
      DaytonaTimeoutError: mod.DaytonaTimeoutError ?? null,
      DaytonaConnectionError: mod.DaytonaConnectionError ?? null,
    };
  } catch {
    loadedClasses = { DaytonaTimeoutError: null, DaytonaConnectionError: null };
  }
  return loadedClasses;
}

const TRANSIENT_GATEWAY_STATUS_CODES = new Set<number>([502, 503, 504]);

// Message substrings the Daytona SDK (and the underlying axios / node fetch)
// uses for connection / timeout failures. Matched case-insensitively. These
// are the same substrings `apps/api/src/snapshots/providers/daytona.ts`'s own
// `isTransientDaytonaError` already treats as retryable on the snapshot
// build path — kept in sync so the global classifier agrees with the
// per-call-site retry loop.
const TRANSIENT_MESSAGE_SUBSTRINGS = [
  'socket connection',
  'idle connection',
  'not read from or written to',
  'socket hang up',
  'econnreset',
  'econnrefused',
  'etimedout',
  'operation timed out',
  'timeout',
  'timed out',
  'network error',
  'gateway',
  'bad gateway',
];

function matchesTransientMessage(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return TRANSIENT_MESSAGE_SUBSTRINGS.some((substr) => lower.includes(substr));
}

/**
 * True when `err` is a transient Daytona provider gateway / connection /
 * timeout failure (502 / 503 / 504 HTML or JSON body, `DaytonaConnectionError`,
 * `DaytonaTimeoutError`, or the SDK's connection/timeout message
 * substrings). The 429 throttler case is owned by
 * `isDaytonaRateLimitError` (shared/daytona-rate-limit.ts) and is NOT matched
 * here — this classifier is specifically the sibling for transient gateway
 * failures.
 *
 * Pure / synchronous so `app.onError` can call it on the hot path without
 * awaiting an import. The instanceof path is only available once the SDK
 * module has been loaded elsewhere in the process (it always is in prod, since
 * `getDaytona()` runs at provisioning time); the name / statusCode / message
 * fallbacks cover the first-thrown-before-import case and any
 * module-duplication edge case.
 */
export function isDaytonaTransientProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const cls = loadedClasses;
  // 1. Exact SDK class (the common case — SDK is loaded by the time any
  //    Daytona call throws). Per-instance unique, so no module-duplication gap.
  if (cls) {
    if (cls.DaytonaTimeoutError && err instanceof cls.DaytonaTimeoutError) return true;
    if (cls.DaytonaConnectionError && err instanceof cls.DaytonaConnectionError) return true;
  }

  const name = err.name ?? '';
  const message = err.message ?? '';

  // 2. Error name (the SDK sets `this.name = new.target.name`, so a
  //    `DaytonaTimeoutError` / `DaytonaConnectionError` always has its
  //    respective name, even if the class identity differs across module
  //    copies).
  if (name === 'DaytonaTimeoutError' || name === 'DaytonaConnectionError') return true;

  // 3. DaytonaError-shaped 502/503/504. The SDK's `createDaytonaError` returns
  //    a GENERIC `DaytonaError` for these statuses (only 400/401/403/404/409/
  //    429 get their own subclass), so this is the path the prod
  //    `e98d61f1…` 502-HTML-body fingerprint hits: a generic `DaytonaError`
  //    with `statusCode === 502` and the HTML body as its `message`.
  //
  //    `statusCode === 502/503/504` alone is intentionally NOT enough on a
  //    bare `Error` — a non-Daytona upstream could 502/503/504 — so require
  //    a Daytona-specific signal: the `DaytonaError` class name (set by the
  //    SDK on every typed Daytona error), OR the SDK's own connection /
  //    timeout message substrings.
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (
    typeof statusCode === 'number' &&
    TRANSIENT_GATEWAY_STATUS_CODES.has(statusCode) &&
    (name === 'DaytonaError' || matchesTransientMessage(message))
  ) {
    return true;
  }

  // 4. The SDK's connection / timeout message substrings on a `DaytonaError`-
  //    named error (covers the case where the SDK failed to construct a typed
  //    subclass but still wrapped the underlying network failure into a
  //    generic `DaytonaError`).
  if (name === 'DaytonaError' && matchesTransientMessage(message)) return true;

  return false;
}

/**
 * Pre-load the SDK's `DaytonaTimeoutError` / `DaytonaConnectionError` classes
 * so the synchronous `isDaytonaTransientProviderError` instanceof path is
 * available. Called once during app bootstrap (after the SDK is otherwise
 * initialized). Safe to call multiple times; never throws.
 */
export async function primeDaytonaTransientClassifier(): Promise<void> {
  await loadDaytonaTransientClasses();
}

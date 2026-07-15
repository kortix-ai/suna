/**
 * Sentry error tracking for Kortix API.
 *
 * Uses @sentry/bun SDK pointed at Better Stack's Sentry-compatible ingestion endpoint.
 * Better Stack provides the same Sentry SDK interface at 1/6th the price.
 *
 * Error tracking is separate from structured logging:
 * - Logs (logger.ts) → Better Stack Telemetry (structured events, request logs)
 * - Errors (sentry.ts) → Better Stack Errors (exceptions, stack traces, context)
 */

import * as Sentry from '@sentry/bun';

// ─── Configuration ──────────────────────────────────────────────────────────

const SENTRY_DSN = process.env.BETTERSTACK_API_SENTRY_DSN;
const ENV = process.env.INTERNAL_KORTIX_ENV || 'dev';
const VERSION = process.env.SANDBOX_VERSION || 'dev';

// ─── Noise filter (ignoreErrors) ────────────────────────────────────────────
//
// Patterns Sentry's InboundFilters silently drops (substring match against the
// exception `type`, `value`/message, or event message). Every entry here is a
// transient, non-actionable class — the codebase already handles the user-facing
// consequence (clean 4xx/5xx, retry, refund) and these would otherwise just page
// on upstream/network noise. Declared before Sentry.init() so it can be passed
// to `ignoreErrors`; mirrored by isSentryIgnoredError() for unit tests.

export const SENTRY_IGNORE_ERRORS = [
  // Network/timeout errors from sandbox communication
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  // Bun fetch: upstream socket dropped mid-request/stream. Transient
  // upstream/network noise — the git smart-HTTP proxy retries idempotent
  // ref discovery and returns a clean 502 otherwise (see git-proxy/). Even
  // when one escapes the streamed pack path it is not actionable, so drop
  // it here instead of paging (Better Stack pattern df7a31d4…).
  'The socket connection was closed unexpectedly',
  // Client-side abort
  'AbortError',
  'The operation was aborted',
  // Bun native fetch TimeoutError: thrown by Bun's internal fetch body pump
  // when an upstream stalls mid-response (after headers are already streamed
  // back to the client), e.g. a /v1/router/tavily/search proxy call to the
  // Tavily API. Because the response has already been handed to the client,
  // the rejection fires from Bun's stream pump OUTSIDE the request handler's
  // try/catch and Hono's onError — it surfaces as an unhandled rejection
  // (process.on('unhandledRejection')) with NO JS stack and type
  // `TimeoutError`, so it is impossible to catch/convert at the JS layer.
  // The client already sees a truncated/failed response and the proxy is
  // request-deadline-exempt (/v1/router), so this is pure transient
  // upstream/network noise — drop it instead of paging
  // (Better Stack pattern c672fb5e…).
  'The operation timed out.',
  // Expected HTTP errors (auth failures, not found, etc.)
  'HTTPException',
] as const;

/**
 * Mirrors Sentry's InboundFilters substring semantics for the
 * {@link SENTRY_IGNORE_ERRORS} list: returns true if any pattern is a substring
 * of the error's `type` or `message`. Exported for unit tests so the noise
 * filter's coverage of a given error class is asserted without booting Sentry.
 */
export function isSentryIgnoredError(type: string | undefined, message: string | undefined): boolean {
  const hay = [type, message].filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (hay.length === 0) return false;
  return SENTRY_IGNORE_ERRORS.some((pattern) => hay.some((s) => s.includes(pattern)));
}

// ─── Initialize ─────────────────────────────────────────────────────────────

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: ENV,
    release: `kortix-api@${VERSION}`,

    // Capture 100% of errors, sample 20% of transactions for performance
    tracesSampleRate: ENV === 'prod' ? 0.2 : 1.0,

    // Don't send PII (emails, IPs, etc.) unless explicitly attached
    sendDefaultPii: false,

    // Ignore known non-actionable errors. Exported as SENTRY_IGNORE_ERRORS
    // (above) so the noise filter is unit-tested — see unit-sentry-noise-filter.
    ignoreErrors: [...SENTRY_IGNORE_ERRORS],

    // Filter out high-volume, low-value transactions
    beforeSendTransaction(event) {
      // Don't trace health checks
      if (event.transaction?.includes('/health')) return null;
      // Don't trace CORS preflights
      if (event.contexts?.trace?.op === 'http' && event.request?.method === 'OPTIONS') return null;
      return event;
    },

    // Enrich error events with extra context
    beforeSend(event) {
      // Redact sensitive headers
      if (event.request?.headers) {
        const headers = event.request.headers as Record<string, string>;
        for (const key of ['authorization', 'cookie', 'x-kortix-token', 'x-api-key']) {
          if (headers[key]) {
            headers[key] = '[Filtered]';
          }
        }
      }
      return event;
    },
  });

  console.log(`[sentry] Initialized (env=${ENV}, release=kortix-api@${VERSION})`);
} else {
  console.log('[sentry] Disabled (BETTERSTACK_API_SENTRY_DSN not set)');
}

/**
 * Capture an exception with optional extra context.
 * No-op if Sentry is not configured.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!SENTRY_DSN) return;

  Sentry.withScope((scope) => {
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        scope.setExtra(key, value);
      }
    }
    Sentry.captureException(error);
  });
}

/**
 * Set user context on the current Sentry scope.
 * Call this in auth middleware after resolving the user.
 * Subsequent errors will include this user info.
 */
export function setSentryUser(user: { id: string; email?: string; accountId?: string }): void {
  if (!SENTRY_DSN) return;
  Sentry.setUser({ id: user.id, email: user.email });
  if (user.accountId) {
    Sentry.setTag('accountId', user.accountId);
  }
}

/**
 * Add a breadcrumb for debugging context on future errors.
 */
export function addBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
  category = 'app',
): void {
  if (!SENTRY_DSN) return;
  Sentry.addBreadcrumb({ message, data, category, level: 'info' });
}

/**
 * Flush pending Sentry events. Call before process exit.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!SENTRY_DSN) return;
  await Sentry.flush(timeoutMs);
}

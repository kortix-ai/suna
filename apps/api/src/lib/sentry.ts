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

    // Ignore known non-actionable errors
    ignoreErrors: [
      // Network/timeout errors from sandbox communication
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      // Bun-specific phrasing of ECONNREFUSED — surfaces when a sandbox port proxy
      // hits a dead port (nothing listening on localhost:N). Expected, not actionable.
      'Unable to connect',
      'Is the computer able to access the url',
      // Client-side abort
      'AbortError',
      'The operation was aborted',
      // Expected HTTP errors (auth failures, not found, etc.)
      'HTTPException',
    ],

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

// ─── Re-export for use in error handlers ────────────────────────────────────

export { Sentry };

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
 * Clear user context (e.g., on logout or between requests).
 */
export function clearSentryUser(): void {
  if (!SENTRY_DSN) return;
  Sentry.setUser(null);
}

/**
 * Add a breadcrumb for debugging context on future errors.
 */
export function addBreadcrumb(message: string, data?: Record<string, unknown>, category = 'app'): void {
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

/**
 * Sentry client-side configuration for Kortix Frontend.
 *
 * Uses @sentry/nextjs SDK pointed at Better Stack's Sentry-compatible endpoint.
 * Errors are tunneled through /monitoring route (auto-configured by
 * `tunnelRoute: '/monitoring'` in next.config.ts) to bypass ad-blockers.
 */

import * as Sentry from '@sentry/nextjs';
import { shouldIgnoreSentryNoiseEvent } from '@/lib/browser-error-noise';

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

function isBrowserNoiseEvent(event: Sentry.ErrorEvent): boolean {
  return shouldIgnoreSentryNoiseEvent(event);
}

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_KORTIX_ENV || 'dev',

    // Capture 100% of errors
    // Sample 10% of page loads for performance (keep low on client)
    tracesSampleRate: 0.1,

    // Tunnel is auto-configured by `tunnelRoute: '/monitoring'` in next.config.ts
    // No need to set `tunnel` manually here.

    // Don't send PII
    sendDefaultPii: false,

    // Ignore noisy browser errors
    ignoreErrors: [
      // Browser extensions and ad-blockers
      'ResizeObserver loop',
      'ResizeObserver loop completed with undelivered notifications',
      // Network errors (user went offline)
      'Failed to fetch',
      'NetworkError',
      'Load failed',
      'ChunkLoadError',
      // Next.js navigation errors (expected)
      'NEXT_NOT_FOUND',
      'NEXT_REDIRECT',
      // User-initiated aborts
      'AbortError',
      'The operation was aborted',
      // PostHog retry noise
      'ERR_BLOCKED_BY_CLIENT',
      // External Safari / WebView video probing noise
      'webkitPresentationMode',
      "null is not an object (evaluating 'document.querySelector('video').webkitPresentationMode')",
      // Browser extension/runtime bridge noise
      'Invalid call to runtime.sendMessage(). Tab not found.',
      // Third-party injected scripts / wallet extensions
      'MetaMask extension not found',
      'Looks like your website URL has changed',
      'CookieYes account',
      // Test-only synthetic events
      'E2E FINAL:',
      'E2E test:',
    ],

    // Filter out internal/low-value errors before sending
    beforeSend(event) {
      if (isBrowserNoiseEvent(event)) {
        return null;
      }
      return event;
    },
  });
}

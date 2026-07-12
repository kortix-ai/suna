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
      // Ad-blocker blocked requests
      'ERR_BLOCKED_BY_CLIENT',
      // Transient "session runtime not ready" — `RuntimeNotReadyError`
      // (`[opencode-sdk] Server URL not ready — sandbox is still loading`) from
      // `getClient()` for the ~1s window before a session's runtime URL pins.
      // Expected + self-healing on every session switch/provisioning; never an
      // error. `app/error.tsx` already suppresses the render-path case, but the
      // throw can also surface via `<ClientErrorBoundary>`, `route-error`/
      // `system-fault`, the network branch of `error-handler`, and unhandled
      // promise rejections — drop them all here.
      'Server URL not ready',
      'sandbox is still loading',
      'opencode not ready',
      // External Safari / WebView video probing noise
      'webkitPresentationMode',
      "null is not an object (evaluating 'document.querySelector('video').webkitPresentationMode')",
      // Browser extension/runtime bridge noise
      'Invalid call to runtime.sendMessage(). Tab not found.',
      // Third-party injected scripts / wallet extensions
      'MetaMask extension not found',
      'Looks like your website URL has changed',
      'CookieYes account',
      // Browser-native <img> / next/image load failures (broken/expired URLs,
      // ad-blockers, offline, CSP). Never thrown by our code; image components
      // already degrade gracefully via onError handlers. See browser-error-noise.ts.
      'Failed to load image',
      // Injected scripts / extensions / scanner bots monkey-patching the native
      // (read-only) Promise prototype, e.g. `promise.then = ...`. Always external.
      "Cannot assign to read only property 'then' of object '#<Promise>'",
      'Cannot assign to read only property',
      // Test-only synthetic events
      'E2E FINAL:',
      'E2E test:',
    ],

    // Opaque third-party vendor scripts outside our build pipeline — their
    // parse-time SyntaxErrors in old browsers are unfixable from here.
    denyUrls: [
      /^https:\/\/d2mvefebd70kbz\.cloudfront\.net\//,
      /^https:\/\/www\.googletagmanager\.com\//,
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

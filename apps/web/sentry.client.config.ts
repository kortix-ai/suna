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
      // Expected billing-gate HTTP 402 outcomes (insufficient credits / no
      // account / subscription required — the exact strings emitted by
      // `apps/api/src/billing/services/billing-gate.ts:assertBillingActive`).
      // They are user-facing business states handled by a top-up toast / upgrade
      // dialog (`error-handler.tsx`), but the SDK's `ApiError` can leak to
      // Sentry through capture paths that bypass `handleApiError`'s 402 guard
      // (route/system-fault boundaries, `<ClientErrorBoundary>`, and the Sentry
      // SDK's own `onunhandledrejection`). Drop them at the SDK level too so an
      // expected billing state never pages Better Stack. Real `ApiError`s keep
      // reporting — these regexes are exact after optional canonical wrappers.
      /^(?:Unhandled promise rejection: )?(?:ApiError: )?Out of credits\. Top up to continue\.$/,
      /^(?:Unhandled promise rejection: )?(?:ApiError: )?No credit account found\. Complete account setup first\.$/,
      /^(?:Unhandled promise rejection: )?(?:ApiError: )?Subscribe to activate your seat\. \$20\/teammate per month includes wallet credits for compute and LLM usage\.$/,
      // External Safari / WebView video probing noise
      'webkitPresentationMode',
      "null is not an object (evaluating 'document.querySelector('video').webkitPresentationMode')",
      // Browser extension/runtime bridge noise
      'Invalid call to runtime.sendMessage(). Tab not found.',
      // Third-party injected scripts / wallet extensions
      'MetaMask extension not found',
      'Looks like your website URL has changed',
      'CookieYes account',
      // Browser-native <img> / next/image load failures. Anchor this so real
      // viewer errors such as "Failed to load image for duotone processing"
      // remain reportable. See browser-error-noise.ts.
      /^(?:Error: )?Failed to load image$/,
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

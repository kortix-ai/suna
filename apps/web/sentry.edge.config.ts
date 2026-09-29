/**
 * Sentry edge runtime configuration for Kortix Frontend (middleware, edge API routes).
 *
 * Uses @sentry/nextjs SDK pointed at Better Stack's Sentry-compatible endpoint.
 */

import * as Sentry from '@sentry/nextjs';
import { shouldIgnoreSentryNoiseEvent } from '@/lib/browser-error-noise';

const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_KORTIX_ENV || 'dev',

    // Sample 10% of edge transactions
    tracesSampleRate: 0.1,

    beforeSend(event, hint) {
      // The digest (e.g. the 404 `NEXT_HTTP_ERROR_FALLBACK;404` behind a React
      // #419 boundary bailout) lives on the thrown object, never in the
      // serialized event — without the hint the digest-based noise rules
      // (`next-recovery-bailout`) can never match here. Same wiring as the
      // client and server configs.
      if (shouldIgnoreSentryNoiseEvent(event, hint)) {
        return null;
      }
      return event;
    },
  });
}

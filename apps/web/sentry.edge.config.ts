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

    beforeSend(event) {
      if (shouldIgnoreSentryNoiseEvent(event)) {
        return null;
      }
      return event;
    },
  });
}

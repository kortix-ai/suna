/**
 * Sentry server-side configuration for Kortix Frontend (Next.js server components, API routes).
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

    // Sample 20% of server transactions for performance monitoring
    tracesSampleRate: 0.2,

    // Don't send PII
    sendDefaultPii: false,

    beforeSend(event) {
      if (shouldIgnoreSentryNoiseEvent(event)) {
        return null;
      }
      return event;
    },
  });
}

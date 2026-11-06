/**
 * Sentry server-side configuration for Kortix Frontend (Next.js server components, API routes).
 *
 * Uses @sentry/nextjs SDK pointed at Better Stack's Sentry-compatible endpoint.
 */

import * as Sentry from '@sentry/nextjs';
import { SENTRY_DSN, sentryOptions } from './sentry.options';

if (SENTRY_DSN) {
  Sentry.init(
    sentryOptions({
      // Sample 20% of server transactions for performance monitoring
      tracesSampleRate: 0.2,
    }),
  );
}

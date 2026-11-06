/**
 * Sentry edge runtime configuration for Kortix Frontend (middleware, edge API routes).
 *
 * Uses @sentry/nextjs SDK pointed at Better Stack's Sentry-compatible endpoint.
 */

import * as Sentry from '@sentry/nextjs';
import { SENTRY_DSN, sentryOptions } from './sentry.options';

if (SENTRY_DSN) {
  Sentry.init(
    sentryOptions({
      // Sample 10% of edge transactions
      tracesSampleRate: 0.1,
    }),
  );
}

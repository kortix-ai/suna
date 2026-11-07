/**
 * Shared Sentry.init options for the Kortix web runtimes (client, server, edge).
 *
 * Each runtime config passes only what differs — its tracesSampleRate, and (on
 * the client) ignoreErrors/denyUrls. The DSN, environment, the `sendDefaultPii:
 * false` guard and the noise filter are identical across every runtime, so they
 * live here once instead of being copied into each config (where the edge copy
 * had already lost `sendDefaultPii: false`).
 */

import { shouldIgnoreSentryNoiseEvent } from '@kortix/ui/internal/lib/browser-error-noise';
import * as Sentry from '@sentry/nextjs';

export const SENTRY_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

type SentryInitOptions = Parameters<typeof Sentry.init>[0];

export function sentryOptions({
  tracesSampleRate,
  ignoreErrors,
  denyUrls,
}: {
  tracesSampleRate: number;
  ignoreErrors?: (string | RegExp)[];
  denyUrls?: (string | RegExp)[];
}): SentryInitOptions {
  return {
    dsn: SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_KORTIX_ENV || 'dev',
    tracesSampleRate,

    // Don't send PII
    sendDefaultPii: false,

    ignoreErrors,
    denyUrls,

    // Filter out internal/low-value errors before sending
    beforeSend(event, hint) {
      if (shouldIgnoreSentryNoiseEvent(event, hint)) {
        return null;
      }
      return event;
    },
  };
}

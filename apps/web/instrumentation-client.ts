import './sentry.client.config';
import * as Sentry from '@sentry/nextjs';
import posthog from 'posthog-js';
import { getEnv } from '@/lib/env-config';
import { captureAllowedNow } from '@/lib/analytics/posthog-consent';
import { posthogApiHost, posthogHosts } from './scripts/posthog-hosts.mjs';

// Instrument client-side navigations for performance tracing
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

// ─── PostHog (product analytics) ────────────────────────────────────────────
// Key + host come from the RUNTIME config (window.__KORTIX_RUNTIME_CONFIG), so
// an image built with placeholder env still reports to the right project. The
// /ingest proxy target is fixed at build (next.config.ts rewrites).
try {
  const { POSTHOG_KEY, POSTHOG_HOST } = getEnv();
  if (POSTHOG_KEY) {
    posthog.init(POSTHOG_KEY, {
      api_host: posthogApiHost(POSTHOG_HOST, process.env.NEXT_PUBLIC_POSTHOG_HOST),
      ui_host: posthogHosts(POSTHOG_HOST).ui,
      defaults: '2026-05-30', // history-change pageviews + pageleave
      autocapture: false, // the DOM carries file names and code; only typed events (lib/track.ts)
      capture_exceptions: false, // Sentry → Better Stack owns errors
      person_profiles: 'identified_only',
      persistence: 'localStorage', // no cookie, keeps request headers small
      // Consent, decided synchronously so the first pageview is not lost:
      // anonymous visitors need CookieYes "analytics" consent, an explicit
      // rejection wins even when signed in, signed-in users are captured
      // otherwise. posthog-identify.tsx re-decides on consent and auth changes.
      opt_out_capturing_by_default: !captureAllowedNow(document.cookie),
      // Session replay is FAIL-CLOSED: never auto-start. posthog-identify.tsx
      // starts the recorder only on routes lib/analytics/posthog-replay.ts
      // allows — never the workspace, public shares or the admin console, which
      // render customer content and mutate the DOM on every streamed token.
      disable_session_recording: true,
      // Masked even on the allowed routes: a replay shows layout, clicks and the
      // drop-off point, never text or typed values. Sampling and minimum
      // duration stay in the PostHog project settings so they are tunable
      // without a deploy (client `sampleRate` would override remote config).
      session_recording: { maskAllInputs: true, maskTextSelector: '*' },
    });
  }
} catch {
  // Telemetry must never take the app down with it.
}

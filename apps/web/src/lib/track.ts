/**
 * Product events from the web app. One typed funnel into PostHog — never a
 * bare `posthog.capture` at a call site — so event names stay a closed set and
 * the no-customer-data rule has one enforcement point: kinds, counts, sources
 * and our own route names only. File names, paths, URLs, titles, prompts and
 * anything a customer typed never go in properties.
 *
 * Business events that must not be lost to an ad blocker (account created,
 * project created, session created, message sent, checkout started, paid) are captured by the
 * API with the same distinct id (the Supabase user id). See
 * apps/api/src/shared/product-analytics.ts.
 */

import { getPostHog } from '@/lib/analytics/posthog-client';

/** Session panel and conversation UI, reported by `@kortix/ui` through setUiTelemetry. */
export const PANEL_EVENTS = [
  'panel_opened',
  'ready_chip_shown',
  'ready_chip_clicked',
  'deliverable_opened',
  'deliverable_downloaded',
  'deliverable_link_copied',
  'app_send_to_agent_clicked',
  'present_opened',
  'app_opened_new_tab',
  'image_copied',
  'panel_mode_switched',
  'conversation_density_switched',
  'genui_block',
] as const;

/** Acquisition journey in the browser: marketing CTA → auth. Checkout and payment are API events. */
export const JOURNEY_EVENTS = [
  /** A sign-up call to action on a marketing page. `location`: page path. */
  'cta_signup_clicked',
  /** The browser landed after a finished sign-up or sign-in. `kind`, `method`. */
  'auth_completed',
] as const;

export type PanelEvent = (typeof PANEL_EVENTS)[number];
export type JourneyEvent = (typeof JOURNEY_EVENTS)[number];
export type AnalyticsEvent = PanelEvent | JourneyEvent;

export function track(
  event: AnalyticsEvent,
  properties?: Record<string, string | number | boolean>,
): void {
  if (typeof window === 'undefined') return;
  getPostHog()
    .then((posthog) => posthog?.capture(event, properties))
    .catch(() => {
      // Telemetry must never take a feature down with it.
    });
}

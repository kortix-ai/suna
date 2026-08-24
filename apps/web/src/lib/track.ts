/**
 * Panel telemetry (W5). One typed funnel into posthog — never a bare
 * `posthog.capture` at a call site, so the event names stay a closed set and
 * the no-PII rule has one enforcement point: kinds, counts, and sources only.
 * File names, paths, URLs, and titles must never appear in properties.
 */

import posthog from 'posthog-js';

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
] as const;

export type PanelEvent = (typeof PANEL_EVENTS)[number];

export function track(
  event: PanelEvent,
  properties?: Record<string, string | number | boolean>,
): void {
  if (typeof window === 'undefined') return;
  try {
    posthog.capture(event, properties);
  } catch {
    // Telemetry must never take a feature down with it.
  }
}

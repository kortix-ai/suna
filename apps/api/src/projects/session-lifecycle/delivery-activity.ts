import type { SessionDeliveryOutcome } from './types';

/**
 * Did this delivery outcome mean a real turn was accepted for the session?
 *
 * Only `delivered` did. Everything else is either still in flight (`pending`),
 * never reached the runtime (`unreachable`, `no-session`, `failed`), or was
 * accepted and then never written (`not-landed`) — and stamping that last one
 * would raise a session up the sidebar for a turn the user never sees.
 *
 * Pure, so the rule is a test rather than a habit. See
 * `projects/session-activity.ts` for what the stamp is and why it exists.
 */
export function deliveryCountsAsActivity(outcome: SessionDeliveryOutcome): boolean {
  return outcome === 'delivered';
}

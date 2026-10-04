import type { SessionStartResult } from '../core/rest/projects-client/session-sandbox';

/**
 * `/start` reasons that describe the API's view of the box, not the box. A
 * probe that timed out through the provider ingress, a provider status call
 * that failed, one unconfirmed `stopped` read: none of them stopped anything.
 */
const TRANSPORT_REASONS: ReadonlySet<string> = new Set([
  'unreachable',
  'runtime_status_unknown',
  'runtime_stop_unconfirmed',
]);

/**
 * The one rule for a live session: once `/start` answered `ready`, only a
 * LIFECYCLE fact takes it out of live — a terminal stage, a sandbox that is no
 * longer active, a different sandbox, or a non-transport `starting` (wake,
 * restore, relaunch). A failed poll (`null`) or a transport `starting` is no
 * new information, so the live answer is kept.
 *
 * Without this, one timed-out keep-alive poll flipped `useSession` out of
 * `switched` mid-turn and closed the live stream (prod 2026-09-29: the agent
 * "went to sleep" mid-answer on a healthy box; a reload showed the full reply).
 * The event stream owns transport recovery; `/start` owns lifecycle.
 */
export function holdLiveStart(
  previous: SessionStartResult | null | undefined,
  next: SessionStartResult | null,
): SessionStartResult | null {
  if (previous?.stage !== 'ready') return next;
  if (!next) return previous;
  if (next.stage !== 'starting') return next;
  if (next.sandbox) {
    if (next.sandbox.sandbox_id !== previous.sandbox?.sandbox_id) return next;
    if (next.sandbox.status !== 'active') return next;
  }
  return TRANSPORT_REASONS.has(next.reason ?? '') ? previous : next;
}

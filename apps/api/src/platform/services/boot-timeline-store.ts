import { providerEvents } from '@kortix/db';
import { db } from '../../shared/db';

export type BootTimelineMark = { label: string; atMs: number };

export type BootTimelineInput = {
  /** Sandbox provider the session booted on ('daytona' | 'platinum' | ...) —
   *  resolved by the caller (routes/boot-timeline.ts) from session_sandboxes,
   *  since the in-guest daemon posting this doesn't know its own provider. */
  provider: string;
  sessionId: string;
  accountId?: string | null;
  timeline: BootTimelineMark[];
};

/**
 * Persists the in-guest boot timeline server-side, closing the asymmetry
 * where the HOST provisioning timeline is durable
 * (kortix.provider_events.marks, written by provider-events.ts's
 * recordProviderEvent for kind 'provision' | 'migrate') but the equally
 * expensive in-guest boot (repo-materialized, opencode-session-created, ...)
 * only ever lived in daemon memory, exposed transiently on
 * `GET /kortix/health`'s `boot_timeline` field until the sandbox recycled.
 *
 * Deliberately reuses `provider_events` (kind: 'boot') instead of a new
 * table: same shape (marks: [{label, atMs}]), same query surface, and `kind`
 * is a free-text column so no migration/enum change is needed to add this
 * value. `totalMs` is the last mark's `atMs` — the timeline is already
 * ms-since-process-start, so the final entry IS the total.
 *
 * Fire-and-forget, same as recordProviderEvent: append-only telemetry must
 * never throw into (or block) the caller's request/response cycle.
 */
export function recordBootTimeline(input: BootTimelineInput): void {
  const totalMs = input.timeline.length > 0 ? input.timeline[input.timeline.length - 1]!.atMs : null;
  void db
    .insert(providerEvents)
    .values({
      provider: input.provider,
      kind: 'boot',
      outcome: 'ok',
      totalMs,
      marks: input.timeline,
      sessionId: input.sessionId,
      accountId: input.accountId ?? null,
    })
    .catch((err) => console.warn('[boot-timeline-store] insert failed (ignored):', err?.message ?? err));
}

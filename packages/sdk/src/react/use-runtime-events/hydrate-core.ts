import type { Event as RuntimeWireEvent } from '../../core/runtime/runtime-types';
import { activeRuntimeAction, runtimeActionPaths, type RuntimePending } from '../../core/session/runtime-actions';
import { pendingEventsOfLogState } from './log-control';
import type { RuntimeEvent } from './types';
import { useSyncStore } from '../../browser/stores/sync-store';
import { logger } from '../../core/http/logger';
import type { SessionStatus } from '../use-runtime-sessions';
import { shouldSkipStatusFill } from './helpers';
import type { useEventStreamRefs } from './use-event-stream-refs';

type HydrationDeps = {
  applySyncEvent: ReturnType<typeof useSyncStore.getState>['applyEvent'];
  reconcileMissingBusySessions: ReturnType<
    typeof useEventStreamRefs
  >['reconcileMissingBusySessions'];
};

/**
 * A status snapshot: the runtime's COMPLETE set of non-idle sessions. It fills each listed
 * session's slot (never over a fresh wire frame) and marks every busy session it leaves out idle.
 */
function applyStatusSnapshot(
  statuses: Record<string, SessionStatus>,
  { applySyncEvent, reconcileMissingBusySessions }: Pick<HydrationDeps, 'applySyncEvent' | 'reconcileMissingBusySessions'>,
): void {
  for (const [sessionID, status] of Object.entries(statuses)) {
    // FILL A GAP, NEVER OVERWRITE. This snapshot describes the moment
    // the request was ISSUED and carries no timestamp of its own, so an
    // unconditional write let a `busy` that was true on the way out
    // clobber an `idle` frame that arrived while it was in flight — and
    // because the object identity changed, the store restamped that
    // stale reading as the freshest observation there is. Stop and the
    // turn shimmer came back on a finished turn, and the hydration runs
    // on every heartbeat-gap rehydrate, so it could land on any turn
    // boundary. While the live stream is delivering (~140ms per frame
    // for a busy session, and this runs on connect) the stream owns this
    // value; the correction for a session that went idle unseen is
    // `reconcileMissingBusySessions` below, which reads ABSENCE from the
    // complete list rather than a per-session reading.
    //
    // Only a FRESH wire frame owns the slot (`shouldSkipStatusFill`).
    // A `'local'` value is the tab's own fabrication (the missing-busy
    // sweep, a synthetic abort) and never blocks — letting it block
    // made a fabrication self-sustaining. A STALE wire frame no longer
    // blocks either: this fill runs on reconnect, a reconnect happens
    // because a stream died, and a dead stream's last frame — a wire
    // idle vetoing the open `/turn` row while a long tool call moves
    // no transcript — is exactly what this read exists to correct
    // (prod, 2026-08-26).
    const slotState = useSyncStore.getState();
    if (
      shouldSkipStatusFill({
        hasSlot: !!slotState.sessionStatus[sessionID],
        origin: slotState.sessionStatusOrigin[sessionID],
        stampedAtMs: slotState.sessionStatusAt[sessionID],
        nowMs: Date.now(),
      })
    )
      continue;
    // Locally-synthesized event (this is a REST poll, not an SSE
    // frame) — omits the `id` field every real `Event` union member
    // carries, hence the assertion. `synthetic: true` marks its write
    // `'local'`: a snapshot is a reading ABOUT the runtime taken at
    // issue time, not the runtime speaking on the wire.
    applySyncEvent({
      type: 'session.status',
      synthetic: true,
      properties: { sessionID, status },
    } as unknown as RuntimeWireEvent);
  }
  // The ENUMERATION half is not a per-session reading and does not go
  // stale the same way: a session absent from a complete list was not
  // running when the list was taken, and the repair it drives
  // (`markSessionIdleLocally`) is guarded on its own.
  reconcileMissingBusySessions.current(statuses);
}

/**
 * The stream's (re)hydration: ONE read, `GET /kortix/runtime/pending` (`runtime.log.v1`, every
 * box past the runtime floor). Its statuses are a complete snapshot
 * (the same fill and missing-busy rules as `/session/status`; `compacting` reads as busy); its
 * records reach the pending store as the interaction events a `log.state` carrying `pending`
 * produces. No transcript tail is read: the session log re-reads its own page.
 */
export function hydrateFromPending(
  deps: Pick<HydrationDeps, 'applySyncEvent' | 'reconcileMissingBusySessions'> & {
    /** The session's thread ids: a request of another session is never answered here. */
    threads: () => string[];
    /** Dispatch an interaction event as the stream handler does. */
    dispatch: (event: RuntimeEvent) => void;
  },
): void {
  void activeRuntimeAction('GET', runtimeActionPaths.pending)
    .then(async (response) => {
      if (!response?.ok) return;
      const pending = (await response.json()) as RuntimePending;
      const statuses: Record<string, SessionStatus> = {};
      for (const [thread, status] of Object.entries(pending.statuses ?? {})) {
        if (status !== 'idle') statuses[thread] = { type: 'busy' } as SessionStatus;
      }
      applyStatusSnapshot(statuses, deps);
      const frame = { type: 'log.state', properties: { session: { pending: { permissions: pending.permissions ?? [], questions: pending.questions ?? [] } } } };
      for (const event of pendingEventsOfLogState(frame, deps.threads())) deps.dispatch(event);
    })
    .catch((err) => {
      logger.error('Failed to hydrate pending requests', { error: String(err) });
    });
}

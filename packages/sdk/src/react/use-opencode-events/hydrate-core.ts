import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';
import type { useQueryClient } from '@tanstack/react-query';
import type { reconcileSessionTail as reconcileSessionTailFromRegistry } from '../../browser/session-sync/session-sync-registry';
import type { useRuntimePendingStore } from '../../browser/stores/opencode-pending-store';
import { useSyncStore } from '../../browser/stores/sync-store';
import { logger } from '../../core/http/logger';
import type { getClient } from '../../core/runtime/client';
import { runtimeKeys } from '../use-opencode-sessions';
import { releaseMessageRehydrate, reserveMessageRehydrate, shouldSkipStatusFill } from './helpers';
import { sessionsNeedingRehydrate } from './rehydrate-targets';
import type { useEventStreamRefs } from './use-event-stream-refs';

export function hydrateCore({
  client,
  queryClient,
  addPermission,
  addQuestion,
  applySyncEvent,
  reconcileMissingBusySessions,
  fetchLspDiagnosticsDebounced,
  reconcileSessionTail,
  options,
}: {
  client: ReturnType<typeof getClient>;
  queryClient: ReturnType<typeof useQueryClient>;
  addPermission: ReturnType<typeof useRuntimePendingStore.getState>['addPermission'];
  addQuestion: ReturnType<typeof useRuntimePendingStore.getState>['addQuestion'];
  applySyncEvent: ReturnType<typeof useSyncStore.getState>['applyEvent'];
  reconcileMissingBusySessions: ReturnType<
    typeof useEventStreamRefs
  >['reconcileMissingBusySessions'];
  fetchLspDiagnosticsDebounced: ReturnType<
    typeof useEventStreamRefs
  >['fetchLspDiagnosticsDebounced'];
  reconcileSessionTail: typeof reconcileSessionTailFromRegistry;
  options?: { refetchSessions?: boolean; rehydrateMessages?: boolean };
}): void {
  client.permission
    .list()
    .then((res) => {
      if (Array.isArray(res.data)) res.data.forEach(addPermission);
    })
    .catch((err) => {
      logger.error('Failed to hydrate pending permissions', {
        error: String(err),
      });
    });

  client.question
    .list()
    .then((res) => {
      if (Array.isArray(res.data)) res.data.forEach(addQuestion);
    })
    .catch((err) => {
      logger.error('Failed to hydrate pending questions', {
        error: String(err),
      });
    });

  client.session
    .status()
    .then((res) => {
      // This snapshot is the runtime's COMPLETE set of non-idle sessions,
      // so it carries two facts: what each listed session is doing, and
      // that every UNLISTED one is not busy. The second is the only repair
      // the raw status slot has for a terminal frame this tab never saw,
      // and the surfaces that still read that slot directly — the session
      // panel, and the sub-agent banner for CHILD sessions, which have no
      // Kortix session row for `GET .../turn` to answer about — depend on
      // it. `useSessionWorking` answers for Kortix sessions; this answers
      // for the rest.
      const statuses = res.data ?? {};
      for (const [sessionID, status] of Object.entries(statuses)) {
        // ONLY where this read is newer than what the live stream has
        // already said. The read is a snapshot of the moment it was ISSUED,
        // it carries no timestamp of its own, and it used to be written in
        // unconditionally — so a `busy` that was true when the request left
        // overwrote an `idle` frame that arrived while it was in flight, and
        // because the object identity changed the store restamped the stale
        // reading as the freshest observation there is. That put the Stop
        // button and the turn shimmer back on a finished turn, and
        // `hydrateCore` runs on every heartbeat-gap rehydrate, so it could
        // land on any turn boundary.
        // FILL A GAP, NEVER OVERWRITE. This snapshot describes the moment
        // the request was ISSUED and carries no timestamp of its own, so an
        // unconditional write let a `busy` that was true on the way out
        // clobber an `idle` frame that arrived while it was in flight — and
        // because the object identity changed, the store restamped that
        // stale reading as the freshest observation there is. Stop and the
        // turn shimmer came back on a finished turn, and `hydrateCore` runs
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
        } as unknown as OpenCodeSdkEvent);
      }
      // The ENUMERATION half is not a per-session reading and does not go
      // stale the same way: a session absent from a complete list was not
      // running when the list was taken, and the repair it drives
      // (`markSessionIdleLocally`) is guarded on its own.
      reconcileMissingBusySessions.current(statuses);
    })
    .catch((err) => {
      logger.error('Failed to hydrate session statuses', {
        error: String(err),
      });
    });

  // Fetch current LSP diagnostics so errors/warnings show immediately
  // on page load (or reconnect) without waiting for agent tool output.
  fetchLspDiagnosticsDebounced.current();

  if (options?.refetchSessions) {
    queryClient.refetchQueries({
      queryKey: runtimeKeys.sessions(),
      type: 'active',
    });
  }

  if (options?.rehydrateMessages) {
    const syncState = useSyncStore.getState();
    // EVERY held transcript, not only the ones the status slot calls busy
    // — see `sessionsNeedingRehydrate`. The slot is filled by the stream,
    // so a gap wide enough to lose message frames is wide enough to lose
    // the frame that would have marked the session busy.
    for (const sid of sessionsNeedingRehydrate(Object.keys(syncState.messages))) {
      if (!reserveMessageRehydrate(sid)) continue;
      reconcileSessionTail(sid, 'sse-gap')
        .catch(() => {})
        .finally(() => releaseMessageRehydrate(sid));
    }
  }
}

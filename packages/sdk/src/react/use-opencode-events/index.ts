'use client';

import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';
import { clearConfigOverrides } from '../use-opencode-config';
import {
  noteSessionSyncEvent,
  reconcileSessionTail,
} from '../../browser/session-sync/session-sync-registry';
import { logger } from '../../core/http/logger';
import { dropClientForUrl, getClient } from '../../core/runtime/client';
import { useDiagnosticsStore } from '../../browser/stores/diagnostics-store';
import { useOpenCodeCompactionStore } from '../../browser/stores/opencode-compaction-store';
import { useOpenCodePendingStore } from '../../browser/stores/opencode-pending-store';
import { useSyncStore } from '../../browser/stores/sync-store';
import {
  noteRuntimeEvidence,
  useSandboxConnectionStore,
} from '../../browser/stores/sandbox-connection-store';
import { useServerStore } from '../../browser/stores/server-store';
import { useCurrentRuntime } from '../use-current-runtime';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { opencodeKeys } from '../use-opencode-sessions';
import { useKortixRouteProjectId } from '../route-project';
import { resetPrefetchState } from '../use-session-prefetch';
import { createEventHandler } from './handle-event';
import {
  releaseMessageRehydrate,
  reserveMessageRehydrate,
  resolveClientEvictionUrl,
  shouldSkipStatusFill,
} from './helpers';
import { sessionsNeedingRehydrate } from './rehydrate-targets';
import { createStreamRevival } from './stream-revival';
import { useEventStreamRefs } from './use-event-stream-refs';
import { openEventStream } from '../../core/stream/event-stream';
import { isRuntimeLivenessEvent } from '../../core/stream/keepalive';

/**
 * Connects to OpenCode's SSE event stream via the SDK and
 * performs INCREMENTAL cache updates on React Query data.
 *
 * Instead of invalidating queries (which triggers full refetches),
 * we use setQueryData to surgically update messages, parts, sessions, etc.
 * This matches the SolidJS reference implementation's approach.
 *
 * This hook is a THIN React wrapper: the actual connect/reconnect/backoff,
 * heartbeat watchdog, and event-coalescing machinery is framework-free and
 * lives in `state/event-stream.ts`'s `openEventStream()`. Everything here is
 * either genuinely React-only (effect lifecycle, store subscriptions) or
 * needs the React Query `QueryClient` (cache reads/writes, which
 * `createEventHandler` and `hydrateCore` below perform).
 */
export function useOpenCodeEventStream(options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  // The project this SSE connection's events are about — threaded into
  // `refetchKortixSessionMirrors` so a title/tree mirror refetch stays scoped
  // to the project actually being viewed instead of guessing at "every
  // project" (see that function's doc comment in `helpers.ts`).
  const projectId = useKortixRouteProjectId();
  const addPermission = useOpenCodePendingStore((s) => s.addPermission);
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const addQuestion = useOpenCodePendingStore((s) => s.addQuestion);
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
  const clearPending = useOpenCodePendingStore((s) => s.clear);
  const stopCompaction = useOpenCodeCompactionStore((s) => s.stopCompaction);
  const applySyncEvent = useSyncStore((s) => s.applyEvent);
  // Re-render (and re-read getActiveServerUrl, which resolves current-runtime) when
  // the session's runtime changes — so the SSE re-subscribes to the new daemon.
  const runtimeVersion = useCurrentRuntime((s) => s.version);
  const activeServerUrl = useServerStore((s) => s.getActiveServerUrl());
  const sandboxStatus = useSandboxConnectionStore((s) => s.status);
  const runtimeHealthy = useSandboxConnectionStore((s) => s.healthy);
  const isMountRef = useRef(true);
  const prevRuntimeVersionRef = useRef(runtimeVersion);
  const prevServerUrlRef = useRef(activeServerUrl);
  // Bumped when a parked stream earns another attempt. It is an effect DEP, so
  // the bump tears the dead handle down and opens a fresh one — the same path
  // a runtime switch takes, rather than a second reconnect mechanism.
  const [streamGeneration, setStreamGeneration] = useState(0);
  const revival = useMemo(
    () => createStreamRevival(() => setStreamGeneration((generation) => generation + 1)),
    [],
  );
  useEffect(() => revival.stop, [revival]);

  const {
    normalizeDiagnosticPaths,
    fetchLspDiagnosticsDebounced,
    markSessionAbortedLocally,
    reconcileMissingBusySessions,
  } = useEventStreamRefs({ queryClient, stopCompaction, applySyncEvent });

  useEffect(() => {
    // On first mount, always start clean — the provider may have remounted
    // after navigating away and back while the session's runtime changed. The
    // ref would have been initialized to the post-change runtimeVersion so the
    // isServerSwitch check below would miss the change.
    const isFirstMount = isMountRef.current;
    isMountRef.current = false;

    // Only nuke caches on an actual runtime switch (new session/sandbox), not
    // URL/port updates within the same runtime.
    const isServerSwitch = prevRuntimeVersionRef.current !== runtimeVersion;
    prevRuntimeVersionRef.current = runtimeVersion;
    const previousServerUrl = prevServerUrlRef.current;
    const didServerUrlChange = previousServerUrl !== activeServerUrl;
    prevServerUrlRef.current = activeServerUrl;

    // Only reset the SDK client on actual server switches — NOT on URL/port
    // updates. Resetting on every urlVersion change tears down the client
    // unnecessarily, causing SSE disconnection → reconnection → cache
    // invalidation cascade that manifests as random loading flashes.
    //
    // Evict ONLY the one url actually being replaced (`resolveClientEvictionUrl`)
    // — never `resetClient()`'s full `clientsByUrl` wipe, which would force
    // every OTHER concurrently-open session's client to be recreated just
    // because THIS session's runtime switched (`clientsByUrl` is deliberately
    // keyed per url so several session sandboxes stay connected at once).
    const evictUrl = resolveClientEvictionUrl({
      isFirstMount,
      isServerSwitch,
      didServerUrlChange,
      previousServerUrl,
      activeServerUrl,
    });
    if (evictUrl) dropClientForUrl(evictUrl);

    if (isFirstMount || isServerSwitch) {
      clearConfigOverrides();
      clearPending();
      // NOTE: we intentionally do NOT wipe the sync store or the opencode
      // query cache here anymore. Those are now scoped per-sandbox (see
      // opencodeKeys.activeServerKey + the sync store's session-id keying),
      // so each sandbox's data coexists safely. Wiping them was what made
      // switching back to an already-open session "reload". Diagnostics are
      // still cleared because they're keyed by bare file path (no sandbox
      // scope) and would otherwise bleed across sandboxes.
      useDiagnosticsStore.getState().clearAll();
      resetPrefetchState();
    }

    // Do not connect SSE or hydrate OpenCode-backed endpoints while the
    // runtime is starting/degraded. Otherwise every mounted dashboard tab
    // fans out into /session/*, /path, /permission, /question, and /lsp/*
    // requests that each sit for 30s and retry.
    if (
      options.enabled === false ||
      !activeServerUrl ||
      sandboxStatus !== 'connected' ||
      runtimeHealthy !== true
    )
      return;

    // `activeServerUrl` (getActiveServerUrl) and the url getClient() resolves
    // (getActiveOpenCodeUrl → current-runtime) come from DIFFERENT accessors and
    // briefly diverge on a session switch: the server-store url is set before the
    // current-runtime url is pinned. In that window getClient() throws
    // RuntimeNotReadyError — and because this hook runs in the page render tree
    // (outside SandboxLoadingBoundary), a synchronous throw here is caught by the
    // GLOBAL error boundary and flashes the whole route to blank. "Runtime not
    // ready" is a transient info state, never an error: skip this tick and let the
    // effect re-run (deps include runtimeVersion/activeServerUrl) once it pins.
    let client: ReturnType<typeof getClient>;
    try {
      client = getClient();
    } catch {
      return;
    }

    const handleEvent = createEventHandler({
      queryClient,
      client,
      applySyncEvent,
      stopCompaction,
      addPermission,
      removePermission,
      addQuestion,
      removeQuestion,
      normalizeDiagnosticPaths,
      markSessionAbortedLocally,
      fetchLspDiagnosticsDebounced,
      reconcileSessionTail,
      projectId,
    });

    // ---- CONSOLIDATED hydration function ----
    // Single function for hydrating permissions, questions, and session statuses.
    // Called both on initial connect and on SSE reconnect (gap > 5s).
    // Previously this logic was duplicated in two places.
    const hydrateCore = (options?: { refetchSessions?: boolean; rehydrateMessages?: boolean }) => {
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
          queryKey: opencodeKeys.sessions(),
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
    };

    // Hydrate on initial connect — permissions, questions, and statuses
    hydrateCore();

    // Set up SSE via the framework-free event-stream machine. The
    // connect/reconnect/backoff loop, heartbeat watchdog, and event
    // coalescing all live in `openEventStream` — this wrapper only supplies
    // the QueryClient-dependent event handler and the gap-rehydrate hook.
    const handle = openEventStream({
      client,
      // A park is not a verdict about the sandbox — only about the last few
      // attempts. Nothing supplied this callback before, so the stream's
      // documented "terminal for this handle" silently became terminal for the
      // PAGE: the session view kept rendering a transcript nobody was updating
      // until the user reloaded. See `createStreamRevival`.
      onParked: (info) => {
        logger.warn('SSE stream parked — arming revival', {
          consecutiveFailures: info.consecutiveFailures,
        });
        revival.park();
      },
      onEvent: (event) => {
        // A delivered frame vetoes concurrent health-probe failures (a loaded
        // box can miss the probe deadline mid-turn) — but only when it is
        // proof the RUNTIME answered, not just that the path to it is warm.
        // `kortix.keepalive` is minted by the sandbox daemon one hop above
        // opencode (see `sse-keepalive.ts`) at a 20s cadence; counting it
        // here would veto a probe failure ~3/4 of the time even while
        // opencode itself is wedged, hiding a genuinely dead runtime behind
        // a healthy path. See shouldIgnoreProbeFailure.
        if (isRuntimeLivenessEvent(event)) {
          noteRuntimeEvidence();
        }
        noteSessionSyncEvent(event);
        handleEvent(event);
      },
      onGapRehydrate: () => hydrateCore({ rehydrateMessages: true }),
    });

    return () => {
      revival.stop();
      handle.close();
    };
    // NOTE: urlVersion is intentionally excluded from deps. We only reconnect
    // when the resolved activeServerUrl actually changes, which avoids
    // reconnecting on metadata-only updates while still recovering from
    // stale SSE connections after sandbox/proxy URL changes.
  }, [
    queryClient,
    addPermission,
    removePermission,
    addQuestion,
    removeQuestion,
    clearPending,
    runtimeVersion,
    activeServerUrl,
    sandboxStatus,
    runtimeHealthy,
    options.enabled,
    applySyncEvent,
    stopCompaction,
    projectId,
    revival,
    // A revived park re-opens the stream through this effect. Without it the
    // park stayed terminal for the page.
    streamGeneration,
  ]);
}

/**
 * Headless provider component that connects the SSE event stream.
 * Renders nothing — just call useOpenCodeEventStream().
 *
 * Mount this once on any page that needs live session updates
 * (dashboard layout, onboarding page, etc.).
 */
export function OpenCodeEventStreamProvider() {
  useOpenCodeEventStream();
  return null;
}

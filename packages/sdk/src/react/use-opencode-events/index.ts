'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  noteSessionSyncEvent,
  reconcileSessionTail as reconcileSessionTailFromRegistry,
} from '../../browser/session-sync/session-sync-registry';
import { useDiagnosticsStore } from '../../browser/stores/diagnostics-store';
import { useOpenCodeCompactionStore } from '../../browser/stores/opencode-compaction-store';
import { useRuntimePendingStore } from '../../browser/stores/opencode-pending-store';
import {
  noteRuntimeEvidence,
  useSandboxConnectionStore,
} from '../../browser/stores/sandbox-connection-store';
import { useServerStore } from '../../browser/stores/server-store';
import { useSyncStore } from '../../browser/stores/sync-store';
import { logger } from '../../core/http/logger';
import { dropClientForUrl, getClient } from '../../core/runtime/client';
import { openEventStream } from '../../core/stream/event-stream';
import { useKortixRouteProjectId } from '../route-project';
import { useCurrentRuntime } from '../use-current-runtime';
import { clearConfigOverrides } from '../use-opencode-config';
import { resetPrefetchState } from '../use-session-prefetch';
import { createEventHandler } from './handle-event';
import { resolveClientEvictionUrl } from './helpers';
import { hydrateCore } from './hydrate-core';
import { createStreamRevival } from './stream-revival';
import { useEventStreamRefs } from './use-event-stream-refs';

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
export function useRuntimeEventStream(options: { enabled?: boolean } = {}) {
  const queryClient = useQueryClient();
  // The project this SSE connection's events are about — threaded into
  // `refetchKortixSessionMirrors` so a title/tree mirror refetch stays scoped
  // to the project actually being viewed instead of guessing at "every
  // project" (see that function's doc comment in `helpers.ts`).
  const projectId = useKortixRouteProjectId();
  const addPermission = useRuntimePendingStore((s) => s.addPermission);
  const removePermission = useRuntimePendingStore((s) => s.removePermission);
  const addQuestion = useRuntimePendingStore((s) => s.addQuestion);
  const removeQuestion = useRuntimePendingStore((s) => s.removeQuestion);
  const clearPending = useRuntimePendingStore((s) => s.clear);
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
      // runtimeKeys.activeServerKey + the sync store's session-id keying),
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
    // (getActiveRuntimeUrl → current-runtime) come from DIFFERENT accessors and
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
      reconcileSessionTail: reconcileSessionTailFromRegistry,
      projectId,
    });

    const hydrate = (options?: { refetchSessions?: boolean; rehydrateMessages?: boolean }) =>
      hydrateCore({
        client,
        queryClient,
        addPermission,
        addQuestion,
        applySyncEvent,
        reconcileMissingBusySessions,
        fetchLspDiagnosticsDebounced,
        reconcileSessionTail: reconcileSessionTailFromRegistry,
        options,
      });

    // A revived handle has no record of the previous handle's outage. Re-read
    // the held transcripts so a response completed during the park appears
    // without requiring a page refresh.
    hydrate({ rehydrateMessages: streamGeneration > 0 });

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
        // Every delivered frame is live proof the runtime is reachable — it
        // vetoes concurrent health-probe failures (a loaded box can miss the
        // probe deadline mid-turn). See shouldIgnoreProbeFailure.
        noteRuntimeEvidence();
        noteSessionSyncEvent(event);
        handleEvent(event);
      },
      onGapRehydrate: () => hydrate({ rehydrateMessages: true }),
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
 * Renders nothing — just call useRuntimeEventStream().
 *
 * Mount this once on any page that needs live session updates
 * (dashboard layout, onboarding page, etc.).
 */
export function RuntimeEventStreamProvider() {
  useRuntimeEventStream();
  return null;
}

// Pre-W4 names, kept until the next major. The runtime is OpenCode or pi.
/** @deprecated Renamed to `RuntimeEventStreamProvider`. Removed in the next major. */
export const OpenCodeEventStreamProvider = RuntimeEventStreamProvider;
/** @deprecated Renamed to `useRuntimeEventStream`. Removed in the next major. */
export const useOpenCodeEventStream = useRuntimeEventStream;

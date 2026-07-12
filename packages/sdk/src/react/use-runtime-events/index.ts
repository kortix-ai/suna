'use client';

import type { Event as RuntimeSdkEvent } from '../../runtime/wire-types';
import { clearConfigOverrides } from '../use-runtime-config';
import { saveSessionToIDB } from '../../browser/cache/idb-sync-cache';
import { logger } from '../../core/http/logger';
import { getClient, resetClient } from '../../core/runtime/client';
import { useDiagnosticsStore } from '../../browser/stores/diagnostics-store';
import { useRuntimeCompactionStore } from '../../browser/stores/runtime-compaction-store';
import { useRuntimePendingStore } from '../../browser/stores/runtime-pending-store';
import { useSyncStore } from '../../browser/stores/sync-store';
import { useSandboxConnectionStore } from '../../browser/stores/sandbox-connection-store';
import { useServerStore } from '../../browser/stores/server-store';
import { useCurrentRuntime } from '../use-current-runtime';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { runtimeKeys } from '../use-runtime-sessions';
import { resetPrefetchState } from '../use-session-prefetch';
import { createEventHandler } from './handle-event';
import { releaseMessageRehydrate, reserveMessageRehydrate } from './helpers';
import { useEventStreamRefs } from './use-event-stream-refs';
import { openEventStream } from '../../core/stream/event-stream';

/**
 * Connects to Runtime's SSE event stream via the SDK and
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
export function useRuntimeEventStream(enabled = true) {
  const queryClient = useQueryClient();
  const addPermission = useRuntimePendingStore((s) => s.addPermission);
  const removePermission = useRuntimePendingStore((s) => s.removePermission);
  const addQuestion = useRuntimePendingStore((s) => s.addQuestion);
  const removeQuestion = useRuntimePendingStore((s) => s.removeQuestion);
  const clearPending = useRuntimePendingStore((s) => s.clear);
  const stopCompaction = useRuntimeCompactionStore((s) => s.stopCompaction);
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

  const {
    normalizeDiagnosticPaths,
    fetchLspDiagnosticsDebounced,
    markSessionAbortedLocally,
    reconcileMissingBusySessions,
  } = useEventStreamRefs({ queryClient, stopCompaction, applySyncEvent });

  useEffect(() => {
    if (!enabled) return;
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
    const didServerUrlChange = prevServerUrlRef.current !== activeServerUrl;
    prevServerUrlRef.current = activeServerUrl;

    // Only reset the SDK client on actual server switches — NOT on URL/port
    // updates. Resetting on every urlVersion change tears down the client
    // unnecessarily, causing SSE disconnection → reconnection → cache
    // invalidation cascade that manifests as random loading flashes.
    if (isFirstMount || isServerSwitch) {
      resetClient();
      clearConfigOverrides();
      clearPending();
      // NOTE: we intentionally do NOT wipe the sync store or the runtime
      // query cache here anymore. Those are now scoped per-sandbox (see
      // runtimeKeys.activeServerKey + the sync store's session-id keying),
      // so each sandbox's data coexists safely. Wiping them was what made
      // switching back to an already-open session "reload". Diagnostics are
      // still cleared because they're keyed by bare file path (no sandbox
      // scope) and would otherwise bleed across sandboxes.
      useDiagnosticsStore.getState().clearAll();
      resetPrefetchState();
    } else if (didServerUrlChange) {
      // URL changed on the same logical server (e.g. sandbox/proxy refresh).
      // Recreate the SDK client so SSE reconnects to the new endpoint, but
      // keep caches/status intact to avoid loading flashes.
      resetClient();
    }

    // Do not connect SSE or hydrate Runtime-backed endpoints while the
    // runtime is starting/degraded. Otherwise every mounted dashboard tab
    // fans out into /session/*, /path, /permission, /question, and /lsp/*
    // requests that each sit for 30s and retry.
    if (!activeServerUrl || sandboxStatus !== 'connected' || runtimeHealthy !== true) return;

    const client = getClient();

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
          if (res.data) {
            const statuses = res.data;
            for (const [sessionID, status] of Object.entries(statuses)) {
              // Locally-synthesized event (this is a REST poll, not an SSE
              // frame) — omits the `id` field every real `Event` union member
              // carries, hence the assertion.
              applySyncEvent({
                type: 'session.status',
                properties: { sessionID, status },
              } as unknown as RuntimeSdkEvent);
            }
            reconcileMissingBusySessions.current(statuses);
          } else {
            reconcileMissingBusySessions.current({});
          }
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
        const loadedSessionIds = Object.keys(syncState.messages);
        for (const sid of loadedSessionIds) {
          const status = syncState.sessionStatus[sid];
          if (status?.type !== 'busy' && status?.type !== 'retry') continue;
          if (!reserveMessageRehydrate(sid)) continue;
          client.session
            .messages({ sessionID: sid })
            .then((res) => {
              if (res.data) {
                useSyncStore.getState().hydrate(sid, res.data);
                const s = useSyncStore.getState();
                const msgs = s.messages[sid] ?? [];
                if (msgs.length > 0) saveSessionToIDB(sid, msgs, s.parts);
              }
            })
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
      onEvent: handleEvent,
      onGapRehydrate: () => hydrateCore({ rehydrateMessages: true }),
    });

    return () => {
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
    enabled,
    sandboxStatus,
    runtimeHealthy,
    applySyncEvent,
    stopCompaction,
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

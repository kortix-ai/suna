'use client';

import { clearConfigOverrides } from '../use-opencode-config';
import { getSupabaseAccessToken, invalidateTokenCache } from '../../platform/auth';
import { saveSessionToIDB } from '../../state/idb-sync-cache';
import { logger } from '../../platform/logger';
import { getClient, resetClient } from '../../opencode/client';
import { useDiagnosticsStore } from '../../state/diagnostics-store';
import { useOpenCodeCompactionStore } from '../../state/opencode-compaction-store';
import { useOpenCodePendingStore } from '../../state/opencode-pending-store';
import { useSyncStore } from '../../state/sync-store';
import { useSandboxConnectionStore } from '../../state/sandbox-connection-store';
import { useServerStore } from '../../state/server-store';
import { useCurrentRuntime } from '../../state/current-runtime';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { opencodeKeys } from '../use-opencode-sessions';
import { resetPrefetchState } from '../use-session-prefetch';
import { createEventHandler } from './handle-event';
import { releaseMessageRehydrate, reserveMessageRehydrate } from './helpers';
import type { OpenCodeEvent } from './types';
import { useEventStreamRefs } from './use-event-stream-refs';

/**
 * Connects to OpenCode's SSE event stream via the SDK and
 * performs INCREMENTAL cache updates on React Query data.
 *
 * Instead of invalidating queries (which triggers full refetches),
 * we use setQueryData to surgically update messages, parts, sessions, etc.
 * This matches the SolidJS reference implementation's approach.
 */
export function useOpenCodeEventStream() {
  const queryClient = useQueryClient();
  const addPermission = useOpenCodePendingStore((s) => s.addPermission);
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const addQuestion = useOpenCodePendingStore((s) => s.addQuestion);
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
  const clearPending = useOpenCodePendingStore((s) => s.clear);
  const stopCompaction = useOpenCodeCompactionStore((s) => s.stopCompaction);
  const applySyncEvent = useSyncStore((s) => s.applyEvent);
  const serverVersion = useServerStore((s) => s.serverVersion);
  // Re-render (and re-read getActiveServerUrl, which prefers current-runtime) when
  // the session's runtime URL changes — so the SSE re-subscribes to the new daemon.
  const runtimeVersion = useCurrentRuntime((s) => s.version);
  const activeServerUrl = useServerStore((s) => s.getActiveServerUrl());
  const sandboxStatus = useSandboxConnectionStore((s) => s.status);
  const runtimeHealthy = useSandboxConnectionStore((s) => s.healthy);
  const abortRef = useRef<AbortController | null>(null);
  const isMountRef = useRef(true);
  const prevServerVersionRef = useRef(serverVersion);
  const prevServerUrlRef = useRef(activeServerUrl);

  const {
    normalizeDiagnosticPaths,
    fetchLspDiagnosticsDebounced,
    markSessionAbortedLocally,
    reconcileMissingBusySessions,
  } = useEventStreamRefs({ queryClient, stopCompaction, applySyncEvent });

  useEffect(() => {
    // On first mount, always start clean — the provider may have remounted
    // after navigating from a non-dashboard page (e.g. /instances) where
    // the server was switched while this component wasn't mounted. The ref
    // would have been initialized to the post-switch serverVersion so the
    // isServerSwitch check below would miss the change.
    const isFirstMount = isMountRef.current;
    isMountRef.current = false;

    // Only nuke caches on actual server switches (not URL/port updates)
    const isServerSwitch = prevServerVersionRef.current !== serverVersion;
    prevServerVersionRef.current = serverVersion;
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
      // NOTE: we intentionally do NOT wipe the sync store or the opencode
      // query cache here anymore. Those are now scoped per-sandbox (see
      // opencodeKeys.activeServerKey + the sync store's session-id keying),
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

    // Do not connect SSE or hydrate OpenCode-backed endpoints while the
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
            const statuses = res.data as Record<string, any>;
            for (const [sessionID, status] of Object.entries(statuses)) {
              applySyncEvent({
                type: 'session.status',
                properties: { sessionID, status },
              } as any);
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
          queryKey: opencodeKeys.sessions(),
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
                useSyncStore.getState().hydrate(sid, res.data as any);
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

    // Set up SSE via the SDK's AsyncGenerator
    const abortController = new AbortController();
    abortRef.current = abortController;

    // Track last stream activity (connect or event) to gate reconnect hydration.
    // Using only "last event" causes hydrate storms when the server rotates
    // idle SSE connections that carried no events.
    let lastStreamActivityTime = Date.now();
    // Track when the stream connected and whether it delivered any events.
    // We reset reconnect backoff only after a healthy connection (events received
    // or sustained >10s). Brief connect→drop loops keep backoff growth.
    let streamConnectedAt = 0;

    // Event coalescing queue (like the SolidJS reference)
    let queue: ({ type: string; event: OpenCodeEvent } | undefined)[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastFlush = 0;

    // Coalescing map — replaces earlier events of the same key
    const coalesced = new Map<string, number>();

    // Coalescing keys — determines which events can replace earlier ones
    // in the same 16ms flush batch.
    // NOTE: message.part.updated is intentionally NOT coalesced. While the
    // server sends full part state each time, coalescing can cause a stale
    // snapshot to be the sole survivor of a batch. When that stale snapshot
    // is processed before any deltas, it inserts the part with wrong/partial
    // text (prefix-growth guard can't help — nothing to compare against).
    // The upsertPart prefix-growth guard efficiently rejects stale snapshots
    // with a no-op return, so processing every snapshot has minimal cost.
    function getCoalesceKey(event: OpenCodeEvent): string | undefined {
      if (event.type === 'session.status') {
        return `session.status:${(event.properties as any).sessionID}`;
      }
      if (event.type === 'lsp.updated') return 'lsp.updated';
      return undefined;
    }

    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (queue.length === 0) return;

      const events = queue;
      queue = [];
      coalesced.clear();
      lastFlush = Date.now();
      lastStreamActivityTime = Date.now();

      for (const item of events) {
        if (!item) continue;
        handleEvent(item.event);
      }
    };

    const schedule = () => {
      if (flushTimer) return;
      const elapsed = Date.now() - lastFlush;
      flushTimer = setTimeout(flush, Math.max(0, 16 - elapsed));
    };

    // Consume the stream in the background with automatic retry
    (async () => {
      let retryCount = 0;
      while (!abortController.signal.aborted) {
        let streamHadEvents = false;
        let stableConnection = false;
        let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await client.global.event({
            signal: abortController.signal,
            sseDefaultRetryDelay: 3000,
            sseMaxRetryDelay: 30000,
          } as any);
          const { stream } = result;
          streamConnectedAt = Date.now();
          lastStreamActivityTime = streamConnectedAt;

          // Heartbeat timeout — matching the reference. If no events
          // arrive for 15s, abort and reconnect. This is the ONLY
          // recovery mechanism we need — replaces the stall watchdog,
          // reconciler, and visibility handler.
          const HEARTBEAT_MS = 15_000;
          const heartbeatAbort = new AbortController();
          const resetHeartbeat = () => {
            clearTimeout(heartbeatTimer);
            heartbeatTimer = setTimeout(() => {
              logger.warn('SSE heartbeat timeout, forcing reconnect');
              heartbeatAbort.abort();
            }, HEARTBEAT_MS);
          };
          resetHeartbeat();

          // Consume stream: queue + coalesce + 16ms flush + yield every 8ms
          let yieldedAt = Date.now();
          for await (const event of stream) {
            if (abortController.signal.aborted || heartbeatAbort.signal.aborted) break;
            streamHadEvents = true;
            resetHeartbeat();
            const raw = event as any;
            const e = (
              raw && typeof raw === 'object' && 'payload' in raw ? raw.payload : raw
            ) as OpenCodeEvent;
            if (!e?.type) continue;

            const ck = getCoalesceKey(e);
            if (ck) {
              const existing = coalesced.get(ck);
              if (existing !== undefined) {
                queue[existing] = undefined;
              }
              coalesced.set(ck, queue.length);
            }
            queue.push({ type: (e as any).type, event: e });
            schedule();

            if (Date.now() - yieldedAt < 8) continue;
            yieldedAt = Date.now();
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }

          // Healthy stream if it delivered events, or if it stayed open for >10s.
          stableConnection = streamHadEvents || Date.now() - streamConnectedAt > 10_000;
        } catch (err) {
          if (abortController.signal.aborted) break;
          const errStr = String(err);
          const isAuthError =
            errStr.includes('401') ||
            errStr.includes('403') ||
            errStr.includes('Unauthorized') ||
            errStr.includes('Token refresh failed');
          logger.error('SSE event stream error', {
            error: errStr,
            retryCount,
            isAuthError,
          });

          // On auth errors, invalidate the token cache and fetch a fresh token.
          // This ensures all callers (SSE, health check, SDK) immediately use
          // the refreshed token instead of serving stale cached ones for 30s.
          if (isAuthError) {
            try {
              invalidateTokenCache();
              await getSupabaseAccessToken();
              logger.info('SSE: refreshed auth token after auth error');
            } catch (refreshErr) {
              logger.error('SSE: failed to refresh auth token', {
                error: String(refreshErr),
              });
            }
          }
        } finally {
          clearTimeout(heartbeatTimer);
          flush();
        }

        // Stream ended or errored — reconnect with exponential backoff.
        // ERR_INCOMPLETE_CHUNKED_ENCODING is normal when the server closes
        // the SSE connection between response cycles.
        // Minimum 1s delay even on first retry to avoid reconnection storms
        // when the server is flapping (connect → immediate disconnect loops).
        if (abortController.signal.aborted) break;

        // Re-hydrate messages for loaded sessions when the SSE gap was
        // significant (>5s). Events missed during the gap (e.g. streaming
        // assistant response) would never arrive, leaving the UI stale
        // until the user manually refreshes.
        const gap = Date.now() - lastStreamActivityTime;
        if (gap > 5_000) {
          hydrateCore({ rehydrateMessages: true });
        }

        if (stableConnection) {
          // Fast reconnect after healthy streams so live streaming resumes immediately.
          retryCount = 0;
        } else {
          retryCount++;
          if (retryCount > 1) {
            logger.warn('SSE event stream reconnecting', { retryCount });
          }
        }
        const delay = stableConnection
          ? 250
          : Math.min(1000 * 2 ** Math.min(retryCount - 1, 5), 30000);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          abortController.signal.addEventListener('abort', onAbort, {
            once: true,
          });
        });
      }
    })();

    return () => {
      abortController.abort();
      abortRef.current = null;
      if (flushTimer) clearTimeout(flushTimer);
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
    serverVersion,
    runtimeVersion,
    activeServerUrl,
    sandboxStatus,
    runtimeHealthy,
    applySyncEvent,
    stopCompaction,
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

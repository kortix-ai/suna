'use client';

import { infoToast } from '@/components/ui/toast';
import { fileContentKeys } from '@/features/files/hooks/use-file-content';
import { fileListKeys } from '@/features/files/hooks/use-file-list';
import { gitStatusKeys } from '@/features/files/hooks/use-git-status';
import { clearConfigOverrides } from '@/hooks/opencode/use-opencode-config';
import { authenticatedFetch, getSupabaseAccessToken, invalidateTokenCache } from '@/lib/auth-token';
import { deleteSessionFromIDB, saveSessionToIDB } from '@/lib/idb-sync-cache';
import { logger } from '@/lib/logger';
import { getClient, resetClient } from '@/lib/opencode-sdk';
import {
  notifyPermissionRequest,
  notifyQuestion,
  notifySessionError,
  notifyTaskComplete,
} from '@/lib/web-notifications';
import { parseDiagnosticsFromToolOutput, useDiagnosticsStore } from '@/stores/diagnostics-store';
import { useOpenCodeCompactionStore } from '@/stores/opencode-compaction-store';
import { useOpenCodePendingStore } from '@/stores/opencode-pending-store';
import { useSyncStore } from '@/stores/opencode-sync-store';
import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { getActiveOpenCodeUrl, useServerStore } from '@/stores/server-store';
import type { Event as OpenCodeSdkEvent, Part } from '@opencode-ai/sdk/v2/client';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { hasUnsettledToolPart, IDLE_RECONCILE_DELAY_MS } from './idle-reconcile';
import { ptyKeys } from './use-opencode-pty';
import { type MessageWithParts, opencodeKeys, type Session } from './use-opencode-sessions';
import { resetPrefetchState } from './use-session-prefetch';

type OpenCodeEvent =
  | OpenCodeSdkEvent
  | {
      id: string;
      type: 'lsp.client.diagnostics';
      properties: { serverID: string; path: string };
    };

const MESSAGE_REHYDRATE_COOLDOWN_MS = 30_000;
const PROJECT_METADATA_REFETCH_COOLDOWN_MS = 5_000;
const messageRehydrateInFlight = new Set<string>();
const messageRehydrateLastAt = new Map<string, number>();
let projectMetadataRefetchLastAt = 0;
let projectMetadataRefetchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * session.created/updated/deleted carry the Session object either nested under
 * `properties.info` (the SDK type) or FLAT as `properties` itself — the opencode
 * runtime emits the flat shape, which the typed `.info` read silently drops. That
 * dropped every live `session.updated`, so auto-generated titles never reached
 * the tabs/sidebar until an HTTP list refetch (i.e. only after you navigated to
 * or created another session). Read both shapes — same fix the mobile client
 * shipped (apps/mobile commit 7f31102fe "fix: session title updates").
 */
function readSessionInfo(event: OpenCodeEvent): Session | undefined {
  const props = (event as any)?.properties;
  if (!props) return undefined;
  if (props.info) return props.info as Session;
  return typeof props.id === 'string' ? (props as Session) : undefined;
}

function reserveMessageRehydrate(sessionID: string): boolean {
  if (!sessionID || messageRehydrateInFlight.has(sessionID)) return false;
  const now = Date.now();
  const last = messageRehydrateLastAt.get(sessionID) ?? 0;
  if (now - last < MESSAGE_REHYDRATE_COOLDOWN_MS) return false;
  messageRehydrateInFlight.add(sessionID);
  messageRehydrateLastAt.set(sessionID, now);
  return true;
}

function releaseMessageRehydrate(sessionID: string): void {
  messageRehydrateInFlight.delete(sessionID);
}

function scheduleProjectMetadataRefetch(queryClient: QueryClient): void {
  const run = () => {
    projectMetadataRefetchTimer = null;
    projectMetadataRefetchLastAt = Date.now();
    queryClient.refetchQueries({ queryKey: opencodeKeys.projects(), type: 'active' });
    queryClient.refetchQueries({ queryKey: opencodeKeys.currentProject(), type: 'active' });
  };

  const now = Date.now();
  const wait = PROJECT_METADATA_REFETCH_COOLDOWN_MS - (now - projectMetadataRefetchLastAt);
  if (wait <= 0) {
    if (projectMetadataRefetchTimer) {
      clearTimeout(projectMetadataRefetchTimer);
      projectMetadataRefetchTimer = null;
    }
    run();
    return;
  }
  if (!projectMetadataRefetchTimer) {
    projectMetadataRefetchTimer = setTimeout(run, wait);
  }
}

// ---- Reconcile-on-idle ----
// When a run finishes, a tool call whose FINAL `message.part.updated` (the one
// carrying its completed result) was dropped at the SSE stream-end boundary
// stays frozen in `pending`/`running` — the tool keeps rendering its loading
// spinner forever until a manual hard refresh re-fetches the persisted state.
// (The reconnect rehydrate at the bottom of the stream loop only runs when the
// gap was >5s, and `session.idle` itself never rehydrates messages.) On the
// busy/retry → idle completion edge we refetch the authoritative messages and
// `hydrate` — the same data a refresh loads, and for tool parts the server's
// `completed` snapshot wins — so the stuck result resolves on its own.
// The unsettled-part predicate lives in ./idle-reconcile (pure + unit-tested).
const idleReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
const idleReconcileInFlight = new Set<string>();

function sessionHasUnsettledToolPart(sessionID: string): boolean {
  const s = useSyncStore.getState();
  return hasUnsettledToolPart(s.messages[sessionID] ?? [], s.parts);
}

function reconcileSessionFromServer(sessionID: string): void {
  if (idleReconcileInFlight.has(sessionID)) return;
  idleReconcileInFlight.add(sessionID);
  getClient()
    .session.messages({ sessionID })
    .then((res) => {
      if (res.data) {
        useSyncStore.getState().hydrate(sessionID, res.data as any);
        const s = useSyncStore.getState();
        const msgs = s.messages[sessionID] ?? [];
        if (msgs.length > 0) saveSessionToIDB(sessionID, msgs, s.parts);
      }
    })
    .catch(() => {})
    .finally(() => idleReconcileInFlight.delete(sessionID));
}

/**
 * Debounced reconcile fired on the run-complete edge. Re-checks at fire time so
 * the common case — the completed-result event simply arrived a beat after idle
 * via SSE — costs nothing; we only hit the network for a part that is STILL
 * stuck after the settle window.
 */
function scheduleIdleReconcile(sessionID: string): void {
  const existing = idleReconcileTimers.get(sessionID);
  if (existing) clearTimeout(existing);
  idleReconcileTimers.set(
    sessionID,
    setTimeout(() => {
      idleReconcileTimers.delete(sessionID);
      if (!sessionHasUnsettledToolPart(sessionID)) return;
      reconcileSessionFromServer(sessionID);
    }, IDLE_RECONCILE_DELAY_MS),
  );
}

function refetchKortixSessionMirrors(queryClient: QueryClient): void {
  // OpenCode title/tree mirroring is owned by API session reads. When OpenCode
  // emits a title/tree change, refetch the active Kortix session reads so tabs
  // and sidebars pick up the server-side mirror without browser-side writes.
  void queryClient.refetchQueries({ queryKey: ['project-sessions'], type: 'active' });
  void queryClient.refetchQueries({ queryKey: ['project-session'], type: 'active' });
}

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
  const activeServerUrl = useServerStore((s) => s.getActiveServerUrl());
  const sandboxStatus = useSandboxConnectionStore((s) => s.status);
  const runtimeHealthy = useSandboxConnectionStore((s) => s.healthy);
  const abortRef = useRef<AbortController | null>(null);
  const isMountRef = useRef(true);
  const prevServerVersionRef = useRef(serverVersion);
  const prevServerUrlRef = useRef(activeServerUrl);

  /**
   * Resolve an absolute sandbox path to a project-relative path by stripping
   * known worktree/directory prefixes from the React Query cache.
   *
   * For example: `/workspace/desktop/express-crud-app/src/server.js` → `src/server.js`
   *
   * This is critical for LSP diagnostics: the backend sends absolute paths,
   * but the frontend file tree / file viewer uses project-relative paths.
   */
  const normalizeLspPath = useRef((absPath: string): string => {
    if (!absPath || !absPath.startsWith('/')) return absPath;

    // Collect prefixes from cached project/path data
    const prefixes: string[] = [];
    try {
      const project = queryClient.getQueryData<any>(opencodeKeys.currentProject());
      if (project?.worktree) prefixes.push(project.worktree);
      const pathInfo = queryClient.getQueryData<any>(opencodeKeys.pathInfo());
      if (pathInfo?.directory) prefixes.push(pathInfo.directory);
      if (pathInfo?.worktree) prefixes.push(pathInfo.worktree);
    } catch {
      // non-critical
    }

    // Deduplicate and sort longest first (most specific prefix wins)
    const unique = [...new Set(prefixes.filter(Boolean))].sort((a, b) => b.length - a.length);

    for (const wt of unique) {
      if (!wt || wt === '/') continue;
      const prefix = wt.endsWith('/') ? wt : wt + '/';
      if (absPath.startsWith(prefix)) {
        return absPath.slice(prefix.length);
      }
    }

    return absPath;
  });

  /** Normalize all keys in a diagnostic map from absolute to relative paths */
  const normalizeDiagnosticPaths = useRef(
    (diagsByFile: Record<string, any[]>): Record<string, any[]> => {
      const normalized: Record<string, any[]> = {};
      for (const [file, diags] of Object.entries(diagsByFile)) {
        const relPath = normalizeLspPath.current(file);
        normalized[relPath] = diags;
      }
      return normalized;
    },
  );

  /**
   * Debounced fetch of all LSP diagnostics from the backend.
   *
   * The `lsp.client.diagnostics` SSE event only carries { serverID, path }
   * (no actual diagnostic data). Multiple events fire in rapid succession
   * as the language server reports diagnostics for different files, so we
   * debounce and fetch the full diagnostics map from GET /lsp/diagnostics.
   */
  const fetchLspDiagnosticsDebounced = useRef(
    (() => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      return () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          try {
            const baseUrl = getActiveOpenCodeUrl();
            const resp = await authenticatedFetch(`${baseUrl}/lsp/diagnostics`);
            if (!resp.ok) return;
            const data = (await resp.json()) as Record<string, any[]>;
            if (data && typeof data === 'object') {
              const normalized = normalizeDiagnosticPaths.current(data);
              // The endpoint returns the *complete* diagnostics state,
              // so clear stale entries before applying the fresh data.
              const store = useDiagnosticsStore.getState();
              store.clearAll();
              store.setFromLspEvent(normalized);
            }
          } catch {
            // Silently ignore — diagnostics are non-critical and the
            // endpoint may not be available on older OpenCode versions.
          }
        }, 250);
      };
    })(),
  );

  const markSessionAbortedLocally = useRef(
    (sessionID: string, message = 'The operation was aborted because the runtime shut down.') => {
      if (!sessionID) return;
      const error = {
        name: 'AbortError',
        data: { message },
      };
      stopCompaction(sessionID);
      applySyncEvent({
        type: 'session.error',
        properties: { sessionID, error },
      } as any);
      useSyncStore.getState().setStatus(sessionID, { type: 'idle' } as any);
      useSyncStore.getState().clearOptimisticMessages(sessionID);
    },
  );

  const markSessionIdleLocally = useRef((sessionID: string) => {
    if (!sessionID) return;
    stopCompaction(sessionID);
    applySyncEvent({
      type: 'session.idle',
      properties: { sessionID },
    } as any);
    useSyncStore.getState().setStatus(sessionID, { type: 'idle' } as any);
    useSyncStore.getState().clearOptimisticMessages(sessionID);
  });

  const reconcileMissingBusySessions = useRef((nextStatuses: Record<string, any>) => {
    const previousStatuses = useSyncStore.getState().sessionStatus;
    for (const [sessionID, status] of Object.entries(previousStatuses)) {
      if (status?.type !== 'idle' && !nextStatuses[sessionID]) {
        // A brand-new session whose first prompt the server hasn't registered
        // yet is locally-busy but absent from the status snapshot. Don't idle
        // it: markSessionIdleLocally → clearOptimisticMessages would wipe the
        // optimistic user bubble before the real message.updated arrives (the
        // "message sent from home vanishes / blinks" bug). Real status/idle
        // events reconcile it once the server catches up.
        if (useSyncStore.getState().hasOptimisticMessages(sessionID)) continue;
        markSessionIdleLocally.current(sessionID);
      }
    }
  });

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

    // Helper: look up a session title from the React Query cache for notifications
    function getSessionTitle(sessionID: string): string | undefined {
      const sessions = queryClient.getQueryData<any[]>(opencodeKeys.sessions());
      if (sessions) {
        const s = sessions.find((s: any) => s.id === sessionID);
        if (s?.title) return s.title;
      }
      const session = queryClient.getQueryData<any>(opencodeKeys.session(sessionID));
      return session?.title || undefined;
    }

    function handleEvent(event: OpenCodeEvent) {
      // Detect the run-complete edge (busy/retry → idle) BEFORE applySyncEvent
      // runs: it sets the session status to idle synchronously, which would
      // otherwise mask the transition for the reconcile check below.
      let completedSessionID: string | undefined;
      if (event.type === 'session.idle' || event.type === 'session.status') {
        const sid = (event.properties as any)?.sessionID as string | undefined;
        const nextStatus =
          event.type === 'session.idle' ? { type: 'idle' } : (event.properties as any)?.status;
        if (sid && nextStatus?.type === 'idle') {
          const prev = useSyncStore.getState().sessionStatus[sid];
          if (prev && prev.type !== 'idle') completedSessionID = sid;
        }
      }

      // Sync store is the SINGLE source of truth for messages & parts.
      // This matches OpenCode's architecture where the SolidJS store is
      // the only place message/part data lives.
      applySyncEvent(event as OpenCodeSdkEvent);

      // The run just finished. If a tool call is still showing a loading
      // spinner because its completed-result event was dropped at the
      // stream-end boundary, reconcile against the server (what a hard refresh
      // would load) so it resolves without a manual refresh.
      if (completedSessionID && sessionHasUnsettledToolPart(completedSessionID)) {
        scheduleIdleReconcile(completedSessionID);
      }

      switch (event.type) {
        // ---- Message events — handled by sync store only ----
        case 'message.updated':
        case 'message.removed':
          break;

        case 'message.part.updated': {
          // Extract diagnostics from tool output and/or metadata
          const part = (event.properties as any).part as Part;
          const partState = (part as any)?.state;

          // --- Primary path: parse diagnostics from tool output text ---
          // The OpenCode backend embeds diagnostics as plain text inside
          // <file_diagnostics> / <project_diagnostics> XML tags in the
          // tool's text output (e.g. after write, edit, diagnostics tools).
          if (partState?.status === 'completed' && partState.output) {
            const output = partState.output as string;
            if (output.includes('<file_diagnostics>') || output.includes('<project_diagnostics>')) {
              const parsed = parseDiagnosticsFromToolOutput(output);
              const fileCount = Object.keys(parsed).length;
              if (fileCount > 0) {
                // Normalize absolute sandbox paths to project-relative
                const normalized = normalizeDiagnosticPaths.current(parsed);
                // Convert LspDiagnostic[] to RawDiagnostic[] format for the store
                const asRaw: Record<string, any[]> = {};
                for (const [file, diags] of Object.entries(normalized)) {
                  asRaw[file] = diags.map((d) => ({
                    range: {
                      start: { line: d.line, character: d.column },
                    },
                    severity: d.severity,
                    message: d.message,
                    source: d.source,
                  }));
                }
                useDiagnosticsStore.getState().setFromLspEvent(asRaw);
              }
            }
          }

          // --- Fallback: check metadata.diagnostics (legacy / fork path) ---
          const partMeta = partState?.metadata;
          if (partMeta?.diagnostics && typeof partMeta.diagnostics === 'object') {
            const diagsByFile = partMeta.diagnostics as Record<string, any[]>;
            const validEntries: Record<string, any[]> = {};
            let hasValid = false;
            for (const [file, diags] of Object.entries(diagsByFile)) {
              if (Array.isArray(diags) && diags.length > 0) {
                validEntries[file] = diags;
                hasValid = true;
              }
            }
            if (hasValid) {
              const normalized = normalizeDiagnosticPaths.current(validEntries);
              useDiagnosticsStore.getState().setFromLspEvent(normalized);
            }
          }
          break;
        }

        case 'message.part.removed':
          break;

        // ---- Session lifecycle — surgical cache mutations (zero HTTP) ----
        //
        // IMPORTANT: Return the old array reference when nothing changed.
        // Creating new arrays on every SSE event causes cascading re-renders
        // in all session list consumers, which triggers a Radix UI compose-refs
        // infinite loop (Maximum update depth exceeded).
        case 'session.created': {
          const info = readSessionInfo(event);
          if (info) {
            queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
              if (!old) return [info];
              const exists = old.findIndex((s) => s.id === info.id);
              if (exists >= 0) {
                // Already exists — check if actually changed
                if (old[exists].time.updated === info.time.updated) return old;
                const next = [...old];
                next[exists] = info;
                return next.sort((a, b) => b.time.updated - a.time.updated);
              }
              return [info, ...old].sort((a, b) => b.time.updated - a.time.updated);
            });
            queryClient.setQueryData(opencodeKeys.session(info.id), info);
            refetchKortixSessionMirrors(queryClient);
          }
          break;
        }

        case 'session.updated': {
          const info = readSessionInfo(event);
          if (info) {
            // OpenCode auto-titles after the first message via session.updated.
            // Capture the previous title before local cache mutation so we only
            // force the server-owned mirror read when the title actually changed.
            const prevTitle =
              queryClient
                .getQueryData<Session[]>(opencodeKeys.sessions())
                ?.find((s) => s.id === info.id)?.title ??
              queryClient.getQueryData<Session>(opencodeKeys.session(info.id))?.title ??
              null;
            const titleChanged = !!info.title && info.title !== prevTitle;
            // Only update individual session cache (cheap, targeted)
            queryClient.setQueryData(opencodeKeys.session(info.id), info);
            // Update session list only if the session actually changed
            queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
              if (!old) return old;
              const idx = old.findIndex((s) => s.id === info.id);
              if (idx < 0) return old;
              // Shallow check: skip only if BOTH the timestamp and the title are
              // unchanged. Title alone can flip (opencode auto-titles) without a
              // perceptible time bump, and dropping that would keep the tab stale.
              if (old[idx].time.updated === info.time.updated && old[idx].title === info.title)
                return old;
              const next = [...old];
              next[idx] = info;
              return next.sort((a, b) => b.time.updated - a.time.updated);
            });
            if (titleChanged) refetchKortixSessionMirrors(queryClient);
          }
          break;
        }

        case 'session.deleted': {
          const info = readSessionInfo(event);
          if (info) {
            queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
              if (!old) return old;
              const found = old.some((s) => s.id === info.id);
              if (!found) return old;
              return old.filter((s) => s.id !== info.id);
            });
            queryClient.removeQueries({ queryKey: opencodeKeys.session(info.id) });
            queryClient.removeQueries({ queryKey: opencodeKeys.messages(info.id) });
            deleteSessionFromIDB(info.id);
          }
          break;
        }

        case 'session.compacted': {
          const sessionID = (event.properties as any).sessionID;
          if (sessionID) {
            stopCompaction(sessionID);
            const client = getClient();
            client.session
              .messages({ sessionID })
              .then((res) => {
                if (res.data) {
                  useSyncStore.getState().hydrate(sessionID, res.data as any);
                  const s = useSyncStore.getState();
                  const msgs = s.messages[sessionID] ?? [];
                  if (msgs.length > 0) saveSessionToIDB(sessionID, msgs, s.parts);
                }
              })
              .catch(() => {});
            // Refetch the individual session to clear time.compacting
            // (targeted refetch, not full session list invalidation)
            client.session
              .get({ sessionID })
              .then((res) => {
                if (res.data) {
                  const session = res.data as Session;
                  queryClient.setQueryData(opencodeKeys.session(sessionID), session);
                  // Also update in session list
                  queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
                    if (!old) return old;
                    const idx = old.findIndex((s) => s.id === sessionID);
                    if (idx < 0) return old;
                    const next = [...old];
                    next[idx] = session;
                    return next;
                  });
                }
              })
              .catch(() => {});
          }
          break;
        }

        // ---- Session status ----
        case 'session.status': {
          const { sessionID, status } = event.properties as any;
          if (sessionID && status) {
            // Detect busy/retry → idle transition BEFORE updating the store
            // (coalescing can drop intermediate busy events, so we check here)
            const prevStatus = useSyncStore.getState().sessionStatus[sessionID];
            if (status.type === 'idle' && prevStatus && prevStatus.type !== 'idle') {
              notifyTaskComplete(sessionID, getSessionTitle(sessionID));
              // Agent finished editing files — refresh the Changes panel.
              // Nothing else invalidates git status for agent-driven edits,
              // so without this the panel shows stale diff state.
              queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
              queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
            }
          }
          break;
        }

        case 'session.idle': {
          const sessionID = (event.properties as any).sessionID;
          if (sessionID) {
            const prevStatus = useSyncStore.getState().sessionStatus[sessionID];
            if (prevStatus && prevStatus.type !== 'idle') {
              notifyTaskComplete(sessionID, getSessionTitle(sessionID));
              // Agent finished editing files — refresh the Changes panel.
              // Nothing else invalidates git status for agent-driven edits,
              // so without this the panel shows stale diff state.
              queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
              queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
              // Persist final session state to IDB when streaming completes
              const s = useSyncStore.getState();
              const msgs = s.messages[sessionID] ?? [];
              if (msgs.length > 0) saveSessionToIDB(sessionID, msgs, s.parts);
            }
          }
          break;
        }

        // ---- Session errors ----
        case 'session.error': {
          const props = event.properties as { sessionID?: string; error?: any };
          if (props.sessionID && props.error) {
            stopCompaction(props.sessionID);
            // Fire browser notification
            const errorTitle =
              props.error?.name || props.error?.data?.message || 'An error occurred';
            notifySessionError(props.sessionID, errorTitle, getSessionTitle(props.sessionID));

            // Patch the error onto the last assistant message in cache.
            // This is critical because:
            // 1. session.error arrives BEFORE message.updated with .error
            // 2. Some error paths (model-not-found, agent-not-found) never
            //    emit message.updated with .error at all
            // 3. Polling can race and overwrite the error from message.updated
            const key = opencodeKeys.messages(props.sessionID);
            queryClient.cancelQueries({ queryKey: key });
            queryClient.setQueryData<MessageWithParts[]>(key, (old) => {
              if (!old || old.length === 0) return old;
              // Find the last assistant message and patch error onto it
              for (let i = old.length - 1; i >= 0; i--) {
                if (old[i].info.role === 'assistant') {
                  if ((old[i].info as any).error) return old; // already has error
                  const updated = [...old];
                  updated[i] = {
                    ...old[i],
                    info: { ...old[i].info, error: props.error } as any,
                  };
                  return updated;
                }
              }
              return old;
            });

            // Fetch real messages from the server to bring in
            // authoritative data. In error paths the server may never
            // send message.updated for the user message, leaving the
            // optimistic duplicate. After hydrating server data,
            // clear any optimistic messages (now superseded by real
            // ones) to prevent double user bubbles.
            //
            // EXCEPTION: On abort, skip the fetch+hydrate — the server
            // may not have persisted the partial assistant response yet,
            // so hydrating would wipe the streamed content the user saw.
            // The error is already patched onto the message above.
            const isAbortError =
              props.error?.name === 'AbortError' ||
              String(props.error?.data?.message || props.error?.message || '')
                .toLowerCase()
                .includes('abort');
            const sid = props.sessionID;
            if (!isAbortError) {
              client.session
                .messages({ sessionID: sid })
                .then((res) => {
                  if (!res.data) return;
                  useSyncStore.getState().hydrate(sid, res.data as any);
                  useSyncStore.getState().clearOptimisticMessages(sid);
                  const s = useSyncStore.getState();
                  const msgs = s.messages[sid] ?? [];
                  if (msgs.length > 0) saveSessionToIDB(sid, msgs, s.parts);
                })
                .catch(() => {});
            } else {
              // Still clear optimistic messages on abort — the real
              // user message should have arrived via SSE by now.
              useSyncStore.getState().clearOptimisticMessages(sid);
            }
          }
          break;
        }

        // ---- Permissions ----
        case 'permission.asked': {
          const props = event.properties as any;
          if (props.id && props.sessionID) {
            addPermission(props);
            // Fire browser notification for permission requests
            const toolName = props.tool || props.type || 'a tool';
            notifyPermissionRequest(props.sessionID, toolName, getSessionTitle(props.sessionID));
          }
          break;
        }
        case 'permission.replied': {
          const requestID = (event.properties as any).requestID;
          if (requestID) removePermission(requestID);
          break;
        }

        // ---- Questions ----
        case 'question.asked': {
          const props = event.properties as any;
          if (props.id && props.sessionID) {
            addQuestion(props);
            // Fire browser notification for questions needing user input
            const questionText =
              props.questions?.[0]?.question ||
              props.questions?.[0]?.header ||
              'Kortix needs your input';
            notifyQuestion(props.sessionID, questionText, getSessionTitle(props.sessionID));
          }
          break;
        }
        case 'question.replied':
        case 'question.rejected': {
          const requestID = (event.properties as any).requestID;
          if (requestID) removeQuestion(requestID);
          break;
        }

        // ---- Session diff ----
        case 'session.diff': {
          const props = event.properties as { sessionID: string; diff: any[] };
          if (props.sessionID) {
            queryClient.setQueryData(['opencode', 'session-diff', props.sessionID], props.diff);
          }
          break;
        }

        // ---- Todo updated ----
        case 'todo.updated': {
          const props = event.properties as { sessionID: string; todos: any[] };
          if (props.sessionID) {
            queryClient.setQueryData(['opencode', 'session-todo', props.sessionID], props.todos);
          }
          break;
        }

        // ---- VCS branch ----
        case 'vcs.branch.updated': {
          const props = event.properties as { branch: string };
          queryClient.setQueryData(['opencode', 'vcs'], {
            branch: props.branch,
          });
          break;
        }

        // ---- Server disposed ----
        case 'server.instance.disposed': {
          for (const [sessionID, status] of Object.entries(useSyncStore.getState().sessionStatus)) {
            if (status?.type !== 'idle') {
              markSessionAbortedLocally.current(
                sessionID,
                'The operation was aborted because the server instance was disposed.',
              );
            }
          }
          // Instance dispose means the server rescanned skills, agents,
          // tools, and commands. Invalidate all cached app metadata so
          // the UI picks up newly installed marketplace components or
          // agent-created skills/agents immediately.
          queryClient.invalidateQueries({ queryKey: opencodeKeys.sessions(), type: 'active' });
          queryClient.invalidateQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
          queryClient.invalidateQueries({ queryKey: opencodeKeys.skills(), type: 'active' });
          queryClient.invalidateQueries({ queryKey: opencodeKeys.agents(), type: 'active' });
          queryClient.invalidateQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
          queryClient.invalidateQueries({ queryKey: opencodeKeys.commands(), type: 'active' });
          break;
        }

        // ---- LSP updated ----
        case 'lsp.updated': {
          queryClient.invalidateQueries({ queryKey: ['opencode', 'lsp'], type: 'active' });
          // A new LSP client connected — fetch diagnostics after a short
          // delay to give the language server time to produce initial results.
          fetchLspDiagnosticsDebounced.current();
          break;
        }

        // ---- LSP client diagnostics (per-file notification) ----
        case 'lsp.client.diagnostics': {
          // This event signals diagnostics changed for a specific file.
          // The event only carries { serverID, path } — actual diagnostic
          // data must be fetched from the /lsp/diagnostics endpoint.
          fetchLspDiagnosticsDebounced.current();
          break;
        }

        // ---- MCP tools changed ----
        case 'mcp.tools.changed': {
          // MCP server tools were added/removed/changed — refresh status + tool lists.
          // Only refetch if queries are actively mounted (type: 'active').
          queryClient.refetchQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
          queryClient.refetchQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
          break;
        }

        // ---- PTY events ----
        case 'pty.created':
        case 'pty.updated':
        case 'pty.exited':
        case 'pty.deleted': {
          queryClient.invalidateQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
          break;
        }

        // ---- Worktree events — disabled for now ----
        case 'worktree.ready': {
          queryClient.invalidateQueries({ queryKey: opencodeKeys.worktrees(), type: 'active' });
          queryClient.invalidateQueries({ queryKey: opencodeKeys.projects(), type: 'active' });
          break;
        }

        case 'worktree.failed': {
          queryClient.invalidateQueries({ queryKey: opencodeKeys.worktrees(), type: 'active' });
          break;
        }

        // ---- Project updated ----
        case 'project.updated': {
          // Targeted refetch — project data is small and changes rarely,
          // but OpenCode can emit bursts while tools are running. Coalesce
          // these so a burst cannot spam /project/current.
          scheduleProjectMetadataRefetch(queryClient);
          break;
        }

        // ---- File edited (outside agent, e.g. user edits in editor) ----
        case 'file.edited': {
          const fileProps = event.properties as { file?: string };
          queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
          queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
          if (fileProps.file) {
            queryClient.invalidateQueries({ queryKey: fileContentKeys.all, type: 'active' });
          }
          break;
        }

        // ---- Installation events ----
        case 'installation.updated': {
          const installProps = event.properties as { version?: string };
          const versionStr = installProps.version ? ` (v${installProps.version})` : '';
          infoToast(`Installation updated${versionStr}. Restart to apply changes.`, {
            duration: 10_000,
          });
          break;
        }

        case 'installation.update-available': {
          const updateProps = event.properties as { version?: string };
          const versionLabel = updateProps.version ? `v${updateProps.version}` : 'A new version';
          infoToast(`${versionLabel} is available. Update when you're ready.`, {
            duration: 15_000,
          });
          break;
        }

        default:
          break;
      }
    }

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

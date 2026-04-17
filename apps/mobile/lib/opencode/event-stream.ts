/**
 * OpenCode SSE Event Stream Hook for React Native
 *
 * Uses react-native-sse for EventSource support since React Native
 * doesn't have native EventSource or fetch streaming.
 */

import { useEffect, useRef, useCallback } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import EventSource from 'react-native-sse';
import { log } from '@/lib/logger';
import { getAuthToken } from '@/api/config';
import { useSyncStore, isOptimistic, clearDeltaActiveParts } from './sync-store';
import { platformKeys } from '@/lib/platform/hooks';
import { useCompactionStore } from '@/stores/compaction-store';
import type { MessageWithParts, Part, SessionStatus } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SSEEvent {
  type: string;
  properties: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Connect to the OpenCode SSE event stream.
 * Should be mounted ONCE at the app level, after sandbox is ready.
 */
// Heartbeat — if no events arrive for this long, force a reconnect. Matches
// the web consumer (apps/web/src/hooks/opencode/use-opencode-events.ts).
// This is the primary stall-recovery mechanism; mobile has no other watchdog.
const HEARTBEAT_TIMEOUT_MS = 15_000;

// Gap (ms) after which a reconnect triggers a full message re-hydrate. Events
// missed during SSE downtime (e.g. streaming assistant response) would never
// arrive, leaving the UI stale until manual refresh. Matches web a6e2d03.
const REHYDRATE_GAP_MS = 5_000;

export function useOpenCodeEventStream(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();
  const syncStore = useSyncStore;
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttempts = useRef(0);
  const lastEventTime = useRef(Date.now());
  const heartbeatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const sandboxUrlRef = useRef<string | undefined>(sandboxUrl);
  sandboxUrlRef.current = sandboxUrl;

  // Re-fetch messages for every session currently in the store. Called after
  // SSE reconnects that follow a significant gap — any streaming events that
  // landed while the connection was down would otherwise be lost.
  const rehydrateLoadedSessions = useCallback(async () => {
    const url = sandboxUrlRef.current;
    if (!url) return;
    const sessionIds = Object.keys(useSyncStore.getState().messages);
    if (sessionIds.length === 0) return;

    log.log(`🔄 [SSE] Re-hydrating ${sessionIds.length} session(s) after gap`);

    let token: string | null = null;
    try {
      token = await getAuthToken();
    } catch {
      return;
    }

    await Promise.allSettled(
      sessionIds.map(async (sid) => {
        try {
          const res = await fetch(`${url}/session/${sid}/message`, {
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
          });
          if (!res.ok) return;
          const messages: MessageWithParts[] = await res.json();
          if (!mountedRef.current) return;
          useSyncStore.getState().hydrate(sid, messages);
        } catch {
          // ignore per-session failures — individual sessions will recover
          // on their own through later SSE events
        }
      }),
    );
  }, []);

  const handleEvent = useCallback((event: SSEEvent) => {
    const { type, properties: props } = event;
    lastEventTime.current = Date.now();

    switch (type) {
      case 'message.updated': {
        const info = props.info;
        const sessionId = info?.sessionID;
        if (!sessionId || !info) break;

        const state = syncStore.getState();
        const existing = state.messages[sessionId] || [];

        // When a real user message arrives from the server, remove
        // optimistic user messages. Carry over optimistic parts as fallback
        // until real parts arrive via message.part.updated.
        if (info.role === 'user' && !isOptimistic(info.id)) {
          const optimisticMsgs = existing.filter(
            (m) => m.info.role === 'user' && isOptimistic(m.info.id),
          );
          if (optimisticMsgs.length > 0) {
            // Preserve parts from the optimistic message so the bubble
            // doesn't go blank while waiting for message.part.updated
            const fallbackParts = optimisticMsgs[0]?.parts ?? [];
            const optimisticIdSet = new Set(optimisticMsgs.map((m) => m.info.id));
            const withoutOptimistic = existing.filter(
              (m) => !optimisticIdSet.has(m.info.id),
            );
            syncStore.setState({
              messages: {
                ...syncStore.getState().messages,
                [sessionId]: [
                  ...withoutOptimistic,
                  { info, parts: fallbackParts },
                ],
              },
            });
            break;
          }
        }

        // For non-optimistic swaps: preserve existing parts
        const existingMsg = existing.find((m) => m.info.id === info.id);
        state.upsertMessage(sessionId, {
          info,
          parts: existingMsg?.parts || [],
        });
        break;
      }

      case 'message.removed': {
        const { sessionID, messageID } = props;
        if (sessionID && messageID) {
          syncStore.getState().removeMessage(sessionID, messageID);
        }
        break;
      }

      case 'message.part.updated': {
        const part = props.part || props;
        const messageID = part?.messageID || props.messageID;
        if (!messageID || !part) break;

        const sessionID = part.sessionID || props.sessionID;

        // If the parent message doesn't exist yet, create a stub
        // (parts can arrive before message.updated)
        if (sessionID) {
          const state = syncStore.getState();
          const msgs = state.messages[sessionID];
          if (!msgs || !msgs.some((m) => m.info.id === messageID)) {
            state.upsertMessage(sessionID, {
              info: {
                id: messageID,
                sessionID,
                role: 'assistant',
                time: { created: Date.now() },
              },
              parts: [],
            });
          }
        }

        // Remove messageID/sessionID from the part object
        const { messageID: _mid, sessionID: _sid, ...cleanPart } = part;
        syncStore.getState().upsertPart(messageID, cleanPart as Part);
        break;
      }

      case 'message.part.removed': {
        const { messageID, partID } = props;
        if (messageID && partID) {
          syncStore.getState().removePart(messageID, partID);
        }
        break;
      }

      case 'message.part.delta': {
        const { messageID, partID, sessionID, field, delta } = props;
        if (messageID && partID && sessionID && field && delta) {
          // Ensure the parent message exists before applying the delta.
          // message.part.delta can arrive before message.updated —
          // without a stub message, appendPartDelta silently drops
          // the delta, causing the beginning of streamed text to be lost.
          const state = syncStore.getState();
          const msgs = state.messages[sessionID];
          const msgExists = msgs?.some((m) => m.info.id === messageID);
          if (!msgExists) {
            // Only create the stub if a user message already exists
            // for this session (avoids turn-grouping issues on refresh)
            const hasUserMsg = msgs?.some((m) => m.info.role === 'user');
            if (hasUserMsg) {
              state.upsertMessage(sessionID, {
                info: {
                  id: messageID,
                  sessionID,
                  role: 'assistant',
                  time: { created: Date.now() },
                },
                parts: [],
              });
            }
          }
          syncStore.getState().appendPartDelta(messageID, partID, sessionID, field, delta);
        }
        break;
      }

      case 'session.status': {
        const { sessionID, status } = props;
        if (sessionID && status) {
          log.log(`📊 [SSE] session.status: ${sessionID} → ${JSON.stringify(status)}`);
          syncStore.getState().setStatus(sessionID, status as SessionStatus);
        }
        break;
      }

      // session.idle is sent when the session finishes processing.
      // Without this, the UI stays in "Working" state forever.
      case 'session.idle': {
        const { sessionID } = props;
        if (sessionID) {
          log.log(`✅ [SSE] session.idle: ${sessionID}`);
          syncStore.getState().setStatus(sessionID, { type: 'idle' });
          // Stop compacting indicator if it was running (covers error cases
          // where session.compacted never fires but session goes idle).
          useCompactionStore.getState().stopCompaction(sessionID);
          // Streaming finished — clear delta tracking so future
          // message.part.updated snapshots are accepted normally.
          clearDeltaActiveParts();
        }
        break;
      }

      case 'session.created':
        queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
        break;

      case 'session.updated': {
        // session.updated carries the full Session object — either directly
        // in properties (the session IS the properties) or nested under
        // properties.info. Try both paths.
        const info = props.info || props;
        const sessionID = info?.id || props.sessionID;
        log.log(`📝 [SSE] session.updated: id=${sessionID}, title="${info?.title}", keys=${Object.keys(props).join(',')}`);
        if (sessionID) {
          // Direct cache update with session data (if we have the full object)
          if (info?.title !== undefined) {
            queryClient.setQueryData(platformKeys.session(sessionID), info);
          }
          // Always invalidate both queries to ensure fresh data
          queryClient.invalidateQueries({ queryKey: platformKeys.session(sessionID) });
          queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
        } else {
          queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
        }
        break;
      }

      case 'session.deleted': {
        const info = props.info;
        if (info?.id) {
          queryClient.removeQueries({ queryKey: platformKeys.session(info.id) });
        }
        queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
        break;
      }

      case 'session.compacted': {
        if (props.sessionID && sandboxUrl) {
          const compactedSessionId = props.sessionID;
          // Stop the compacting UI indicator
          useCompactionStore.getState().stopCompaction(compactedSessionId);
          // Full refetch after compaction — messages changed significantly.
          // Rehydrate the sync store (single source of truth for messages).
          getAuthToken().then((token) => {
            fetch(`${sandboxUrl}/session/${compactedSessionId}/message`, {
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
            })
              .then((res) => res.ok ? res.json() : null)
              .then((messages) => {
                if (messages) {
                  syncStore.getState().hydrate(compactedSessionId, messages);
                }
              })
              .catch(() => {});
          });

          queryClient.invalidateQueries({
            queryKey: platformKeys.sessionMessages(compactedSessionId),
          });
          queryClient.invalidateQueries({
            queryKey: platformKeys.session(compactedSessionId),
          });
        }
        break;
      }

      case 'permission.asked':
        if (props.sessionID) syncStore.getState().addPermission(props.sessionID, props as any);
        break;
      case 'permission.replied':
        if (props.sessionID && props.id) syncStore.getState().removePermission(props.sessionID, props.id);
        break;
      case 'question.asked':
        log.log('❓ [SSE] question.asked:', props.id, 'session:', props.sessionID, 'keys:', Object.keys(props));
        if (props.sessionID) {
          syncStore.getState().addQuestion(props.sessionID, props as any);
          log.log('❓ [SSE] Added question to store, current count:', (syncStore.getState().questions[props.sessionID] || []).length);
        }
        break;
      case 'question.replied':
      case 'question.rejected':
        log.log('❓ [SSE]', type, ':', props.id, 'session:', props.sessionID);
        if (props.sessionID && props.id) syncStore.getState().removeQuestion(props.sessionID, props.id);
        break;

      case 'session.error':
        if (props.sessionID) {
          log.error(`❌ [SSE] Session error in ${props.sessionID}:`, props.error);
          // Set status to idle so the UI stops showing "Working"
          syncStore.getState().setStatus(props.sessionID, { type: 'idle' });
          // Stop compacting indicator if it was running
          useCompactionStore.getState().stopCompaction(props.sessionID);
          clearDeltaActiveParts();
        }
        break;

      default:
        // Silently ignore known heartbeat/internal events to avoid log spam
        if (type !== 'server.heartbeat') {
          log.log(`📨 [SSE] Unhandled event: ${type}`);
        }
        break;
    }
  }, [queryClient]);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearTimeout(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(async () => {
    if (!sandboxUrl || !mountedRef.current) return;

    // Clean up existing
    clearHeartbeat();
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    try {
      const token = await getAuthToken();
      const url = `${sandboxUrl}/global/event`;

      log.log('🔌 [SSE] Connecting to:', url);

      const es = new EventSource(url, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      esRef.current = es;

      // Reset the heartbeat timer on any server activity (event or keepalive).
      // If nothing arrives for HEARTBEAT_TIMEOUT_MS we assume the stream is
      // stalled (network blip, proxy idle edge case) and force a reconnect.
      const resetHeartbeat = () => {
        if (!mountedRef.current) return;
        clearHeartbeat();
        heartbeatTimerRef.current = setTimeout(() => {
          if (!mountedRef.current) return;
          log.warn('⚠️ [SSE] Heartbeat timeout, forcing reconnect');
          es.close();
          esRef.current = null;
          scheduleReconnect();
        }, HEARTBEAT_TIMEOUT_MS);
      };

      es.addEventListener('open', () => {
        log.log('✅ [SSE] Connected');
        // If this `open` followed a significant gap, any events emitted
        // while we were disconnected were dropped. Re-hydrate loaded
        // sessions so streaming responses appear without a manual refresh.
        // Note: we intentionally check the gap BEFORE updating
        // lastEventTime so the very first connection (gap measured from
        // hook mount) doesn't force an unnecessary re-hydrate.
        const gap = Date.now() - lastEventTime.current;
        const isReconnect = reconnectAttempts.current > 0;
        reconnectAttempts.current = 0;
        resetHeartbeat();
        if (isReconnect && gap > REHYDRATE_GAP_MS) {
          rehydrateLoadedSessions();
        }
      });

      es.addEventListener('message', (evt: any) => {
        // Any message (including empty keepalives) counts as server activity.
        resetHeartbeat();
        if (!evt?.data) return;
        try {
          const raw = JSON.parse(evt.data);
          // SSE wire format is GlobalEvent: { directory, payload: { type, properties } }
          // Unwrap the payload to get the actual event, matching the web frontend SDK.
          const parsed: SSEEvent =
            raw && typeof raw === 'object' && 'payload' in raw
              ? raw.payload
              : raw;
          if (!parsed?.type) return; // skip heartbeats / malformed
          handleEvent(parsed);
        } catch {
          // Ignore parse errors (heartbeats, etc.)
        }
      });

      es.addEventListener('error', (evt: any) => {
        if (!mountedRef.current) return;
        log.warn('⚠️ [SSE] Connection error:', evt?.message || 'unknown');
        clearHeartbeat();
        es.close();
        esRef.current = null;
        scheduleReconnect();
      });
    } catch (error: any) {
      log.error('❌ [SSE] Failed to connect:', error?.message || error);
      scheduleReconnect();
    }
  }, [sandboxUrl, handleEvent, clearHeartbeat, rehydrateLoadedSessions]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);

    const delay = Math.min(250 * Math.pow(2, reconnectAttempts.current), 30000);
    reconnectAttempts.current++;

    log.log(`🔄 [SSE] Reconnecting in ${delay}ms (attempt ${reconnectAttempts.current})`);

    reconnectTimeoutRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    mountedRef.current = true;
    if (sandboxUrl) connect();

    return () => {
      mountedRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    };
  }, [sandboxUrl, connect]);

  // Reconnect when app comes to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active' && sandboxUrl && mountedRef.current) {
        const gap = Date.now() - lastEventTime.current;
        if (gap > REHYDRATE_GAP_MS) {
          log.log('🔄 [SSE] App foregrounded, reconnecting');
          // Re-hydrate before the reconnect — matches web a6e2d03. Events
          // that landed while the app was backgrounded are already lost;
          // this brings loaded sessions back to the current server state.
          rehydrateLoadedSessions();
          reconnectAttempts.current = 0;
          connect();
        }
      }
    });
    return () => sub.remove();
  }, [sandboxUrl, connect, rehydrateLoadedSessions]);
}

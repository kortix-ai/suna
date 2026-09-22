/**
 * OpenCode SSE Event Stream Hook for React Native
 *
 * Uses react-native-sse for EventSource support since React Native
 * doesn't have native EventSource or fetch streaming.
 */

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AuthChangeEvent } from '@supabase/supabase-js';
import EventSource from 'react-native-sse';
import { log } from '@/lib/logger';
import { subscribeOnlineStatus } from '@/lib/network/use-online-status';
import { getAuthToken } from '@/api/config';
import { supabase } from '@/api/supabase';
import {
  useSyncStore,
  isOptimistic,
  clearDeltaActiveParts,
  clearOptimistic,
  markBridgedParts,
} from './sync-store';
import { isLiveSession, reconcileLiveSession, reconcileLiveSessions } from './session-sync';
import { createEventBatcher, type StreamEvent } from './event-batcher';
import {
  HEARTBEAT_TIMEOUT_MS,
  STREAM_STABLE_MS,
  TOKEN_TIMEOUT_MS,
  isFullSession,
  isHollowStreamEnd,
  isLivenessOnlyEvent,
  isStreamStable,
  nextRetry,
  onForeground,
  patchSessionList,
  questionsToHydrate,
  shouldReconcileOnOpen,
  shouldRecycleStream,
  type OpenCause,
} from './stream-policy';
import { platformKeys } from '@/lib/platform/hooks';
import type { Session } from '@/lib/platform/types';
import { useCompactionStore } from '@/stores/compaction-store';
import type { Part, QuestionRequest, SessionStatus } from './types';

/** Frames that only prove the connection is alive; they never reach the store. */
const IGNORED_EVENT_TYPES = new Set(['server.heartbeat', 'kortix.keepalive']);

// ---------------------------------------------------------------------------
// Event reducer
// ---------------------------------------------------------------------------

function applyEvent(event: StreamEvent, queryClient: QueryClient) {
  const { type, properties: props } = event;
  const syncStore = useSyncStore;

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
          clearOptimistic(optimisticIdSet);
          // Mark the bridge so the next real message.part.updated clears
          // these carried-over parts instead of duplicating them.
          // Mirrors web 77886a8.
          if (fallbackParts.length > 0) markBridgedParts(info.id);
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
      syncStore.getState().upsertPart(messageID, cleanPart as Part, sessionID || undefined);
      break;
    }

    case 'message.part.removed': {
      const { messageID, partID, sessionID } = props;
      if (messageID && partID) {
        syncStore.getState().removePart(messageID, partID, sessionID || undefined);
      }
      break;
    }

    case 'message.part.delta': {
      const { messageID, partID, sessionID, field, delta } = props;
      if (messageID && partID && sessionID && field && delta) {
        // Mirror web: ensure parent message + EMPTY stub part exist BEFORE
        // appending the delta. If the stub part starts with the delta as
        // its initial value (the old behavior), a later
        // `message.part.updated` snapshot carrying the full text gets
        // rejected by the prefix-growth guard in upsertPart — because the
        // snapshot doesn't start with the mid-word delta fragment, only
        // the other way around. That's why streamed text sometimes began
        // mid-word on mobile. Starting from "" keeps the guard happy.
        const state = syncStore.getState();
        const msgs = state.messages[sessionID];
        let msg = msgs?.find((m) => m.info.id === messageID);
        if (!msg) {
          // Only create the stub message if a user message already exists
          // for this session (avoids turn-grouping issues on refresh).
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
            msg = syncStore
              .getState()
              .messages[sessionID]?.find((m) => m.info.id === messageID);
          }
        }

        // Pre-create an empty stub part if it's missing, so appendPartDelta
        // appends to "" rather than initializing the part with the partial
        // delta. This matches web (apps/web/src/stores/opencode-sync-store.ts
        // line 845-850).
        if (msg && !msg.parts.some((p) => p.id === partID)) {
          syncStore.getState().upsertPart(
            messageID,
            {
              id: partID,
              type: field === 'text' ? 'text' : 'reasoning',
              [field]: '',
            } as unknown as Part,
            sessionID,
          );
        }

        syncStore.getState().appendPartDelta(messageID, partID, sessionID, field, delta);
      }
      break;
    }

    case 'session.status': {
      const { sessionID, status } = props;
      if (sessionID && status) {
        if (__DEV__) log.log(`📊 [SSE] session.status: ${sessionID} → ${JSON.stringify(status)}`);
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
      // session.updated carries the Session object — either directly in
      // properties (the session IS the properties) or nested under
      // properties.info. Try both paths.
      const info = props.info || props;
      const sessionID: string | undefined = info?.id || props.sessionID;
      if (__DEV__) {
        log.log(`📝 [SSE] session.updated: id=${sessionID}, title="${info?.title}", keys=${Object.keys(props).join(',')}`);
      }
      if (!sessionID) {
        queryClient.invalidateQueries({ queryKey: platformKeys.sessions(), exact: true });
        break;
      }
      if (isFullSession(info)) {
        // The frame IS the fresh data: write it, do not refetch it.
        queryClient.setQueryData(platformKeys.session(sessionID), info);
        let listHoldsSession = true;
        queryClient.setQueryData<Session[]>(platformKeys.sessions(), (list) => {
          if (!list) return list;
          const patched = patchSessionList(list, info as Session);
          if (!patched) listHoldsSession = false;
          return patched ?? list;
        });
        if (!listHoldsSession) {
          queryClient.invalidateQueries({ queryKey: platformKeys.sessions(), exact: true });
        }
      } else {
        queryClient.invalidateQueries({ queryKey: platformKeys.session(sessionID), exact: true });
        queryClient.invalidateQueries({ queryKey: platformKeys.sessions(), exact: true });
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
      const compactedSessionId = props.sessionID;
      if (compactedSessionId) {
        // Stop the compacting UI indicator
        useCompactionStore.getState().stopCompaction(compactedSessionId);
        // Messages changed significantly: re-read the tail page of the open
        // session. A session that is not open re-syncs when it opens.
        void reconcileLiveSession(compactedSessionId, 'compaction');

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
      if (__DEV__) {
        log.log('❓ [SSE] question.asked:', props.id, 'session:', props.sessionID, 'keys:', Object.keys(props));
      }
      if (props.sessionID) {
        syncStore.getState().addQuestion(props.sessionID, props as any);
        if (__DEV__) {
          log.log('❓ [SSE] Added question to store, current count:', (syncStore.getState().questions[props.sessionID] || []).length);
        }
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
      if (__DEV__) log.log(`📨 [SSE] Unhandled event: ${type}`);
      break;
  }
}

/**
 * One `/question` read after a reconnect gap. A `question.asked` frame sent
 * while the stream was down is lost, and the session page does not poll while
 * a session is merely busy. Adds pending questions for open sessions only,
 * the same write the session page's self-heal makes.
 */
async function hydrateQuestionsAfterGap(sandboxUrl: string, isStale: () => boolean) {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${sandboxUrl}/question`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok || isStale()) return;
    const body: unknown = await res.json();
    if (isStale()) return;
    const store = useSyncStore.getState();
    for (const question of questionsToHydrate<QuestionRequest>(body, store.questions, isLiveSession)) {
      store.addQuestion(question.sessionID, question);
    }
  } catch {
    // The next gap, or the session page's own self-heal, retries.
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Private react-native-sse 1.2.1 method (`src/EventSource.js`). The library
 * calls `_pollAgain(interval)` when a response finishes (`readyState` DONE):
 * after a clean 2xx end of the stream, and after an error response. Its own
 * implementation re-opens with the headers captured at construction, i.e. a
 * token that may have expired. Re-check this contract when upgrading.
 */
interface EventSourceInternals {
  _pollAgain?: (time: number, allowZero: boolean) => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Connect to the OpenCode SSE event stream.
 * Should be mounted ONCE at the app level, after sandbox is ready.
 *
 * Connection policy (constants and decisions in `stream-policy.ts`):
 * - one reconnect scheduler for every loss: error, watchdog timeout, clean
 *   server end (`_pollAgain` override), library close; each attempt reads a
 *   fresh token and a generation guard keeps a single live connection;
 * - a clean end within `HOLLOW_STREAM_END_MS` of open with no real event
 *   counts as a hard failure (a stale daemon answering with HTML);
 * - watchdog: no frame for `HEARTBEAT_TIMEOUT_MS` forces a reconnect; paused
 *   while the app is not active;
 * - after an interrupted connection reopens past the gap threshold, or after a
 *   recycle, the live sessions re-read one tail page each and `/question` is
 *   read once;
 * - past `STREAM_RECYCLE_BYTES` the connection is recycled, because the XHR
 *   transport keeps the whole body in memory;
 * - backoff has jitter; after `MAX_HARD_FAILURES` consecutive failures the
 *   stream parks and probes once per `PARKED_RETRY_MS`; foreground, offline →
 *   online, and a new `sandboxUrl` retry at once;
 * - 401/403 halts until Supabase refreshes the token or `sandboxUrl` changes.
 */
export function useOpenCodeEventStream(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sandboxUrl) return;

    let disposed = false;
    let es: EventSource | null = null;
    let streamOpen = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let recycleTimer: ReturnType<typeof setTimeout> | null = null;
    let stableTimer: ReturnType<typeof setTimeout> | null = null;
    let connectGeneration = 0;
    let reconnectAttempts = 0;
    let hardFailures = 0;
    let parked = false;
    // Reconnecting can't fix an authorization failure (stale/foreign sandbox),
    // so this halts reconnects until the token refreshes or sandboxUrl changes.
    let authFailed = false;
    // Why the next `open` happens; decides whether it reconciles.
    let openCause: OpenCause = 'initial';
    let lastFrameAt = Date.now();
    let connectStartedAt = Date.now();
    let openedAt = 0;
    let charsSinceOpen = 0;
    let sawEvent = false;
    let stable = false;
    let appActive = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';

    // Event batching: queue SSE events and apply them at most once per
    // FLUSH_INTERVAL_MS (status changes on the next tick). Applying every raw
    // delta saturated the JS thread and blocked tab switches / drawer opens
    // while the assistant was streaming.
    const batcher = createEventBatcher({
      apply: (events) => {
        if (disposed) return;
        for (const event of events) applyEvent(event, queryClient);
      },
    });

    const quietForMs = () => Date.now() - Math.max(lastFrameAt, connectStartedAt);

    /** A lost connection replaces the first one: its open checks the gap. */
    const markInterrupted = () => {
      if (openCause === 'initial') openCause = 'interrupted';
    };

    const clearHeartbeat = () => {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    // One timer per connection instead of one per frame: when it fires it
    // re-arms for the remaining window if a frame arrived meanwhile.
    const armHeartbeat = (delayMs: number) => {
      clearHeartbeat();
      if (disposed || !appActive || !es) return;
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        if (disposed || !es) return;
        const quiet = quietForMs();
        if (quiet < HEARTBEAT_TIMEOUT_MS) {
          armHeartbeat(HEARTBEAT_TIMEOUT_MS - quiet);
          return;
        }
        log.warn('⚠️ [SSE] Heartbeat timeout, forcing reconnect');
        teardown();
        onFailure();
      }, Math.max(0, delayMs));
    };

    const teardown = () => {
      clearHeartbeat();
      if (recycleTimer) {
        clearTimeout(recycleTimer);
        recycleTimer = null;
      }
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      streamOpen = false;
      if (es) {
        // Listeners first: `close()` dispatches `close`, and the library can
        // still deliver a buffered error after it.
        es.removeAllEventListeners();
        es.close();
        es = null;
      }
    };

    /** The connection proved itself: reset backoff and failure counts. */
    const markStable = () => {
      if (stable || !isStreamStable({ openForMs: Date.now() - openedAt, sawEvent })) return;
      stable = true;
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      reconnectAttempts = 0;
      hardFailures = 0;
    };

    /** Idempotent: a pending retry is kept, never doubled. */
    const scheduleRetry = () => {
      if (disposed || authFailed || reconnectTimer) return;
      const retry = nextRetry({ attempt: reconnectAttempts, hardFailures, rand: Math.random() });
      if (retry.parked && !parked) {
        log.warn(`🅿️ [SSE] ${hardFailures} consecutive failures; parked, probing every ${retry.delayMs}ms`);
      }
      parked = retry.parked;
      reconnectAttempts++;
      log.log(`🔄 [SSE] Reconnecting in ${retry.delayMs}ms (attempt ${reconnectAttempts})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, retry.delayMs);
    };

    const onFailure = () => {
      markInterrupted();
      hardFailures++;
      scheduleRetry();
    };

    /** The server or the library ended the response without an error. */
    const onStreamEnded = () => {
      const hollow = isHollowStreamEnd({
        openForMs: streamOpen ? Date.now() - openedAt : 0,
        sawEvent,
      });
      teardown();
      if (hollow) {
        log.warn('⚠️ [SSE] Stream ended right after open without an event; counting as a failure');
        onFailure();
        return;
      }
      log.log('🔚 [SSE] Stream ended by server, reconnecting');
      markInterrupted();
      scheduleRetry();
    };

    /** Reconnect now, forgetting backoff and park (foreground, back online). */
    const retryNow = () => {
      parked = false;
      hardFailures = 0;
      reconnectAttempts = 0;
      if (authFailed) return;
      markInterrupted();
      void connect();
    };

    const recycle = () => {
      recycleTimer = null;
      if (disposed || !es) return;
      log.log(`♻️ [SSE] Recycling stream after ${charsSinceOpen} chars`);
      batcher.flush();
      teardown();
      openCause = 'recycle';
      lastFrameAt = Date.now();
      void connect();
    };

    const connect = async () => {
      if (disposed || authFailed) return;
      teardown();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const generation = ++connectGeneration;
      connectStartedAt = Date.now();

      let token: string | null;
      try {
        // Bounded: a hung auth call must not leave the stream dead with no
        // watchdog armed.
        token = await withTimeout(getAuthToken(), TOKEN_TIMEOUT_MS);
      } catch (error) {
        if (disposed || generation !== connectGeneration) return;
        log.error('❌ [SSE] Failed to connect:', error instanceof Error ? error.message : String(error));
        onFailure();
        return;
      }
      if (disposed || generation !== connectGeneration) return;

      const url = `${sandboxUrl}/global/event`;
      log.log('🔌 [SSE] Connecting to:', url);

      const source = new EventSource(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        // With the `_pollAgain` override below the library calls into this
        // hook on every finished response whatever this value is. 0 keeps the
        // library from ever re-opening by itself if the override is missing.
        pollingInterval: 0,
        timeoutBeforeConnection: 0,
      });
      // The constructor has already scheduled the first open; overriding now
      // only redirects the library's later re-open calls.
      const internals = source as unknown as EventSourceInternals;
      if (typeof internals._pollAgain === 'function') {
        internals._pollAgain = () => {
          if (disposed || es !== source) return;
          onStreamEnded();
        };
      }
      es = source;
      charsSinceOpen = 0;
      sawEvent = false;
      stable = false;
      // Also bounds a connect that never answers.
      armHeartbeat(HEARTBEAT_TIMEOUT_MS);

      source.addEventListener('open', () => {
        if (disposed || es !== source) return;
        log.log('✅ [SSE] Connected');
        const gapMs = Date.now() - lastFrameAt;
        const reconcile = shouldReconcileOnOpen({ cause: openCause, gapMs });
        openCause = 'interrupted';
        streamOpen = true;
        parked = false;
        openedAt = Date.now();
        lastFrameAt = openedAt;
        armHeartbeat(HEARTBEAT_TIMEOUT_MS);
        stableTimer = setTimeout(() => {
          stableTimer = null;
          if (!disposed && es === source) markStable();
        }, STREAM_STABLE_MS);
        if (reconcile) {
          // Events emitted while disconnected were dropped. Re-read one tail
          // page per open session and pending questions once.
          log.log(`🔄 [SSE] Reopened after ${Math.round(gapMs / 1000)}s; reconciling`);
          void reconcileLiveSessions('sse-gap', sandboxUrl);
          void hydrateQuestionsAfterGap(sandboxUrl, () => disposed);
        }
      });

      source.addEventListener('message', (evt) => {
        if (disposed || es !== source) return;
        // Any frame (including keepalives) counts as server activity.
        lastFrameAt = Date.now();
        const data = evt.data;
        if (!data) return;
        charsSinceOpen += data.length;
        try {
          const raw = JSON.parse(data);
          // SSE wire format is GlobalEvent: { directory, payload: { type, properties } }
          // Unwrap the payload to get the actual event, matching the web frontend SDK.
          const parsed: StreamEvent =
            raw && typeof raw === 'object' && 'payload' in raw
              ? raw.payload
              : raw;
          if (parsed?.type) {
            if (!stable && !isLivenessOnlyEvent(parsed.type)) {
              sawEvent = true;
              markStable();
            }
            if (!IGNORED_EVENT_TYPES.has(parsed.type)) batcher.enqueue(parsed);
          }
        } catch {
          // Ignore parse errors (heartbeats, etc.)
        }
        if (!recycleTimer && shouldRecycleStream(charsSinceOpen)) {
          // After this dispatch: the library delivers the rest of the current
          // network chunk synchronously, and closing now would drop it.
          recycleTimer = setTimeout(recycle, 0);
        }
      });

      source.addEventListener('error', (evt) => {
        if (disposed || es !== source) return;
        teardown();
        // Authorization failures (401/403) are permanent for this token and
        // sandbox — retrying just spams the logs. Stop and wait.
        const status = 'xhrStatus' in evt ? evt.xhrStatus : undefined;
        if (status === 401 || status === 403) {
          log.warn(`🚫 [SSE] Not authorized for sandbox (status ${status}); halting reconnect`);
          authFailed = true;
          return;
        }
        log.warn(`⚠️ [SSE] Connection error (${evt.type}, status ${status ?? 'none'})`);
        onFailure();
      });

      // Every close this hook starts removes the listeners first, so this only
      // runs when the library closes the connection itself.
      source.addEventListener('close', () => {
        if (disposed || es !== source) return;
        onStreamEnded();
      });
    };

    const appStateSubscription = AppState.addEventListener('change', (next) => {
      if (disposed) return;
      if (next !== 'active') {
        // Timers can run late or not at all in the background; an overdue
        // watchdog firing on return would race the foreground reconnect.
        appActive = false;
        clearHeartbeat();
        return;
      }
      if (appActive) return;
      appActive = true;
      const decision = onForeground({
        streamOpen: es !== null && streamOpen,
        msSinceLastFrame: quietForMs(),
      });
      if (decision === 'none') {
        armHeartbeat(HEARTBEAT_TIMEOUT_MS - quietForMs());
        return;
      }
      log.log('🔄 [SSE] App foregrounded, reconnecting');
      retryNow();
    });

    // Connectivity came back: do not wait for the backoff or the parked probe.
    // The status source notifies only on a change, so `true` is always an
    // offline → online transition, including when this hook mounted offline.
    const unsubscribeOnline = subscribeOnlineStatus((isOnline) => {
      if (disposed || !isOnline || streamOpen) return;
      log.log('🔄 [SSE] Back online, reconnecting');
      retryNow();
    });

    // A token refresh can fix a 401: retry once with the new token.
    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
      if (disposed || !authFailed) return;
      if (event !== 'TOKEN_REFRESHED' && event !== 'SIGNED_IN') return;
      authFailed = false;
      // Deferred: supabase-js deadlocks when its own auth calls (getSession in
      // getAuthToken) run inside this callback.
      setTimeout(() => {
        if (disposed) return;
        log.log('🔑 [SSE] Token refreshed; retrying stream');
        retryNow();
      }, 0);
    });

    void connect();

    return () => {
      // Apply what is queued (e.g. a `session.idle` waiting for its tick)
      // before the reducer is disconnected.
      batcher.flush();
      disposed = true;
      teardown();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      appStateSubscription.remove();
      unsubscribeOnline();
      authSubscription.unsubscribe();
    };
  }, [sandboxUrl, queryClient]);
}

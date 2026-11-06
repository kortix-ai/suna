'use client';

import { qk } from '../query-keys';
import { activeRuntimeAction, runtimeActionError, runtimeActionPaths } from '../../core/session/runtime-actions';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../core/runtime/client';
import { markSessionFresh } from '../../core/http/fresh-sessions';
import { isRuntimeNotReadyResponse } from '../../core/http/runtime-errors';
import { useRuntimeCompactionStore } from '../../browser/stores/runtime-compaction-store';
import { useCurrentRuntime } from '../use-current-runtime';
import { useRuntimeSupports } from '../use-runtime-supports';
import type { Session } from '../../core/runtime/runtime-types';
import { runtimeKeys, useRuntimeReady } from './keys';
import { unwrap, canQueryRuntimeSession } from './shared';
import { useMemo } from 'react';
import { useSyncStore } from '../../browser/stores/sync-store';
import { logSessionRows, settledFromLog } from './log-sessions';

// ============================================================================
// Session Hooks
// ============================================================================

/** The held session logs' threads (`runtime.log.v1`, every box past the runtime floor). */
function useLogSessionRows(): Session[] | null {
  const logs = useSyncStore((state) => state.sessionLogs);
  return useMemo(() => logSessionRows(logs), [logs]);
}

/** The runtime's sessions. A box that serves its log answers them from the session log: no box read. */
export function useRuntimeSessions(enabled = true) {
  const runtimeReady = useRuntimeReady();
  const logRows = useLogSessionRows();
  // Subscribe to the active runtime sandbox so the query key recomputes the
  // instant the sandbox switches — returning to a warm session hits its cached
  // list rather than refetching from scratch.
  const serverId = useCurrentRuntime((s) => s.sandboxId) ?? undefined;
  const query = useQuery<Session[]>({
    queryKey: runtimeKeys.sessions(serverId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.list({ limit: 10000 });
      const sessions = unwrap(result);
      return sessions.sort((a: Session, b: Session) => b.time.updated - a.time.updated);
    },
    enabled: runtimeReady && enabled && logRows === null,
    staleTime: 5 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    // With the scaffold-warm seed, the runtime is ALREADY 'ok' for /workspace and a
    // root session is pinned the moment runtimeReady flips — so the first list
    // normally returns the pinned session in one shot. The only misses left are
    // the server-switch client race + the ~350ms health-poll enable lag, both of
    // which clear in one fast retry. So poll TIGHT (16 x 150ms = ~2.4s) to land
    // the first success in <300ms instead of mid-400ms-window; exponential tail
    // (cap 10s) covers the rare genuinely-stuck case. The old 8x400ms backoff
    // (~3.2s) was the entire 'runtime-listed' wall in the browser trace.
    retry: (failureCount) => failureCount < 16,
    retryDelay: (attempt) =>
      attempt < 16 ? 150 : Math.min(150 * Math.pow(2, attempt - 16), 10000),
  });
  return logRows && enabled ? settledFromLog(query, logRows) : query;
}

/** One runtime session. A box that serves its log answers it from the session log once it holds the thread. */
export function useRuntimeSession(sessionId: string) {
  const queryClient = useQueryClient();
  const runtimeReady = useRuntimeReady();
  const canQuerySession = canQueryRuntimeSession(sessionId);
  const logRows = useLogSessionRows();
  const logRow = logRows?.find((row) => row.id === sessionId);
  const query = useQuery<Session>({
    queryKey: runtimeKeys.runtimeSession(sessionId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.get({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: runtimeReady && canQuerySession && logRows === null,
    staleTime: Infinity,
    // Retry transient failures (sandbox still warming, brief network blip) so a
    // single failed lookup doesn't settle as "not found" and flash the
    // not-accessible error. The query stays in its loading state across retries.
    retry: (failureCount) => failureCount < 3,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10000),
    placeholderData: () => {
      const sessions = queryClient.getQueryData<Session[]>(runtimeKeys.sessions());
      return sessions?.find((s) => s.id === sessionId);
    },
  });
  // Until the log holds the thread the read stays pending, never "not found".
  return logRow ? settledFromLog(query, logRow) : query;
}

export function useCreateRuntimeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: { directory?: string; title?: string } | void) => {
      const opts = options || {};
      // The runtime inside the sandbox can be still booting when this fires
      // (auto-create on session page mount). The daemon answers its not-ready
      // 503 until the runtime is up. Retry that specific transient inline —
      // anything else propagates immediately.
      for (let attempt = 0; ; attempt++) {
        try {
          const client = getClient();
          const result = await client.session.create({
            directory: opts.directory,
            title: opts.title,
          });
          return unwrap(result);
        } catch (e) {
          const msg = (e as { message?: string })?.message ?? '';
          if (attempt < 6 && isRuntimeNotReadyResponse(msg)) {
            await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 4_000)));
            continue;
          }
          throw e;
        }
      }
    },
    onSuccess: (newSession) => {
      // Surgically insert into cache — SSE session.created will also fire
      // but this gives instant UI feedback. Dedup to avoid duplicate keys.
      const session = newSession as Session;
      // Mark this session as freshly created so the session page shows the
      // instant typeable shell (not the resume loader). In-memory + synchronous,
      // so it's reliably set before the create-then-navigate hop. Every create
      // path flows through this hook; resumes don't.
      markSessionFresh(session.id);
      queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
        if (!old) return [session];
        const idx = old.findIndex((s) => s.id === session.id);
        if (idx >= 0) {
          const next = [...old];
          next[idx] = session;
          return next.sort((a, b) => b.time.updated - a.time.updated);
        }
        return [session, ...old].sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(runtimeKeys.runtimeSession(session.id), session);
    },
  });
}

/** Fork the conversation at `sessionId` (the runtime's `POST /session/{id}/fork`):
 *  a new session in the same sandbox that carries the copied history up to
 *  `messageID` (every message when absent), titled `"<title> (fork #N)"`. The
 *  runtime capability is `session.fork`; a caller gates the control with
 *  `useRuntimeSupports('session.fork')` — pi does not serve it. */
export function useForkSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, messageID }: { sessionId: string; messageID?: string }) => {
      const client = getClient();
      const result = await client.session.fork({
        sessionID: sessionId,
        ...(messageID !== undefined && { messageID }),
      });
      return unwrap(result);
    },
    onSuccess: async (forkedSession) => {
      // Surgically insert into cache — SSE session.created will also fire.
      const session = forkedSession as Session;
      queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
        if (!old) return [session];
        const idx = old.findIndex((s) => s.id === session.id);
        if (idx >= 0) {
          const next = [...old];
          next[idx] = session;
          return next.sort((a, b) => b.time.updated - a.time.updated);
        }
        return [session, ...old].sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(runtimeKeys.runtimeSession(session.id), session);
      await queryClient.refetchQueries({
        predicate: (query) => qk.project.scope('').slice(0, 2).every((part, index) => query.queryKey[index] === part),
      });
    },
  });
}

/**
 * The runtime's todo list for a session. A runtime capability
 * (`session.todo`): a runtime without one (pi) is never asked, and `data`
 * stays undefined.
 * @deprecated OpenCode only: pi does not serve it; a daemon built before 2026-10-30 still can. Removed in the next major.
 */
export function useRuntimeSessionTodo(sessionId: string) {
  const runtimeReady = useRuntimeReady();
  const canQuerySession = canQueryRuntimeSession(sessionId);
  const supported = useRuntimeSupports('session.todo');
  return useQuery({
    queryKey: runtimeKeys.sessionTodo(sessionId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.todo({ sessionID: sessionId });
      const data = unwrap(result);
      return Array.isArray(data) ? data : [];
    },
    enabled: runtimeReady && canQuerySession && supported,
    staleTime: Infinity,
  });
}

// ============================================================================
// Summarize Hook
// ============================================================================

export function useSummarizeRuntimeSession() {
  const startCompaction = useRuntimeCompactionStore((s) => s.startCompaction);
  const stopCompaction = useRuntimeCompactionStore((s) => s.stopCompaction);
  return useMutation({
    mutationFn: async (params: {
      sessionId: string;
      providerID?: string;
      modelID?: string;
    }) => {
      // The box compacts with the model it runs (`runtime.actions.v1`).
      const compacted = await activeRuntimeAction('POST', runtimeActionPaths.compact(params.sessionId));
      if (!compacted.ok) throw await runtimeActionError(compacted, 'Compacting the session failed');
      return params.sessionId;
    },
    onMutate: ({ sessionId }) => {
      startCompaction(sessionId);
    },
    onError: (_err, { sessionId }) => {
      stopCompaction(sessionId);
    },
    onSuccess: (_sessionId) => {
      // SSE session.compacted event handles rehydration of messages and
      // session data. No need to invalidate here — the event handler in
      // use-runtime-events.ts fetches messages + session for that ID.
    },
  });
}

// ============================================================================
// Init Hook — analyze project and create AGENTS.md (via /init command)
// ============================================================================


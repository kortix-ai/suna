'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getClient } from '../../opencode/client';
import { isOpenCodeConfigInvalidError } from '../../platform/opencode-errors';
import { markSessionFresh } from '../../platform/fresh-sessions';
import { useOpenCodeCompactionStore } from '../../state/opencode-compaction-store';
import { useCurrentRuntime } from '../use-current-runtime';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import { unwrap, getLSCache, setLSCache, LS_SESSIONS, canQueryOpenCodeSession } from './shared';

// ============================================================================
// Session Hooks
// ============================================================================

export function useOpenCodeSessions() {
  const runtimeReady = useOpenCodeRuntimeReady();
  // Subscribe to the active runtime sandbox so the query key recomputes the
  // instant the sandbox switches — returning to a warm session hits its cached
  // list rather than refetching from scratch.
  const serverId = useCurrentRuntime((s) => s.sandboxId) ?? undefined;
  return useQuery<Session[]>({
    queryKey: opencodeKeys.sessions(serverId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.list({ limit: 10000 });
      const sessions = unwrap(result);
      const sorted = sessions.sort((a: Session, b: Session) => b.time.updated - a.time.updated);
      setLSCache(LS_SESSIONS, sorted);
      return sorted;
    },
    placeholderData: () => getLSCache<Session[]>(LS_SESSIONS),
    enabled: runtimeReady,
    staleTime: 5 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    // With the scaffold-warm seed, opencode is ALREADY 'ok' for /workspace and a
    // root session is pinned the moment runtimeReady flips — so the first list
    // normally returns the pinned session in one shot. The only misses left are
    // the server-switch client race + the ~350ms health-poll enable lag, both of
    // which clear in one fast retry. So poll TIGHT (16 x 150ms = ~2.4s) to land
    // the first success in <300ms instead of mid-400ms-window; exponential tail
    // (cap 10s) covers the rare genuinely-stuck case. The old 8x400ms backoff
    // (~3.2s) was the entire 'opencode-listed' wall in the browser trace.
    retry: (failureCount, error) =>
      !isOpenCodeConfigInvalidError(error) && failureCount < 16,
    retryDelay: (attempt) =>
      attempt < 16 ? 150 : Math.min(150 * Math.pow(2, attempt - 16), 10000),
  });
}

export function useOpenCodeSession(sessionId: string) {
  const queryClient = useQueryClient();
  const runtimeReady = useOpenCodeRuntimeReady();
  const canQuerySession = canQueryOpenCodeSession(sessionId);
  return useQuery<Session>({
    queryKey: opencodeKeys.session(sessionId),
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.get({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: runtimeReady && canQuerySession,
    staleTime: Infinity,
    // Retry transient failures (sandbox still warming, brief network blip) so a
    // single failed lookup doesn't settle as "not found" and flash the
    // not-accessible error. The query stays in its loading state across retries.
    retry: (failureCount, error) =>
      !isOpenCodeConfigInvalidError(error) && failureCount < 3,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10000),
    placeholderData: () => {
      const sessions = queryClient.getQueryData<Session[]>(opencodeKeys.sessions());
      return sessions?.find((s) => s.id === sessionId);
    },
  });
}

export function useCreateOpenCodeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (options: { directory?: string; title?: string } | void) => {
      const opts = options || {};
      // Opencode-inside-sandbox can be still booting when this fires (auto-
      // create on session page mount). The sandbox proxy returns 503 with
      // "opencode not ready" until the binary binds its port. Retry that
      // specific transient inline — anything else propagates immediately.
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
          if (attempt < 6 && /opencode not ready/i.test(msg)) {
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
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return [session];
        const idx = old.findIndex((s) => s.id === session.id);
        if (idx >= 0) {
          const next = [...old];
          next[idx] = session;
          return next.sort((a, b) => b.time.updated - a.time.updated);
        }
        return [session, ...old].sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(opencodeKeys.session(session.id), session);
    },
  });
}

export function useDeleteOpenCodeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      const client = getClient();
      const result = await client.session.delete({ sessionID: sessionId });
      unwrap(result);
      return sessionId;
    },
    onSuccess: (sessionId) => {
      // Surgically remove from cache — SSE session.deleted will also fire
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        return old.filter((s) => s.id !== sessionId);
      });
      queryClient.removeQueries({ queryKey: opencodeKeys.session(sessionId) });
      queryClient.removeQueries({ queryKey: opencodeKeys.messages(sessionId) });
    },
  });
}

export function useUpdateOpenCodeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      title,
      archived,
    }: {
      sessionId: string;
      title?: string;
      archived?: boolean;
    }) => {
      const client = getClient();
      const body: { title?: string; time?: { archived?: number } } = {};
      if (title !== undefined) body.title = title;
      if (archived !== undefined) body.time = { archived: archived ? Date.now() : 0 };
      const result = await client.session.update({ sessionID: sessionId, ...body });
      return unwrap(result);
    },
    onSuccess: (updatedSession) => {
      // Surgically update cache — SSE session.updated will also fire
      const session = updatedSession as Session;
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return old;
        const idx = old.findIndex((s) => s.id === session.id);
        if (idx < 0) return old;
        const next = [...old];
        next[idx] = session;
        return next.sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(opencodeKeys.session(session.id), session);
    },
  });
}

export function useOpenCodeSessionDiff(sessionId: string) {
  const runtimeReady = useOpenCodeRuntimeReady();
  const canQuerySession = canQueryOpenCodeSession(sessionId);
  return useQuery({
    queryKey: ['opencode', 'session-diff', sessionId],
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.diff({ sessionID: sessionId });
      return unwrap(result);
    },
    enabled: runtimeReady && canQuerySession,
    staleTime: Infinity,
  });
}

export function useOpenCodeSessionTodo(sessionId: string) {
  const runtimeReady = useOpenCodeRuntimeReady();
  const canQuerySession = canQueryOpenCodeSession(sessionId);
  return useQuery({
    queryKey: ['opencode', 'session-todo', sessionId],
    queryFn: async () => {
      const client = getClient();
      const result = await client.session.todo({ sessionID: sessionId });
      const data = unwrap(result);
      return Array.isArray(data) ? data : [];
    },
    enabled: runtimeReady && canQuerySession,
    staleTime: Infinity,
  });
}

// ============================================================================
// Summarize Hook
// ============================================================================

export function useSummarizeOpenCodeSession() {
  const queryClient = useQueryClient();
  const startCompaction = useOpenCodeCompactionStore((s) => s.startCompaction);
  const stopCompaction = useOpenCodeCompactionStore((s) => s.stopCompaction);
  return useMutation({
    mutationFn: async (params: { sessionId: string; providerID?: string; modelID?: string }) => {
      const client = getClient();

      let { providerID, modelID } = params;

      // 1. Try config default model
      if (!providerID || !modelID) {
        try {
          const configResult = await client.global.config.get();
          const config = configResult.data as any;
          if (config?.model) {
            const parts = (config.model as string).split('/');
            if (parts.length >= 2) {
              providerID = providerID || parts[0];
              modelID = modelID || parts.slice(1).join('/');
            }
          }
        } catch {
          // ignore
        }
      }

      // 2. Try to get model from the session's latest assistant message
      if (!providerID || !modelID) {
        try {
          const msgs = await client.session.messages({ sessionID: params.sessionId });
          const allMsgs = (msgs.data ?? []) as Array<{ info: { role: string; providerID?: string; modelID?: string } }>;
          for (let i = allMsgs.length - 1; i >= 0; i--) {
            const m = allMsgs[i].info;
            if (m.role === 'assistant' && m.providerID && m.modelID) {
              providerID = providerID || m.providerID;
              modelID = modelID || m.modelID;
              break;
            }
          }
        } catch {
          // ignore
        }
      }

      // 3. Try first available provider/model from provider list
      if (!providerID || !modelID) {
        try {
          const providerResult = await client.provider.list();
          const providers = providerResult.data as any;
          if (providers && typeof providers === 'object') {
            for (const [pid, providerInfo] of Object.entries(providers)) {
              const models = (providerInfo as any)?.models;
              if (models && typeof models === 'object') {
                const firstModelId = Object.keys(models)[0];
                if (firstModelId) {
                  providerID = pid;
                  modelID = firstModelId;
                  break;
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }

      if (!providerID || !modelID) {
        throw new Error('No model available for compaction. Please configure a model in settings.');
      }

      const result = await client.session.summarize({
        sessionID: params.sessionId,
        providerID,
        modelID,
      });
      unwrap(result);
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
      // use-opencode-events.ts fetches messages + session for that ID.
    },
  });
}

// ============================================================================
// Fork Hook
// ============================================================================

/**
 * Fork a session at a specific message point.
 * Creates a new session that branches off from the given message.
 * Returns the newly created Session.
 */
export function useForkSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      sessionId,
      messageId,
      directory,
      workspace,
    }: {
      sessionId: string;
      messageId?: string;
      directory?: string;
      workspace?: string;
    }) => {
      const client = getClient();
      const result = await client.session.fork({
        sessionID: sessionId,
        ...(messageId && { messageID: messageId }),
        ...(directory && { directory }),
        ...(workspace && { workspace }),
      });
      return unwrap(result) as Session;
    },
    onSuccess: (newSession) => {
      // Insert forked session into cache — SSE session.created will also fire.
      // Dedup to avoid duplicate keys in the session list.
      queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
        if (!old) return [newSession];
        const idx = old.findIndex((s) => s.id === newSession.id);
        if (idx >= 0) {
          const next = [...old];
          next[idx] = newSession;
          return next.sort((a, b) => b.time.updated - a.time.updated);
        }
        return [newSession, ...old].sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(opencodeKeys.session(newSession.id), newSession);
    },
  });
}



// ============================================================================
// Init Hook — analyze project and create AGENTS.md (via /init command)
// ============================================================================

export function useInitSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId }: { sessionId: string }) => {
      const client = getClient();
      const result = await client.session.command({
        sessionID: sessionId,
        command: 'init',
        arguments: '',
      });
      if (result.error) {
        const err = result.error as any;
        throw new Error(err?.data?.message || err?.message || 'Failed to initialize project');
      }
      return sessionId;
    },
    onSuccess: (sessionId) => {
      // SSE events handle session updates. Just refetch messages for this session
      // since /init creates new messages.
      queryClient.refetchQueries({ queryKey: opencodeKeys.messages(sessionId) });
    },
    // Suppress global error handler — caller handles errors via onError callback
    onError: () => {},
    // Same rationale as useExecuteOpenCodeCommand — /command blocks until done,
    // retrying on timeout would duplicate execution.
    retry: false,
  });
}

'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isRuntimeConfigInvalidError } from '../../core/http/runtime-errors';
import { markSessionFresh } from '../../core/http/fresh-sessions';
import { useCurrentRuntime } from '../use-current-runtime';
import type { Session } from '../../runtime/wire-types';
import {
  createProjectSession,
  deleteProjectSession,
  getProjectSession,
  listProjectSessions,
  updateProjectSession,
  type ProjectSession,
} from '../../core/rest/projects-client';
import { getFileStatus } from '../../core/files/client';
import { runtimeKeys, useRuntimeReady } from './keys';
import { getLSCache, setLSCache, LS_SESSIONS } from './shared';
import { buildRuntimeSessionCreateInput } from './session-create-input';

// ============================================================================
// Session Hooks
// ============================================================================

export function useRuntimeSessions(enabled = true) {
  const runtimeReady = useRuntimeReady();
  // Subscribe to the active runtime sandbox so the query key recomputes the
  // instant the sandbox switches — returning to a warm session hits its cached
  // list rather than refetching from scratch.
  const serverId = useCurrentRuntime((s) => s.sandboxId) ?? undefined;
  const projectId = useCurrentRuntime((s) => s.projectId) ?? undefined;
  return useQuery<Session[]>({
    queryKey: runtimeKeys.sessions(serverId),
    queryFn: async () => {
      if (!projectId) return [];
      const sessions = (await listProjectSessions(projectId)).map(projectSessionToLegacyView);
      const sorted = sessions.sort((a: Session, b: Session) => b.time.updated - a.time.updated);
      setLSCache(LS_SESSIONS, sorted);
      return sorted;
    },
    placeholderData: () => getLSCache<Session[]>(LS_SESSIONS),
    enabled: enabled && runtimeReady && !!projectId,
    staleTime: 5 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    // With the scaffold-warm seed, the runtime is already ready for /workspace
    // and a root session is pinned the moment runtimeReady flips — so the first list
    // normally returns the pinned session in one shot. The only misses left are
    // the server-switch client race + the ~350ms health-poll enable lag, both of
    // which clear in one fast retry. So poll TIGHT (16 x 150ms = ~2.4s) to land
    // the first success in <300ms instead of mid-400ms-window; exponential tail
    // (cap 10s) covers the rare genuinely-stuck case. The old 8x400ms backoff
    // (~3.2s) was the entire 'runtime-listed' wall in the browser trace.
    retry: (failureCount, error) =>
      !isRuntimeConfigInvalidError(error) && failureCount < 16,
    retryDelay: (attempt) =>
      attempt < 16 ? 150 : Math.min(150 * Math.pow(2, attempt - 16), 10000),
  });
}

export function useRuntimeSession(sessionId: string) {
  const queryClient = useQueryClient();
  const runtimeReady = useRuntimeReady();
  const projectId = useCurrentRuntime((s) => s.projectId);
  return useQuery<Session>({
    queryKey: runtimeKeys.session(sessionId),
    queryFn: async () => {
      if (!projectId) throw new Error('No active Kortix project');
      return projectSessionToLegacyView(await getProjectSession(projectId, sessionId));
    },
    enabled: runtimeReady && !!sessionId && !!projectId,
    staleTime: Infinity,
    // Retry transient failures (sandbox still warming, brief network blip) so a
    // single failed lookup doesn't settle as "not found" and flash the
    // not-accessible error. The query stays in its loading state across retries.
    retry: (failureCount, error) =>
      !isRuntimeConfigInvalidError(error) && failureCount < 3,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 10000),
    placeholderData: () => {
      const sessions = queryClient.getQueryData<Session[]>(runtimeKeys.sessions());
      return sessions?.find((s) => s.id === sessionId);
    },
  });
}

export function useCreateRuntimeSession() {
  const queryClient = useQueryClient();
  const projectId = useCurrentRuntime((s) => s.projectId);

  return useMutation({
    mutationFn: async (options: { directory?: string; title?: string; initialPrompt?: string } | void) => {
      if (!projectId) throw new Error('Create a session from a Kortix project');
      const opts = options || {};
      return projectSessionToLegacyView(
        await createProjectSession(projectId, buildRuntimeSessionCreateInput(opts)),
      );
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
      queryClient.setQueryData(runtimeKeys.session(session.id), session);
    },
  });
}

export function useDeleteRuntimeSession() {
  const queryClient = useQueryClient();
  const projectId = useCurrentRuntime((s) => s.projectId);

  return useMutation({
    mutationFn: async (sessionId: string) => {
      if (!projectId) throw new Error('No active Kortix project');
      await deleteProjectSession(projectId, sessionId);
      return sessionId;
    },
    onSuccess: (sessionId) => {
      // Surgically remove from cache — SSE session.deleted will also fire
      queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
        if (!old) return old;
        return old.filter((s) => s.id !== sessionId);
      });
      queryClient.removeQueries({ queryKey: runtimeKeys.session(sessionId) });
    },
  });
}

export function useUpdateRuntimeSession() {
  const queryClient = useQueryClient();
  const projectId = useCurrentRuntime((s) => s.projectId);

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
      if (!projectId) throw new Error('No active Kortix project');
      const current = await getProjectSession(projectId, sessionId);
      const metadata = archived === undefined
        ? current.metadata
        : { ...current.metadata, archived_at: archived ? new Date().toISOString() : null };
      return projectSessionToLegacyView(await updateProjectSession(projectId, sessionId, {
        ...(title !== undefined ? { name: title } : {}),
        metadata,
      }));
    },
    onSuccess: (updatedSession) => {
      // Surgically update cache — SSE session.updated will also fire
      const session = updatedSession as Session;
      queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
        if (!old) return old;
        const idx = old.findIndex((s) => s.id === session.id);
        if (idx < 0) return old;
        const next = [...old];
        next[idx] = session;
        return next.sort((a, b) => b.time.updated - a.time.updated);
      });
      queryClient.setQueryData(runtimeKeys.session(session.id), session);
    },
  });
}

export function useRuntimeSessionDiff(sessionId: string) {
  const runtimeReady = useRuntimeReady();
  return useQuery({
    queryKey: ['runtime', 'session-diff', sessionId],
    queryFn: async () => {
      return getFileStatus();
    },
    enabled: runtimeReady && !!sessionId,
    staleTime: Infinity,
  });
}

export function useRuntimeSessionTodo(sessionId: string) {
  const runtimeReady = useRuntimeReady();
  return useQuery({
    queryKey: ['runtime', 'session-todo', sessionId],
    queryFn: async () => {
      return [];
    },
    enabled: runtimeReady && !!sessionId,
    staleTime: Infinity,
  });
}

// ============================================================================
// Summarize Hook
// ============================================================================

export function useSummarizeRuntimeSession() {
  return useMutation({
    mutationFn: async (_params: { sessionId: string; providerID?: string; modelID?: string }) => {
      throw new Error('Session compaction is not part of the ACP protocol');
    },
  });
}

// ============================================================================
// Init Hook — analyze project and create AGENTS.md (via /init command)
// ============================================================================

export function useInitSession() {
  return useMutation({
    mutationFn: async (_params: { sessionId: string }) => { throw new Error('Use an ACP prompt to initialize the project'); },
    onSuccess: () => {},
    // Suppress global error handler — caller handles errors via onError callback
    onError: () => {},
    // Same rationale as useExecuteRuntimeCommand — /command blocks until done,
    // retrying on timeout would duplicate execution.
    retry: false,
  });
}

function projectSessionToLegacyView(session: ProjectSession): Session {
  const created = Date.parse(session.created_at) || Date.now();
  const updated = Date.parse(session.updated_at) || created;
  const archivedRaw = session.metadata?.archived_at;
  const archived = typeof archivedRaw === 'string' ? Date.parse(archivedRaw) || undefined : undefined;
  return {
    id: session.session_id,
    title: session.name || session.branch_name || 'Session',
    time: { created, updated, ...(archived ? { archived } : {}) },
    projectID: session.project_id,
    agent: session.agent_name,
    status: session.status,
  };
}

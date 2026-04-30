/**
 * Platform & Session Hooks for Kortix Computer Mobile
 *
 * These hooks provide:
 * 1. Sandbox initialization (ensures user has a sandbox)
 * 2. Session listing from OpenCode server
 * 3. Session CRUD operations
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { log } from '@/lib/logger';
import { getAuthToken } from '@/api/config';
import {
  ensureSandbox,
  getActiveSandbox,
  getSandboxUrl,
  listSandboxes,
  restartSandbox,
  stopSandbox,
  deleteSandbox,
  renameSandbox,
  getProviders,
  initLocalSandbox,
  type SandboxInfo,
  type LocalSandboxProgress,
} from './client';
import type { Session, SessionMessage, SessionStatusMap } from './types';

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const platformKeys = {
  all: ['platform'] as const,
  sandbox: () => [...platformKeys.all, 'sandbox'] as const,
  instances: () => [...platformKeys.all, 'instances'] as const,
  providers: () => [...platformKeys.all, 'providers'] as const,
  sessions: () => [...platformKeys.all, 'sessions'] as const,
  session: (id: string) => [...platformKeys.sessions(), id] as const,
  sessionMessages: (id: string) => [...platformKeys.session(id), 'messages'] as const,
  sessionStatus: () => [...platformKeys.all, 'session-status'] as const,
};

// ─── Helper: Authenticated fetch to OpenCode server ──────────────────────────

async function opencodeFetch<T>(sandboxUrl: string, path: string, options?: RequestInit): Promise<T> {
  const token = await getAuthToken();

  const res = await fetch(`${sandboxUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers as Record<string, string>),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenCode ${path} failed: ${res.status} - ${body}`);
  }

  return res.json();
}

// ─── Sandbox Hook ────────────────────────────────────────────────────────────

/**
 * Ensures user has a sandbox. Returns sandbox info + derived OpenCode URL.
 * This is the first thing that should run after auth.
 */
export function useSandbox(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.sandbox(),
    queryFn: async () => {
      log.log('📦 [useSandbox] Checking sandbox...');

      // First try to get existing active sandbox
      let sandbox = await getActiveSandbox();

      // If no active sandbox, list everything the platform knows about — this
      // also probes /platform/local-bridge/status, which discovers a running
      // local Docker container and upserts it in the DB as 'active'. We reuse
      // ANY sandbox the list returns (active / provisioning / stopped) so a
      // cold app open never accidentally routes through POST /platform/init
      // just because the DB row momentarily says 'stopped' — calling /init
      // would trigger tryReactivateStaleSandbox → provider.start(), which for
      // local_docker surfaces to users as a spurious "restart on every open".
      if (!sandbox) {
        log.log('📦 [useSandbox] No active sandbox, listing all sandboxes...');
        const allSandboxes = await listSandboxes();
        // Prefer active → provisioning → stopped → error.
        const priority = { active: 0, provisioning: 1, stopped: 2, error: 3 } as Record<string, number>;
        const best = [...allSandboxes].sort(
          (a, b) => (priority[a.status] ?? 99) - (priority[b.status] ?? 99),
        )[0];

        if (best) {
          log.log(`📦 [useSandbox] Reusing existing sandbox: ${best.external_id} (status=${best.status})`);
          return {
            sandbox: best,
            sandboxUrl: getSandboxUrl(best.external_id),
            sandboxId: best.external_id,
          };
        }

        // No sandbox at all anywhere — provision one.
        log.log('📦 [useSandbox] No sandbox found, provisioning...');
        const result = await ensureSandbox();
        sandbox = result.sandbox;
      }

      const sandboxUrl = getSandboxUrl(sandbox.external_id);
      log.log('✅ [useSandbox] Sandbox ready:', sandbox.external_id, '→', sandboxUrl);

      return {
        sandbox,
        sandboxUrl,
        sandboxId: sandbox.external_id,
      };
    },
    enabled,
    staleTime: 5 * 60 * 1000, // Sandbox doesn't change often
    retry: 2,
  });
}

// ─── Session List Hook ───────────────────────────────────────────────────────

/**
 * Lists all sessions from the OpenCode server.
 * GET {sandboxUrl}/session
 */
export function useSessions(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: platformKeys.sessions(),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');

      log.log('📋 [useSessions] Fetching sessions from:', sandboxUrl);
      const sessions = await opencodeFetch<Session[]>(sandboxUrl, '/session');

      // Sort by updated time descending (most recent first)
      const sorted = [...sessions].sort((a, b) => b.time.updated - a.time.updated);
      log.log('✅ [useSessions] Got', sorted.length, 'sessions');
      return sorted;
    },
    enabled: !!sandboxUrl,
    staleTime: 10 * 1000, // Refresh every 10s
    refetchOnWindowFocus: true,
  });
}

// ─── Session Detail Hook ─────────────────────────────────────────────────────

/**
 * Get a single session by ID.
 * GET {sandboxUrl}/session/{id}
 */
export function useSession(sandboxUrl: string | undefined, sessionId: string | undefined) {
  return useQuery({
    queryKey: platformKeys.session(sessionId || ''),
    queryFn: async () => {
      if (!sandboxUrl || !sessionId) throw new Error('Missing sandboxUrl or sessionId');
      return opencodeFetch<Session>(sandboxUrl, `/session/${sessionId}`);
    },
    enabled: !!sandboxUrl && !!sessionId,
    staleTime: 5 * 1000,
  });
}

// ─── Session Messages Hook ───────────────────────────────────────────────────

/**
 * Get messages for a session.
 * GET {sandboxUrl}/session/{id}/message
 */
export function useSessionMessages(sandboxUrl: string | undefined, sessionId: string | undefined) {
  return useQuery({
    queryKey: platformKeys.sessionMessages(sessionId || ''),
    queryFn: async () => {
      if (!sandboxUrl || !sessionId) throw new Error('Missing sandboxUrl or sessionId');
      return opencodeFetch<SessionMessage[]>(sandboxUrl, `/session/${sessionId}/message`);
    },
    enabled: !!sandboxUrl && !!sessionId,
    staleTime: 5 * 1000,
  });
}

// ─── Session Status Hook ─────────────────────────────────────────────────────

/**
 * Get status of all sessions (idle/running/error).
 * GET {sandboxUrl}/session/status
 */
export function useSessionStatuses(sandboxUrl: string | undefined) {
  return useQuery({
    queryKey: platformKeys.sessionStatus(),
    queryFn: async () => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      return opencodeFetch<SessionStatusMap>(sandboxUrl, '/session/status');
    },
    enabled: !!sandboxUrl,
    staleTime: 2 * 1000,
    refetchInterval: 5000, // Poll session statuses
  });
}

// ─── Session Create Mutation ─────────────────────────────────────────────────

/**
 * Create a new session.
 * POST {sandboxUrl}/session
 */
export function useCreateSession(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { title?: string; directory?: string }) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');

      log.log('➕ [useCreateSession] Creating session:', params);
      const session = await opencodeFetch<Session>(sandboxUrl, '/session', {
        method: 'POST',
        body: JSON.stringify({
          ...(params.title ? { title: params.title } : {}),
          ...(params.directory ? { directory: params.directory } : {}),
        }),
      });

      log.log('✅ [useCreateSession] Created:', session.id);
      return session;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
    },
  });
}

// ─── Session Delete Mutation ─────────────────────────────────────────────────

/**
 * Delete a session.
 * DELETE {sandboxUrl}/session/{id}
 */
export function useDeleteSession(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');

      log.log('🗑️ [useDeleteSession] Deleting session:', sessionId);
      await opencodeFetch<void>(sandboxUrl, `/session/${sessionId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: (_, sessionId) => {
      queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
      queryClient.removeQueries({ queryKey: platformKeys.session(sessionId) });
    },
  });
}

// ─── Session Archive/Unarchive Mutation ──────────────────────────────────────

/**
 * Archive a session.
 * PATCH {sandboxUrl}/session/{id} with { time: { archived: Date.now() } }
 */
export function useArchiveSession(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      await opencodeFetch<void>(sandboxUrl, `/session/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ time: { archived: Date.now() } }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
    },
  });
}

/**
 * Unarchive a session.
 * PATCH {sandboxUrl}/session/{id} with { time: { archived: 0 } }
 */
export function useUnarchiveSession(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      await opencodeFetch<void>(sandboxUrl, `/session/${sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ time: { archived: 0 } }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
    },
  });
}

// ─── Session Rename Mutation ─────────────────────────────────────────────────

/**
 * Rename a session (update its title).
 * PATCH {sandboxUrl}/session/{id} with { title: "..." }
 *
 * Optimistically updates the sessions list cache so the UI reflects the new
 * title immediately; the server's SSE session.updated event will reconcile
 * afterwards.
 */
export function useRenameSession(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { sessionId: string; title: string }) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');
      await opencodeFetch<void>(sandboxUrl, `/session/${params.sessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: params.title }),
      });
    },
    onMutate: async ({ sessionId, title }) => {
      // Surgically patch the sessions list so the rename shows up instantly
      // even if SSE is slow.
      await queryClient.cancelQueries({ queryKey: platformKeys.sessions() });
      const previous = queryClient.getQueryData<Session[]>(platformKeys.sessions());
      queryClient.setQueryData<Session[]>(platformKeys.sessions(), (old) => {
        if (!old) return old;
        return old.map((s) => (s.id === sessionId ? { ...s, title } : s));
      });
      // Also patch the single-session cache used by useSession()
      const singleKey = platformKeys.session(sessionId);
      const previousSingle = queryClient.getQueryData<Session>(singleKey);
      if (previousSingle) {
        queryClient.setQueryData<Session>(singleKey, { ...previousSingle, title });
      }
      return { previous, previousSingle, sessionId };
    },
    onError: (_err, _vars, context) => {
      // Roll back on failure
      if (context?.previous) {
        queryClient.setQueryData(platformKeys.sessions(), context.previous);
      }
      if (context?.previousSingle && context?.sessionId) {
        queryClient.setQueryData(
          platformKeys.session(context.sessionId),
          context.previousSingle,
        );
      }
    },
    onSettled: (_data, _err, vars) => {
      queryClient.invalidateQueries({ queryKey: platformKeys.sessions() });
      queryClient.invalidateQueries({ queryKey: platformKeys.session(vars.sessionId) });
    },
  });
}

// ─── Session Prompt Mutation ─────────────────────────────────────────────────

/**
 * Send a prompt to a session.
 * POST {sandboxUrl}/session/{id}/prompt
 */
export function useSendPrompt(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      sessionId: string;
      parts: Array<{ type: 'text'; text: string }>;
    }) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');

      log.log('💬 [useSendPrompt] Sending prompt to session:', params.sessionId);
      await opencodeFetch<void>(sandboxUrl, `/session/${params.sessionId}/prompt`, {
        method: 'POST',
        body: JSON.stringify({
          parts: params.parts,
        }),
      });

      log.log('✅ [useSendPrompt] Prompt sent');
    },
    onSuccess: (_, params) => {
      // Invalidate messages so they refetch
      queryClient.invalidateQueries({
        queryKey: platformKeys.sessionMessages(params.sessionId),
      });
    },
  });
}

// ─── Session Abort Mutation ──────────────────────────────────────────────────

/**
 * Abort a running session.
 * POST {sandboxUrl}/session/{id}/abort
 */
export function useAbortSession(sandboxUrl: string | undefined) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (sessionId: string) => {
      if (!sandboxUrl) throw new Error('No sandbox URL');

      log.log('⛔ [useAbortSession] Aborting session:', sessionId);
      await opencodeFetch<void>(sandboxUrl, `/session/${sessionId}/abort`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.sessionStatus() });
    },
  });
}

// ─── Question Reply / Reject ────────────────────────────────────────────────

/**
 * Reply to a pending question.
 * POST {sandboxUrl}/question/{requestID}/reply
 */
export async function replyToQuestion(
  sandboxUrl: string,
  requestId: string,
  answers: string[][],
): Promise<void> {
  log.log('💬 [replyToQuestion] Replying to:', requestId);
  await opencodeFetch<void>(sandboxUrl, `/question/${requestId}/reply`, {
    method: 'POST',
    body: JSON.stringify({ answers }),
  });
}

/**
 * Reject (dismiss) a pending question.
 * POST {sandboxUrl}/question/{requestID}/reject
 */
export async function rejectQuestion(
  sandboxUrl: string,
  requestId: string,
): Promise<void> {
  log.log('❌ [rejectQuestion] Rejecting:', requestId);
  await opencodeFetch<void>(sandboxUrl, `/question/${requestId}/reject`, {
    method: 'POST',
  });
}

// ─── Session Fork ───────────────────────────────────────────────────────────

/**
 * Fork a session at a given message.
 * POST {sandboxUrl}/session/{sessionId}/fork
 *
 * The server copies all messages BEFORE the given messageID (exclusive).
 * Omit messageID to copy all messages.
 * Returns the newly created forked session.
 */
export async function forkSession(
  sandboxUrl: string,
  sessionId: string,
  messageId?: string,
): Promise<Session> {
  log.log('🔀 [forkSession] Forking session:', sessionId, 'at message:', messageId);
  return opencodeFetch<Session>(sandboxUrl, `/session/${sessionId}/fork`, {
    method: 'POST',
    body: JSON.stringify(messageId ? { messageID: messageId } : {}),
  });
}

// ─── Instance Management Hooks ──────────────────────────────────────────────

export function useInstances(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.instances(),
    queryFn: listSandboxes,
    enabled,
    staleTime: 30 * 1000,
  });
}

export function useRestartInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restartSandbox,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

export function useStopInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: stopSandbox,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
    },
  });
}

export function useDeleteInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deleteSandbox,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

export function useProviders() {
  return useQuery({
    queryKey: platformKeys.providers(),
    queryFn: getProviders,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateLocalInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { name?: string; onProgress?: (p: LocalSandboxProgress) => void }) =>
      initLocalSandbox(args.name, args.onProgress),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

export function useCreateCloudInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: 'daytona' | 'justavps') => ensureSandbox({ provider }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

export function useRenameSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sandboxId, name }: { sandboxId: string; name: string }) =>
      renameSandbox(sandboxId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

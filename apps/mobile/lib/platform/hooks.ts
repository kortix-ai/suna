/**
 * Platform & Session Hooks for Kortix Computer Mobile
 *
 * These hooks provide:
 * 1. Sandbox initialization (ensures user has a sandbox)
 * 2. Project-session listing through the Kortix SDK
 * 3. Session CRUD operations
 */

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useCreateRuntimeSession,
  useDeleteRuntimeSession,
  useRuntimeSession,
  useRuntimeSessions,
  useUpdateRuntimeSession,
} from '@kortix/sdk/react';
import { log } from '@/lib/logger';
import {
  ensureSandbox,
  getActiveSandbox,
  getSandboxUrl,
  listSandboxes,
  restartSandbox,
  stopSandbox,
  deleteSandbox,
  getProviders,
  type SandboxInfo,
} from './client';
import type { SessionStatusMap } from './types';

// ─── Query Keys ──────────────────────────────────────────────────────────────

export const platformKeys = {
  all: ['platform'] as const,
  sandbox: () => [...platformKeys.all, 'sandbox'] as const,
  instances: () => [...platformKeys.all, 'instances'] as const,
  providers: () => [...platformKeys.all, 'providers'] as const,
  sessions: () => [...platformKeys.all, 'sessions'] as const,
  session: (id: string) => [...platformKeys.sessions(), id] as const,
  sessionStatus: () => [...platformKeys.all, 'session-status'] as const,
};

// ─── Sandbox Hook ────────────────────────────────────────────────────────────

/**
 * Ensures user has a sandbox. Returns sandbox info + derived runtime URL.
 * This is the first thing that should run after auth.
 */
export function useSandbox(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.sandbox(),
    queryFn: async () => {
      log.log('📦 [useSandbox] Checking sandbox...');

      // First try to get existing active sandbox
      let sandbox = await getActiveSandbox();

      // If no active sandbox, listSandboxes() retrieves all known sandboxes
      // from the platform API. We reuse ANY sandbox the list returns (active /
      // provisioning / stopped) so a cold app open never accidentally routes
      // through POST /platform/init just because the DB row momentarily says
      // 'stopped' — calling /init would trigger tryReactivateStaleSandbox →
      // provider.start(), which can surface to users as a spurious "restart on
      // every open".
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
 * Lists all project sessions through the Kortix platform API.
 */
export function useSessions(sandboxUrl: string | undefined) {
  return useRuntimeSessions(Boolean(sandboxUrl));
}

// ─── Session Detail Hook ─────────────────────────────────────────────────────

/**
 * Get a single session by ID.
 * Reads one project session through the Kortix platform API.
 */
export function useSession(sandboxUrl: string | undefined, sessionId: string | undefined) {
  return useRuntimeSession(sandboxUrl && sessionId ? sessionId : '');
}

// ─── Session Status Hook ─────────────────────────────────────────────────────

/**
 * Get status of all sessions (idle/running/error).
 * Derives idle/running/error from project-session lifecycle state.
 */
export function useSessionStatuses(sandboxUrl: string | undefined) {
  const sessions = useRuntimeSessions(Boolean(sandboxUrl));
  const data = useMemo<SessionStatusMap | undefined>(() => {
    if (!sessions.data) return undefined;
    return Object.fromEntries(sessions.data.map((session) => [
      session.id,
      session.status === 'running' ? 'running' : session.status === 'failed' ? 'error' : 'idle',
    ]));
  }, [sessions.data]);
  return { ...sessions, data };
}

// ─── Session Create Mutation ─────────────────────────────────────────────────

/**
 * Create a new session.
 * Creates a canonical Kortix project session.
 */
export function useCreateSession(sandboxUrl: string | undefined) {
  void sandboxUrl;
  return useCreateRuntimeSession();
}

// ─── Session Delete Mutation ─────────────────────────────────────────────────

/**
 * Delete a session.
 * Deletes a canonical Kortix project session.
 */
export function useDeleteSession(sandboxUrl: string | undefined) {
  void sandboxUrl;
  return useDeleteRuntimeSession();
}

// ─── Session Archive/Unarchive Mutation ──────────────────────────────────────

/**
 * Archive a session.
 * Archives a canonical Kortix project session.
 */
export function useArchiveSession(sandboxUrl: string | undefined) {
  const update = useUpdateRuntimeSession();
  void sandboxUrl;

  return useMutation({
    mutationFn: (sessionId: string) => update.mutateAsync({ sessionId, archived: true }),
  });
}

/**
 * Unarchive a session.
 * PATCH {sandboxUrl}/session/{id} with { time: { archived: 0 } }
 */
export function useUnarchiveSession(sandboxUrl: string | undefined) {
  const update = useUpdateRuntimeSession();
  void sandboxUrl;

  return useMutation({
    mutationFn: (sessionId: string) => update.mutateAsync({ sessionId, archived: false }),
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
  const update = useUpdateRuntimeSession();
  void sandboxUrl;

  return useMutation({
    mutationFn: ({ sessionId, title }: { sessionId: string; title: string }) =>
      update.mutateAsync({ sessionId, title }),
  });
}

// ─── Session Abort Mutation ──────────────────────────────────────────────────

/**
 * Abort a running session.
 * POST {sandboxUrl}/session/{id}/abort
 */
export function useAbortSession(sandboxUrl: string | undefined) {
  void sandboxUrl;

  return useMutation({
    mutationFn: async (_sessionId: string) => {
      throw new Error('Cancel the active turn through useSession(projectId, sessionId).acp.cancel().');
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
  void sandboxUrl;
  void requestId;
  void answers;
  throw new Error('Answer ACP elicitations through useSession().acp.respondQuestion().');
}

/**
 * Reject (dismiss) a pending question.
 * POST {sandboxUrl}/question/{requestID}/reject
 */
export async function rejectQuestion(
  sandboxUrl: string,
  requestId: string,
): Promise<void> {
  void sandboxUrl;
  void requestId;
  throw new Error('Reject ACP elicitations through useSession().acp.rejectQuestion().');
}

// ─── Instance Management Hooks ──────────────────────────────────────────────

export function useInstances(enabled: boolean = true) {
  return useQuery({
    queryKey: platformKeys.instances(),
    queryFn: () => listSandboxes(),
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

export function useCreateCloudInstance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: SandboxInfo['provider']) => ensureSandbox({ provider }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformKeys.instances() });
      queryClient.invalidateQueries({ queryKey: platformKeys.sandbox() });
    },
  });
}

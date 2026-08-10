import type { QueryClient } from '@tanstack/react-query';

/**
 * Centralized React Query keys. One source of truth so mutations can
 * invalidate exactly what a view reads — the basis for flawless refetching.
 */
export const qk = {
  workspaces: ['workspaces'] as const,
  workspace: (id: string) => ['workspace', id] as const,
  workspaceDetail: (id: string) => ['workspace-detail', id] as const,
  sessions: (workspaceId: string) => ['workspace-sessions', workspaceId] as const,
  session: (workspaceId: string, sessionId: string) =>
    ['workspace-session', workspaceId, sessionId] as const,
  sessionScope: (workspaceId: string, sessionId: string) =>
    ['workspace-session-scope', workspaceId, sessionId] as const,
  sessionStart: (workspaceId: string, sessionId: string) =>
    ['session-start', workspaceId, sessionId] as const,
  secrets: (workspaceId: string) => ['workspace-secrets', workspaceId] as const,
  access: (workspaceId: string) => ['workspace-access', workspaceId] as const,
};

/** Invalidate everything a workspace page depends on after a session mutation. */
export function invalidateSessions(qc: QueryClient, workspaceId: string) {
  qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
}

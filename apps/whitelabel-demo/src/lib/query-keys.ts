import type { QueryClient } from '@tanstack/react-query';

/**
 * Centralized React Query keys. One source of truth so mutations can
 * invalidate exactly what a view reads — the basis for flawless refetching.
 */
export const qk = {
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  projectDetail: (id: string) => ['project-detail', id] as const,
  sessions: (workspaceId: string) => ['project-sessions', workspaceId] as const,
  session: (workspaceId: string, sessionId: string) =>
    ['project-session', workspaceId, sessionId] as const,
  sessionScope: (workspaceId: string, sessionId: string) =>
    ['project-session-scope', workspaceId, sessionId] as const,
  sessionStart: (workspaceId: string, sessionId: string) =>
    ['session-start', workspaceId, sessionId] as const,
  secrets: (workspaceId: string) => ['project-secrets', workspaceId] as const,
  access: (workspaceId: string) => ['project-access', workspaceId] as const,
};

/** Invalidate everything a project page depends on after a session mutation. */
export function invalidateSessions(qc: QueryClient, workspaceId: string) {
  qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
}

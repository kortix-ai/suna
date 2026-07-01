import type { QueryClient } from '@tanstack/react-query';

/**
 * Centralized React Query keys. One source of truth so mutations can
 * invalidate exactly what a view reads — the basis for flawless refetching.
 */
export const qk = {
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  projectDetail: (id: string) => ['project-detail', id] as const,
  sessions: (projectId: string) => ['project-sessions', projectId] as const,
  session: (projectId: string, sessionId: string) =>
    ['project-session', projectId, sessionId] as const,
  sessionStart: (projectId: string, sessionId: string) =>
    ['session-start', projectId, sessionId] as const,
  secrets: (projectId: string) => ['project-secrets', projectId] as const,
  access: (projectId: string) => ['project-access', projectId] as const,
};

/** Invalidate everything a project page depends on after a session mutation. */
export function invalidateSessions(qc: QueryClient, projectId: string) {
  qc.invalidateQueries({ queryKey: qk.sessions(projectId) });
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { type ProjectConfigSummary, getProjectDetail } from '../platform/projects-client';

/**
 * Server-side project config — the single source of truth for everything a user
 * selects AROUND a session: agents, commands, skills, the default agent, and env
 * requirements. Fetched from the Kortix server (project detail), so it works
 * before any sandbox runtime exists. This is the canonical home for the
 * "capabilities, not runtime state" split — `useVisibleAgents({ projectId })`
 * and `useProjectModels(projectId)` are the per-surface siblings.
 */
export function useProjectConfig(
  projectId: string | null | undefined,
): ProjectConfigSummary | undefined {
  const { data } = useQuery({
    queryKey: ['project-config', projectId],
    queryFn: async () => (await getProjectDetail(projectId as string)).config,
    enabled: !!projectId,
    staleTime: 30_000,
    retry: false,
  });
  return data;
}

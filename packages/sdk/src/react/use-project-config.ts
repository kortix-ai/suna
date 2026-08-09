'use client';

import { useQuery } from '@tanstack/react-query';
import {
  type ProjectConfigSummary,
  type ProjectDetail,
  getProjectDetail,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Server-side project config — the single source of truth for everything a user
 * selects AROUND a session: agents, commands, skills, the default agent, and env
 * requirements. Fetched from the Kortix server (project detail), so it works
 * before any sandbox runtime exists. This is the canonical home for the
 * "capabilities, not runtime state" split — `useVisibleAgents({ projectId })`
 * and `useProjectModels(projectId)` are the per-surface siblings.
 *
 * Reads `qk.project.detail(id)` via a `select` projection — the SAME entry
 * every other project-detail reader shares (Customize, the capability pages,
 * the project shell) — rather than its own key. It used to key on the
 * standalone `['project-config', id]`, so every one of THOSE readers issued
 * its own `getProjectDetail` fetch even though the response was
 * byte-identical to the one already cached under `qk.project.detail(id)`.
 */
export function useProjectConfig(
  projectId: string | null | undefined,
): ProjectConfigSummary | undefined {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    select: (detail: ProjectDetail) => detail.config,
    enabled: !!projectId,
    ...contract('config'),
    retry: false,
  });
  return data;
}

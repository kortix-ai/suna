'use client';

import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '../core/rest/projects-client';
import { qk } from './query-keys';
import { contract } from './query-contracts';

/**
 * The ONLY way to read a project's name.
 *
 * The two-titles bug was not an invalidation gap, it was two sources for one
 * fact: `project-switcher.tsx` read `activeProject?.name` off the projects
 * LIST and fell back to the detail, while `project-home.tsx` read the detail
 * alone. Any divergence between the two caches rendered as two different names
 * on one screen.
 *
 * One accessor makes that structurally impossible rather than merely currently
 * invalidated. Do not reintroduce a `??` fallback to another source here.
 */
export function useProjectName(projectId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => getProjectDetail(projectId as string),
    enabled: Boolean(projectId),
    ...contract('config'),
  });
  return data?.project?.name;
}

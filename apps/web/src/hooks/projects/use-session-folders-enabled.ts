'use client';

/**
 * Gate for the experimental Session Folders surface. Reads the same server
 * source of truth as every other experimental feature — the effective
 * `project.experimental` map (per-project override over the operator default,
 * see resolveExperimentalFeatures in the API). The sidebar FOLDERS section and
 * folder pages gate off this so there is exactly one on/off switch.
 */

import { getProject } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';

export function useSessionFoldersEnabled(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    enabled: !!projectId,
  });
  return data?.experimental?.session_folders ?? false;
}

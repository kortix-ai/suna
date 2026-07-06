'use client';

/**
 * Shared gate for the experimental `[[apps]]` deployment surface on the web.
 *
 * `project.apps_enabled` is the server's single source of truth (per-project
 * `experimental` override, defaulting to the operator-wide
 * `KORTIX_APPS_EXPERIMENTAL` flag — see `serializeProject` in the API). Every
 * apps entry point (sidebar nav, rail, overlay contents) must gate off this
 * same field so there is exactly one place a project can end up showing Apps.
 */

import { useQuery } from '@tanstack/react-query';
import { getProjectDetail } from '@kortix/sdk/projects-client';

export function useAppsEnabled(projectId: string): boolean {
  const { data } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return data?.project?.apps_enabled ?? false;
}

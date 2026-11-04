'use client';

import { useQuery } from '@tanstack/react-query';
import { getProject } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * The bare project row: `GET /projects/:id`, cached under `qk.project.summary`.
 * One database read on the server. The project's identity (name, icon,
 * account) and its feature flags come from here, never from the detail:
 * `GET /projects/:id/detail` reads the repository and can take seconds, and a
 * flag gate on it held the project page blank (2026-11-03). Internal: not on
 * the public surface.
 */
export function useProjectRow(projectId: string | null | undefined, options: { refetchOnWindowFocus?: boolean } = {}) {
  const id = projectId ?? '';
  return useQuery({
    queryKey: qk.project.summary(id),
    queryFn: () => getProject(id),
    enabled: Boolean(projectId),
    ...contract('config'),
    ...options,
  });
}

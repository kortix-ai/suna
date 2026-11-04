'use client';

import { useQuery } from '@tanstack/react-query';
import { getSessionUsage } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * What a session and every session it started cost, in USD, from the gateway's
 * request record (`getSessionUsage`). Read it where the numbers are shown, for
 * example while a usage view is open: the read walks the session tree.
 */
export function useSessionUsage(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: qk.project.sessionUsage(projectId ?? '', sessionId ?? ''),
    queryFn: () => getSessionUsage(projectId as string, sessionId as string),
    enabled: !!projectId && !!sessionId && options.enabled !== false,
    ...contract('inventory'),
  });
}

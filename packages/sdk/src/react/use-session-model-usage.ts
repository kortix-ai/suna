'use client';

import { useQuery } from '@tanstack/react-query';
import { getSessionModelUsage } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Which model answered each turn of a session, and what Kortix billed for it.
 *
 * The key is the session alone, so every reader shares one record and a
 * refetch keeps the identity of each turn that did not change. A model request
 * is the only thing that changes the record: call `refetch()` when an answer
 * can have landed (a new assistant message, the end of a turn). A request's
 * row is written as the request ends, so read once more a moment after a turn
 * ends to pick up its last request.
 */
export function useSessionModelUsage(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
) {
  return useQuery({
    queryKey: qk.project.sessionModelUsage(projectId ?? '', sessionId ?? ''),
    queryFn: () => getSessionModelUsage(projectId as string, sessionId as string),
    enabled: !!projectId && !!sessionId,
    ...contract('inventory'),
  });
}

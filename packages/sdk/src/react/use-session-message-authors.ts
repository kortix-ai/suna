'use client';

import { useQuery } from '@tanstack/react-query';
import { getSessionMessageAuthors } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Who wrote each message of a session: a member or another session's agent.
 * Pass a revision that changes when a new user message appears — its count,
 * or better the newest user message id: a new message is the only thing that
 * adds an author, so the key changes exactly when a refetch can find one.
 */
export function useSessionMessageAuthors(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
  revision: number | string,
) {
  return useQuery({
    queryKey: [...qk.project.sessionMessageAuthors(projectId ?? '', sessionId ?? ''), revision],
    queryFn: () => getSessionMessageAuthors(projectId as string, sessionId as string),
    enabled: !!projectId && !!sessionId,
    placeholderData: (previous) => previous,
    ...contract('inventory'),
  });
}

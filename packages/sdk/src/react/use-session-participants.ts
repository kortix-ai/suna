'use client';

import { useQuery } from '@tanstack/react-query';

import { getSessionParticipants, type SessionParticipants } from '../core/rest/projects-client';

import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Who can open a session. The key nests under `qk.project.session(...)`, so
 * saving a sharing change (which invalidates `sessionsScope`) refetches it.
 * Who wrote each message is `useSessionMessageAuthors`.
 */
export function useSessionParticipants(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: { enabled?: boolean },
) {
  return useQuery<SessionParticipants>({
    queryKey: qk.project.sessionParticipants(projectId ?? '', sessionId ?? ''),
    queryFn: () => getSessionParticipants(projectId as string, sessionId as string),
    enabled: Boolean(projectId) && Boolean(sessionId) && (options?.enabled ?? true),
    ...contract('inventory'),
  });
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getSessionParticipants, type SessionParticipants } from '../core/rest/projects-client';

import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Who can open a session and who sent each prompt in it.
 *
 * The key nests under `qk.project.session(...)`, so saving a sharing change
 * (which invalidates `sessionsScope`) refetches it. No polling: pass
 * `newestUserMessageId` and the hook asks again, once, when that message has
 * no recorded sender yet — the moment another person's prompt arrives.
 */
export function useSessionParticipants(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: { enabled?: boolean; newestUserMessageId?: string },
) {
  const queryKey = qk.project.sessionParticipants(projectId ?? '', sessionId ?? '');
  const queryClient = useQueryClient();
  const query = useQuery<SessionParticipants>({
    queryKey,
    queryFn: () => getSessionParticipants(projectId as string, sessionId as string),
    enabled: Boolean(projectId) && Boolean(sessionId) && (options?.enabled ?? true),
    ...contract('inventory'),
  });

  const newest = options?.newestUserMessageId;
  const data = query.data;
  // Keyed on the message id, not on `senders`: a message that never gets a
  // sender (a slash command) is asked about once, not after every refetch.
  useEffect(() => {
    if (!newest || !data?.multi_user || data.senders[newest]) return;
    void queryClient.invalidateQueries({ queryKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest, data?.multi_user]);

  return query;
}

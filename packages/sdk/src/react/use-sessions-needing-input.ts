'use client';

import { useQuery } from '@tanstack/react-query';

import {
  listSessionsNeedingInput,
  type ProjectSession,
  type SessionsNeedingInputResponse,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** How many things wait on the viewer in one session: a connector approval or an open agent question. */
export function sessionNeedsInputCount(
  summary: SessionsNeedingInputResponse | undefined,
  session: Pick<ProjectSession, 'session_id' | 'runtime_session_id'>,
): number {
  if (!summary) return 0;
  return (
    summary.sessions[session.session_id] ??
    (session.runtime_session_id ? summary.sessions[session.runtime_session_id] : undefined) ??
    0
  );
}

/**
 * The project's per-session "waiting on a human" summary. The server only lists
 * sessions the viewer may answer, so a session present here is a `needs-you`
 * session for this viewer. Polled: nothing announces a new question.
 */
export function useSessionsNeedingInput(projectId: string, options?: { enabled?: boolean }) {
  const enabled = Boolean(projectId) && options?.enabled !== false;
  return useQuery({
    queryKey: qk.project.needsInput(projectId),
    queryFn: () => listSessionsNeedingInput(projectId),
    enabled,
    ...contract('volatile'),
    refetchInterval: enabled ? 30_000 : false,
    refetchOnWindowFocus: true,
  });
}

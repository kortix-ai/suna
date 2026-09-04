'use client';

import { projectSessionsRefetchInterval } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { listProjectSessions, type ProjectSession } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * Every session the caller can see, for both Monitoring tabs. The SAME
 * `qk.project.sessions(projectId)` entry the sidebar polls, at the sidebar's
 * cadence, so a stage move (which invalidates the family) and a session the
 * agent renames land in the sidebar, the board and the runs list at once — no
 * second transport, and no refetch when switching tabs.
 */
export function useMonitoringSessions(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    enabled,
    refetchInterval: (query) =>
      projectSessionsRefetchInterval({
        sessions: query.state.data as ProjectSession[] | undefined,
        hasOpenSession: true,
      }),
    refetchOnWindowFocus: true,
    ...contract('inventory'),
  });
}

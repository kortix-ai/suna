'use client';

import { projectSessionsRefetchInterval } from '@/features/workspace/project-sidebar/project-session-list-helpers';
import { listProjectSessions, type ProjectSession } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/** While any session is live the board re-reads this often; the sidebar's 60s is too slow to watch a card move. */
export const LIVE_BOARD_POLL_MS = 10_000;

const LIVE_STATUSES = new Set<ProjectSession['status']>([
  'queued',
  'branching',
  'provisioning',
  'running',
]);

/**
 * The sidebar's cadence, tightened to `LIVE_BOARD_POLL_MS` whenever a session
 * is live. Monitoring exists to watch agents move their cards; a settled
 * project (nothing running) falls back to the sidebar's rule, so an idle
 * board polls exactly as little as the sidebar does.
 */
export function boardRefetchInterval(sessions: ProjectSession[] | undefined): number | false {
  const base = projectSessionsRefetchInterval({ sessions, hasOpenSession: true });
  const live = sessions?.some((s) => LIVE_STATUSES.has(s.status)) ?? false;
  if (!live) return base;
  return base === false ? LIVE_BOARD_POLL_MS : Math.min(base, LIVE_BOARD_POLL_MS);
}

/**
 * Every session the caller can see, for both Monitoring tabs. The SAME
 * `qk.project.sessions(projectId)` entry the sidebar polls, so a stage move
 * (which invalidates the family) and a session the agent renames land in the
 * sidebar, the board and the runs list at once — no second transport, and no
 * refetch when switching tabs.
 */
export function useMonitoringSessions(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.project.sessions(projectId),
    queryFn: () => listProjectSessions(projectId),
    enabled,
    refetchInterval: (query) =>
      boardRefetchInterval(query.state.data as ProjectSession[] | undefined),
    refetchOnWindowFocus: true,
    ...contract('inventory'),
  });
}

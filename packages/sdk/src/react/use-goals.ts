'use client';

import { useQuery } from '@tanstack/react-query';
import { getProjectGoalFiles, listProjectGoals, type ProjectGoal } from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const inventory = contract('inventory');

/**
 * Every goal in a project the caller can see, with its heartbeat and health.
 * Pass `null` while the `goals` flag is off: nothing loads.
 *
 * A goal's health changes with time alone (a wake becomes overdue, an ask
 * passes its due time), so a mounted list re-reads every 60 seconds.
 */
export function useProjectGoals(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.goals(projectId ?? ''),
    queryFn: () => listProjectGoals(projectId as string),
    enabled: !!projectId,
    ...inventory,
    refetchInterval: (query) => {
      const heal = typeof inventory.refetchInterval === 'function' ? inventory.refetchInterval(query) : false;
      return heal || 60_000;
    },
    refetchIntervalInBackground: false,
  });
}

/** One goal folder's `log.md`, `notes.md` and verification. */
export function useProjectGoalFiles(projectId: string | null | undefined, goal: Pick<ProjectGoal, 'driveId' | 'folder'> | null) {
  return useQuery({
    queryKey: qk.project.goalFiles(projectId ?? '', goal?.folder ?? ''),
    queryFn: () => getProjectGoalFiles(goal!.driveId, goal!.folder),
    enabled: !!projectId && !!goal,
    ...inventory,
  });
}

/**
 * The goal a session works on, and its role in it: the open goal it
 * coordinates first, then any goal that lists it as a worker or verifier.
 * Null when the session has no goal. Reads the same entry as `useProjectGoals`.
 */
export function useSessionGoal(projectId: string | null | undefined, sessionId: string | null | undefined) {
  const goals = useProjectGoals(sessionId ? projectId : null);
  const all = goals.data ?? [];
  const coordinated = all.filter((g) => g.coordinatorSessionId === sessionId);
  const match =
    coordinated.find((g) => g.health.state !== 'closed') ??
    coordinated[0] ??
    all.find((g) => g.goal?.sessions?.some((s) => s.id === sessionId));
  const role = !match
    ? null
    : match.coordinatorSessionId === sessionId
      ? ('coordinator' as const)
      : (match.goal?.sessions?.find((s) => s.id === sessionId)?.role ?? null);
  return { goal: match ?? null, role, isLoading: goals.isLoading };
}

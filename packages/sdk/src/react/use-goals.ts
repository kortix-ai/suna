'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '../core/http/api-client';
import {
  getWorkspaceGoal,
  getWorkspaceGoalFiles,
  listWorkspaceGoalEvents,
  listWorkspaceGoals,
  pauseWorkspaceGoal,
  WorkspaceGoalConflictError,
  replyToWorkspaceGoal,
  restartWorkspaceGoal,
  resumeWorkspaceGoal,
  stopWorkspaceGoal,
  type ProjectGoal,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const inventory = contract('inventory');

/** A goal's health changes with time alone (a wake becomes overdue), so a mounted goal re-reads every 60 seconds. */
const goalRefetch = {
  refetchInterval: <T>(query: T) => {
    const heal = typeof inventory.refetchInterval === 'function' ? inventory.refetchInterval(query as never) : false;
    return heal || 60_000;
  },
  refetchIntervalInBackground: false,
} as const;

/**
 * Every goal in a project the caller may read (`GET /projects/:id/goals`),
 * with its capabilities and health. Pass `null` while the `goals` flag is
 * off: nothing loads. A mounted list re-reads every 60 seconds.
 */
export function useWorkspaceGoals(projectId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.goals(projectId ?? ''),
    queryFn: () => listWorkspaceGoals(projectId as string),
    enabled: !!projectId,
    ...inventory,
    ...goalRefetch,
  });
}

/** @deprecated Use `useWorkspaceGoals`. Kept permanently. */
export const useProjectGoals = useWorkspaceGoals;

/**
 * One goal by its `goal_id` (`GET /projects/:id/goals/:goalId`). The error is
 * an `ApiError`: 404 when the goal does not exist, 403 when the caller may not
 * read it. Neither is retried. A mounted goal re-reads every 60 seconds.
 */
export function useWorkspaceGoal(projectId: string | null | undefined, goalId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.goal(projectId ?? '', goalId ?? ''),
    queryFn: () => getWorkspaceGoal(projectId as string, goalId as string),
    enabled: !!projectId && !!goalId,
    ...inventory,
    ...goalRefetch,
    retry: (count, error) => !(error instanceof ApiError && (error.status === 403 || error.status === 404)) && count < 2,
  });
}

/** @deprecated Use `useWorkspaceGoal`. Kept permanently. */
export const useProjectGoal = useWorkspaceGoal;

/** The first page of one goal's audit trail (`GET …/goals/:goalId/events`), oldest first. */
export function useWorkspaceGoalEvents(projectId: string | null | undefined, goalId: string | null | undefined) {
  return useQuery({
    queryKey: qk.project.goalEvents(projectId ?? '', goalId ?? ''),
    queryFn: () => listWorkspaceGoalEvents(projectId as string, goalId as string),
    enabled: !!projectId && !!goalId,
    ...inventory,
  });
}

/** @deprecated Use `useWorkspaceGoalEvents`. Kept permanently. */
export const useProjectGoalEvents = useWorkspaceGoalEvents;

/** One goal folder's `GOAL.md` brief, `log.md`, `notes.md` and verification. */
export function useWorkspaceGoalFiles(projectId: string | null | undefined, goal: Pick<ProjectGoal, 'driveId' | 'folder'> | null) {
  return useQuery({
    queryKey: qk.project.goalFiles(projectId ?? '', goal?.folder ?? ''),
    queryFn: () => getWorkspaceGoalFiles(goal!.driveId, goal!.folder),
    enabled: !!projectId && !!goal,
    ...inventory,
  });
}

/** @deprecated Use `useWorkspaceGoalFiles`. Kept permanently. */
export const useProjectGoalFiles = useWorkspaceGoalFiles;

/**
 * The goal a session works on, and its role in it: the open goal it owns
 * first, then any goal that lists it as an owner or verifier. Null when the
 * session has no goal. Reads the same entry as `useProjectGoals`.
 */
export function useSessionGoal(projectId: string | null | undefined, sessionId: string | null | undefined) {
  const goals = useWorkspaceGoals(sessionId ? projectId : null);
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

/**
 * A person's control on one goal. `answerId` is the answer's idempotency key: keep it across retries of one answer.
 *
 * @deprecated Use `WorkspaceGoalControlInput`. Kept permanently.
 */
export type ProjectGoalControlInput = { goal: ProjectGoal } & (
  | { action: 'pause' | 'stop' | 'restart'; reason: string }
  | { action: 'resume' }
  | { action: 'answer'; text: string; answerId: string }
);

/** The workspace name of {@link ProjectGoalControlInput}: the same type. */
export type WorkspaceGoalControlInput = ProjectGoalControlInput;

/** The goal as the server returned it, into the goal entry and the list. */
function storeGoal(queryClient: QueryClient, projectId: string, goal: ProjectGoal): void {
  queryClient.setQueryData(qk.project.goal(projectId, goal.goalId), goal);
  queryClient.setQueryData<ProjectGoal[]>(qk.project.goals(projectId), (list) =>
    list ? list.map((g) => (g.goalId === goal.goalId ? goal : g)) : list,
  );
}

// The controls in flight in this page, so a double click sends one request.
const inFlight = new Map<string, Promise<ProjectGoal | null>>();

/**
 * Run one control and put the result in the cache. A second call for the same
 * goal and control while the first is in flight returns the first's promise:
 * one request. A stale revision stores the current goal (so the page shows
 * it) and rethrows `ProjectGoalConflictError`. An answer resolves to null and
 * re-reads the goal. Exported for tests; hosts use `useProjectGoalControl`.
 */
export function runWorkspaceGoalControl(queryClient: QueryClient, projectId: string, input: ProjectGoalControlInput): Promise<ProjectGoal | null> {
  const key = `${projectId}:${input.goal.goalId}:${input.action}:${input.action === 'answer' ? input.answerId : ''}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = (async () => {
    try {
      if (input.action === 'answer') {
        await replyToWorkspaceGoal(projectId, input.goal, input.text, { answerId: input.answerId });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: qk.project.goals(projectId) }),
          queryClient.invalidateQueries({ queryKey: qk.project.goalEvents(projectId, input.goal.goalId) }),
        ]);
        return null;
      }
      const result =
        input.action === 'pause'
          ? await pauseWorkspaceGoal(projectId, input.goal, input.reason)
          : input.action === 'stop'
            ? await stopWorkspaceGoal(projectId, input.goal, input.reason)
            : input.action === 'restart'
              ? await restartWorkspaceGoal(projectId, input.goal, input.reason)
              : await resumeWorkspaceGoal(projectId, input.goal);
      storeGoal(queryClient, projectId, result.projectGoal);
      void queryClient.invalidateQueries({ queryKey: qk.project.goalEvents(projectId, input.goal.goalId) });
      return result.projectGoal;
    } catch (error) {
      if (error instanceof WorkspaceGoalConflictError) storeGoal(queryClient, projectId, error.goal);
      throw error;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}

/** @deprecated Use `runWorkspaceGoalControl`. Kept permanently. */
export const runProjectGoalControl = runWorkspaceGoalControl;

/**
 * A person's goal controls (pause, resume, stop, restart, answer) as one
 * mutation. Show a control only when `goal.capabilities` allows it. Success
 * and a `409` both leave the cache holding the goal as the server has it; on
 * `ProjectGoalConflictError` tell the person the goal changed and let them
 * act again on what they now see.
 */
export function useWorkspaceGoalControl(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (input: ProjectGoalControlInput) => runWorkspaceGoalControl(queryClient, projectId, input) });
}

/** @deprecated Use `useWorkspaceGoalControl`. Kept permanently. */
export const useProjectGoalControl = useWorkspaceGoalControl;

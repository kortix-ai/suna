'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggerEventApps,
  listProjectTriggerEventTypes,
  listProjectTriggerRuns,
  listProjectTriggers,
  listTriggerRuns,
  replayTriggerRun,
  updateProjectTrigger,
  type FireProjectTriggerOptions,
  type ProjectTriggerDryRunResult,
  type ProjectTriggerRunList,
  type ProjectTriggerRunStatus,
  type FireProjectTriggerResponse,
  type ProjectTriggerEventApps,
  type ProjectTriggerEventTypes,
  type ProjectTriggerListing,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable query-key factory — reuse to read/invalidate the same cache entry
 *  `useProjectTriggers` populates. Delegates to `qk.project.triggers` — the
 *  SAME entry the Customize settings pause switch and the schedule/triggers
 *  view build directly via `qk.project.triggers(id)` too. */
export const projectTriggersKey = (projectId: string | null | undefined) =>
  qk.project.triggers(projectId ?? '');

/**
 * Project triggers (cron/webhook, file-defined in the repo manifest) — list +
 * create/update/remove/fire. Thin React Query binding over
 * `projects-client/triggers.ts`; every mutation invalidates the listing so a
 * newly created/edited/fired trigger shows up without a manual refetch.
 */
export function useProjectTriggers(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectTriggersKey(projectId);

  const query = useQuery<ProjectTriggerListing>({
    queryKey,
    queryFn: () => listProjectTriggers(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof createProjectTrigger>[1]) =>
      createProjectTrigger(projectId as string, input),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: (args: { slug: string; input: Parameters<typeof updateProjectTrigger>[2] }) =>
      updateProjectTrigger(projectId as string, args.slug, args.input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (slug: string) => deleteProjectTrigger(projectId as string, slug),
    onSuccess: invalidate,
  });

  // A real fire or a replay writes a run and moves `last_*`; the run lists sit
  // under the same key, so one invalidation refreshes both. A dry run writes nothing.
  const fire = useMutation({
    mutationFn: (args: string | ({ slug: string } & FireProjectTriggerOptions)) => {
      if (typeof args === 'string') return fireProjectTrigger(projectId as string, args, undefined);
      const { slug, ...options } = args;
      return fireProjectTrigger(projectId as string, slug, options) as Promise<
        FireProjectTriggerResponse | ProjectTriggerDryRunResult
      >;
    },
    onSuccess: (data: FireProjectTriggerResponse | ProjectTriggerDryRunResult) => {
      if (!('dry_run' in data && data.dry_run)) void invalidate();
    },
  });

  const replay = useMutation({
    mutationFn: (args: { slug: string; runId: string; confirmUnverified?: boolean }) =>
      replayTriggerRun(projectId as string, args.slug, args.runId, {
        ...(args.confirmUnverified ? { confirmUnverified: true } : {}),
      }),
    onSuccess: invalidate,
  });

  return { ...query, create, update, remove, fire, replay };
}

/** A connector slug, or an app with no connector. Slugs hold no `:`, so the two never share a key. */
export type ProjectTriggerEventTarget = string | { app: string; source?: string };

const targetKey = (target: ProjectTriggerEventTarget | null | undefined) =>
  typeof target === 'object' && target ? `app:${target.source ?? 'composio'}:${target.app}` : (target ?? '');

export const projectTriggerEventTypesKey = (
  projectId: string | null | undefined,
  target: ProjectTriggerEventTarget | null | undefined,
) => qk.project.triggerEventTypes(projectId ?? '', targetKey(target));

/** App events a connector, or an app with no connector (`{ app, source? }`), can trigger on. Idle until one is chosen. */
export function useProjectTriggerEventTypes(
  projectId: string | null | undefined,
  target: ProjectTriggerEventTarget | null | undefined,
) {
  const chosen = typeof target === 'object' && target ? target.app : target;
  return useQuery<ProjectTriggerEventTypes>({
    queryKey: projectTriggerEventTypesKey(projectId, target),
    queryFn: () => listProjectTriggerEventTypes(projectId as string, typeof target === 'object' ? (target as { app: string; source?: string }) : { connector: target as string }),
    enabled: !!projectId && !!chosen,
    ...contract('config'),
  });
}

export const projectTriggerEventAppsKey = (projectId: string | null | undefined) =>
  qk.project.triggerEventApps(projectId ?? '');

/** Apps that can trigger events, with this project's connector and connection state. */
export function useProjectTriggerEventApps(projectId: string | null | undefined) {
  return useQuery<ProjectTriggerEventApps>({
    queryKey: projectTriggerEventAppsKey(projectId),
    queryFn: () => listProjectTriggerEventApps(projectId as string),
    enabled: !!projectId,
    ...contract('config'),
  });
}

export const triggerRunsKey = (projectId: string | null | undefined, slug: string | null | undefined) =>
  qk.project.triggerRuns(projectId ?? '', slug ?? '');

export const projectTriggerRunsKey = (
  projectId: string | null | undefined,
  status?: ProjectTriggerRunStatus | null,
) => qk.project.projectTriggerRuns(projectId ?? '', status);

const nextRunsCursor = (page: ProjectTriggerRunList) => page.next_cursor ?? undefined;

/**
 * One trigger's run history, newest first, paged by `next_cursor`
 * (`fetchNextPage` / `hasNextPage`). A page can be short while more exist.
 * Idle until both ids are set. `useProjectTriggers().fire` / `.replay` refresh it.
 */
export function useTriggerRuns(projectId: string | null | undefined, slug: string | null | undefined) {
  return useInfiniteQuery({
    queryKey: triggerRunsKey(projectId, slug),
    queryFn: ({ pageParam }) => listTriggerRuns(projectId as string, slug as string, { cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextRunsCursor,
    enabled: !!projectId && !!slug,
    ...contract('volatile'),
  });
}

/** Every trigger run of the project, newest first, optionally one `status`. Same paging as {@link useTriggerRuns}. */
export function useProjectTriggerRuns(
  projectId: string | null | undefined,
  options?: { status?: ProjectTriggerRunStatus | null },
) {
  const status = options?.status ?? undefined;
  return useInfiniteQuery({
    queryKey: projectTriggerRunsKey(projectId, status),
    queryFn: ({ pageParam }) => listProjectTriggerRuns(projectId as string, { status, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: nextRunsCursor,
    enabled: !!projectId,
    ...contract('volatile'),
  });
}

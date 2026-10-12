'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggerEventApps,
  listProjectTriggerEventTypes,
  listProjectTriggers,
  updateProjectTrigger,
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

  // Firing doesn't change the listing itself (no invalidate) — it starts a
  // session and returns its id; `last_fired_at` isn't reflected until the
  // next natural list refetch.
  const fire = useMutation({
    mutationFn: (slug: string) => fireProjectTrigger(projectId as string, slug),
  });

  return { ...query, create, update, remove, fire };
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

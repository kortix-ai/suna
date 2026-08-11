'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createWorkspaceTrigger,
  deleteWorkspaceTrigger,
  fireWorkspaceTrigger,
  listWorkspaceTriggers,
  updateWorkspaceTrigger,
  type WorkspaceTriggerListing,
} from '../core/rest/workspaces-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable query-key factory — reuse to read/invalidate the same cache entry
 *  `useWorkspaceTriggers` populates. Delegates to `qk.workspace.triggers` — the
 *  SAME entry the Customize settings pause switch and the schedule/triggers
 *  view build directly via `qk.workspace.triggers(id)` too. */
export const workspaceTriggersKey = (workspaceId: string | null | undefined) =>
  qk.workspace.triggers(workspaceId ?? '');

/** @deprecated Use `workspaceTriggersKey`. */
export const projectTriggersKey = workspaceTriggersKey;

/**
 * Workspace triggers (cron/webhook, file-defined in the repo manifest) — list +
 * create/update/remove/fire. Thin React Query binding over
 * `workspaces-client/triggers.ts`; every mutation invalidates the listing so a
 * newly created/edited/fired trigger shows up without a manual refetch.
 */
export function useWorkspaceTriggers(workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = workspaceTriggersKey(workspaceId);

  const query = useQuery<WorkspaceTriggerListing>({
    queryKey,
    queryFn: () => listWorkspaceTriggers(workspaceId as string),
    enabled: !!workspaceId,
    ...contract('config'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof createWorkspaceTrigger>[1]) =>
      createWorkspaceTrigger(workspaceId as string, input),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: (args: { slug: string; input: Parameters<typeof updateWorkspaceTrigger>[2] }) =>
      updateWorkspaceTrigger(workspaceId as string, args.slug, args.input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (slug: string) => deleteWorkspaceTrigger(workspaceId as string, slug),
    onSuccess: invalidate,
  });

  // Firing doesn't change the listing itself (no invalidate) — it starts a
  // session and returns its id; `last_fired_at` isn't reflected until the
  // next natural list refetch.
  const fire = useMutation({
    mutationFn: (slug: string) => fireWorkspaceTrigger(workspaceId as string, slug),
  });

  return { ...query, create, update, remove, fire };
}

/** @deprecated Use `useWorkspaceTriggers`. */
export const useProjectTriggers = useWorkspaceTriggers;

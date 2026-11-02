'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRuntimeTrigger,
  deleteRuntimeTrigger,
  listUnifiedTriggers,
  runRuntimeTrigger,
  updateRuntimeTrigger,
  type CreateRuntimeTriggerInput,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Every trigger of a project the caller can see — kortix.yaml triggers and
 * runtime ones (loops included) — with `create`, `update` (pause/resume), `run`
 * and `remove` for the runtime ones. A runtime trigger can be a loop, so a
 * mutation refreshes the loop and kortix.yaml trigger lists as well.
 */
export function useUnifiedTriggers(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const id = projectId ?? '';
  const query = useQuery({
    queryKey: qk.project.unifiedTriggers(id),
    queryFn: () => listUnifiedTriggers(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
  });
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.unifiedTriggers(id) }),
      queryClient.invalidateQueries({ queryKey: qk.project.reminders(id) }),
      queryClient.invalidateQueries({ queryKey: qk.project.triggers(id) }),
    ]);
  const create = useMutation({
    mutationFn: (input: CreateRuntimeTriggerInput) => createRuntimeTrigger(projectId as string, input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (args: { triggerId: string; enabled: boolean }) =>
      updateRuntimeTrigger(projectId as string, args.triggerId, { enabled: args.enabled }),
    onSuccess: invalidate,
  });
  const run = useMutation({
    mutationFn: (args: { triggerId: string }) => runRuntimeTrigger(projectId as string, args.triggerId),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (args: { triggerId: string }) => deleteRuntimeTrigger(projectId as string, args.triggerId),
    onSuccess: invalidate,
  });
  return { ...query, create, update, run, remove };
}

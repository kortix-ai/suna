'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createProjectAutomation,
  deleteProjectAutomation,
  listProjectAutomations,
  runProjectAutomation,
  updateProjectAutomation,
  type CreateProjectAutomationInput,
} from '../core/rest/projects-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/**
 * Every automation of a project the caller can see — kortix.yaml triggers and
 * runtime ones (loops included) — with `create`, `update` (pause/resume), `run`
 * and `remove` for the runtime ones. A runtime automation is a loop too, so a
 * mutation refreshes the loop and trigger lists as well.
 */
export function useProjectAutomations(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const id = projectId ?? '';
  const query = useQuery({
    queryKey: qk.project.automations(id),
    queryFn: () => listProjectAutomations(projectId as string),
    enabled: !!projectId,
    ...contract('inventory'),
  });
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.automations(id) }),
      queryClient.invalidateQueries({ queryKey: qk.project.reminders(id) }),
      queryClient.invalidateQueries({ queryKey: qk.project.triggers(id) }),
    ]);
  const create = useMutation({
    mutationFn: (input: CreateProjectAutomationInput) => createProjectAutomation(projectId as string, input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (args: { automationId: string; enabled: boolean }) =>
      updateProjectAutomation(projectId as string, args.automationId, { enabled: args.enabled }),
    onSuccess: invalidate,
  });
  const run = useMutation({
    mutationFn: (args: { automationId: string }) => runProjectAutomation(projectId as string, args.automationId),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (args: { automationId: string }) => deleteProjectAutomation(projectId as string, args.automationId),
    onSuccess: invalidate,
  });
  return { ...query, create, update, run, remove };
}

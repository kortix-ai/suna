'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deletePersonalProjectSecret,
  deleteProjectSecret,
  listProjectSecrets,
  setPersonalProjectSecret,
  upsertProjectSecret,
  type ProjectSecretsResponse,
} from '../platform/projects-client';

/** Stable query-key factory — reuse this to read/invalidate the same cache
 *  entry `useProjectSecrets` populates (e.g. from a settings page shell that
 *  doesn't itself call the hook). */
export const projectSecretsKey = (projectId: string | null | undefined) =>
  ['project-secrets', projectId] as const;

/**
 * Project secrets — list + the mutations a settings screen needs (shared
 * upsert/remove, personal-override set/remove). Thin React Query binding
 * over `projects-client/secrets.ts`; every mutation invalidates the list so
 * the UI reflects the write without a manual refetch.
 */
export function useProjectSecrets(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = projectSecretsKey(projectId);

  const query = useQuery<ProjectSecretsResponse>({
    queryKey,
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const upsert = useMutation({
    mutationFn: (input: Parameters<typeof upsertProjectSecret>[1]) =>
      upsertProjectSecret(projectId as string, input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (name: string) => deleteProjectSecret(projectId as string, name),
    onSuccess: invalidate,
  });

  const setPersonal = useMutation({
    mutationFn: (args: { name: string; input: Parameters<typeof setPersonalProjectSecret>[2] }) =>
      setPersonalProjectSecret(projectId as string, args.name, args.input),
    onSuccess: invalidate,
  });

  const removePersonal = useMutation({
    mutationFn: (name: string) => deletePersonalProjectSecret(projectId as string, name),
    onSuccess: invalidate,
  });

  return { ...query, upsert, remove, setPersonal, removePersonal };
}

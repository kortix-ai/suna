'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deletePersonalWorkspaceSecret,
  deleteWorkspaceSecret,
  listWorkspaceSecrets,
  setPersonalWorkspaceSecret,
  upsertWorkspaceSecret,
  type WorkspaceSecretsResponse,
} from '../core/rest/workspaces-client';
import { contract } from './query-contracts';
import { qk } from './query-keys';

/** Stable query-key factory — reuse this to read/invalidate the same cache
 *  entry `useWorkspaceSecrets` populates (e.g. from a settings page shell that
 *  doesn't itself call the hook). Delegates to `qk.workspace.secrets` — the
 *  SAME entry every other `listWorkspaceSecrets` reader in `apps/web` shares
 *  (Customize secrets view, agents view, connected-providers, the LLM
 *  provider connect forms). */
export const workspaceSecretsKey = (workspaceId: string | null | undefined) =>
  qk.workspace.secrets(workspaceId ?? '');

/** @deprecated Use `workspaceSecretsKey`. */
export const projectSecretsKey = workspaceSecretsKey;

/**
 * Workspace secrets — list + the mutations a settings screen needs (shared
 * upsert/remove, personal-override set/remove). Thin React Query binding
 * over `workspaces-client/secrets.ts`; every mutation invalidates the list so
 * the UI reflects the write without a manual refetch.
 */
export function useWorkspaceSecrets(workspaceId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = workspaceSecretsKey(workspaceId);

  const query = useQuery<WorkspaceSecretsResponse>({
    queryKey,
    queryFn: () => listWorkspaceSecrets(workspaceId as string),
    enabled: !!workspaceId,
    ...contract('config'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const upsert = useMutation({
    mutationFn: (input: Parameters<typeof upsertWorkspaceSecret>[1]) =>
      upsertWorkspaceSecret(workspaceId as string, input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (name: string) => deleteWorkspaceSecret(workspaceId as string, name),
    onSuccess: invalidate,
  });

  const setPersonal = useMutation({
    mutationFn: (args: { name: string; input: Parameters<typeof setPersonalWorkspaceSecret>[2] }) =>
      setPersonalWorkspaceSecret(workspaceId as string, args.name, args.input),
    onSuccess: invalidate,
  });

  const removePersonal = useMutation({
    mutationFn: (name: string) => deletePersonalWorkspaceSecret(workspaceId as string, name),
    onSuccess: invalidate,
  });

  return { ...query, upsert, remove, setPersonal, removePersonal };
}

/** @deprecated Use `useWorkspaceSecrets`. */
export const useProjectSecrets = useWorkspaceSecrets;

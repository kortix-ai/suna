'use client';

import { useQuery } from '@tanstack/react-query';

import {
  getComposerCapabilities,
  getComposerModelCatalog,
  listHarnessConnections,
  type HarnessAuthKind,
} from '../core/rest/projects-client';

type ComposerQueryClient = {
  invalidateQueries(input: { queryKey: readonly unknown[] }): Promise<unknown> | unknown;
};

/**
 * Invalidate the complete server-authoritative composer dependency graph after
 * credential, entitlement, active-route, or agent configuration changes.
 * Legacy keys stay here until their compatibility hooks are removed, so hosts
 * have one correct invalidation entry point during the migration.
 */
export async function invalidateComposerCapabilityQueries(
  queryClient: ComposerQueryClient,
  projectId: string,
): Promise<void> {
  for (const queryKey of [
    ['project', projectId],
    ['project-llm-catalog', projectId],
    ['project-secrets', projectId],
    ['harness-connections', projectId],
  ] as const) {
    await queryClient.invalidateQueries({ queryKey });
  }
}

export function useHarnessConnections(projectId?: string | null) {
  return useQuery({
    queryKey: ['project', projectId, 'harness-connections'],
    queryFn: () => listHarnessConnections(projectId!),
    enabled: Boolean(projectId),
    staleTime: 10_000,
  });
}

export function useComposerCapabilities(
  projectId?: string | null,
  agentName?: string | null,
  connectionId?: HarnessAuthKind | null,
) {
  return useQuery({
    queryKey: ['project', projectId, 'composer-capabilities', agentName, connectionId ?? null],
    queryFn: () => getComposerCapabilities(projectId!, agentName!, connectionId),
    enabled: Boolean(projectId && agentName),
    staleTime: 10_000,
  });
}

export function useComposerModelCatalog(
  projectId?: string | null,
  agentName?: string | null,
  connectionId?: HarnessAuthKind | null,
) {
  return useQuery({
    queryKey: ['project', projectId, 'composer-model-catalog', agentName, connectionId ?? null],
    queryFn: () => getComposerModelCatalog(projectId!, { agentName: agentName!, connectionId }),
    enabled: Boolean(projectId && agentName),
    staleTime: 10_000,
  });
}

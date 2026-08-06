import type { ProjectSecret, ProjectSecretsResponse } from '@kortix/sdk';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

export type ProjectSecretsCache = ProjectSecretsResponse | ProjectSecret[];

export type OptimisticProjectSecretInput = {
  projectId: string;
  identifier: string;
  name: string;
  strategy: ProjectSecret['strategy'];
  consumer: ProjectSecret['consumer'];
  deliveryStatus: NonNullable<ProjectSecret['delivery_status']>;
  egressPolicy: ProjectSecret['egress_policy'];
  valueChanged?: boolean;
};

function items(cache: ProjectSecretsCache): ProjectSecret[] {
  return Array.isArray(cache) ? cache : cache.items;
}

function withItems(cache: ProjectSecretsCache, nextItems: ProjectSecret[]): ProjectSecretsCache {
  return Array.isArray(cache) ? nextItems : { ...cache, items: nextItems };
}

function replaceOrAppend(
  cache: ProjectSecretsCache,
  identifier: string,
  nextSecret: ProjectSecret,
): ProjectSecretsCache {
  const currentItems = items(cache);
  const index = currentItems.findIndex((secret) => secret.identifier === identifier);
  if (index === -1) return withItems(cache, [...currentItems, nextSecret]);
  const nextItems = currentItems.slice();
  nextItems[index] = nextSecret;
  return withItems(cache, nextItems);
}

export function applyOptimisticProjectSecretSave(
  cache: ProjectSecretsCache,
  input: OptimisticProjectSecretInput,
): ProjectSecretsCache {
  const existing = items(cache).find((secret) => secret.identifier === input.identifier);
  const nextSecret: ProjectSecret = {
    identifier: input.identifier,
    name: input.name,
    project_id: existing?.project_id ?? input.projectId,
    secret_id: existing?.secret_id ?? null,
    created_by: existing?.created_by ?? null,
    created_at: existing?.created_at ?? null,
    updated_at: existing?.updated_at ?? null,
    system: existing?.system ?? false,
    readonly: existing?.readonly ?? false,
    purpose: existing?.purpose ?? null,
    can_rotate: existing?.can_rotate ?? true,
    managed_by: existing?.managed_by ?? null,
    configured: true,
    mine: existing?.mine ?? null,
    effective_source: 'shared',
    can_manage_shared: existing?.can_manage_shared ?? true,
    strategy: input.strategy,
    consumer: input.consumer,
    delivery_status: input.deliveryStatus,
    egress_policy: input.egressPolicy,
    strategy_locked: existing?.strategy_locked ?? false,
    last_rotated_at: existing?.last_rotated_at ?? null,
    requires_rotation: input.valueChanged ? false : (existing?.requires_rotation ?? false),
  };
  return replaceOrAppend(cache, input.identifier, nextSecret);
}

export function beginOptimisticProjectSecretSave(
  queryClient: QueryClient,
  queryKey: QueryKey,
  input: OptimisticProjectSecretInput,
): { previous: ProjectSecretsCache | undefined } {
  const previous = queryClient.getQueryData<ProjectSecretsCache>(queryKey);
  if (previous) {
    queryClient.setQueryData<ProjectSecretsCache>(
      queryKey,
      applyOptimisticProjectSecretSave(previous, input),
    );
  }
  return { previous };
}

export function rollbackOptimisticProjectSecretSave(
  queryClient: QueryClient,
  queryKey: QueryKey,
  previous: ProjectSecretsCache | undefined,
): void {
  if (previous) queryClient.setQueryData(queryKey, previous);
}

export function applyProjectSecretResponse(
  cache: ProjectSecretsCache,
  updated: ProjectSecret,
): ProjectSecretsCache {
  return replaceOrAppend(cache, updated.identifier, updated);
}

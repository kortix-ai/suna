import type { WorkspaceSecret, WorkspaceSecretsResponse } from '@kortix/sdk';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

export type WorkspaceSecretsCache = WorkspaceSecretsResponse | WorkspaceSecret[];

export type OptimisticWorkspaceSecretInput = {
  workspaceId: string;
  identifier: string;
  name: string;
  strategy: WorkspaceSecret['strategy'];
  consumer: WorkspaceSecret['consumer'];
  deliveryStatus: NonNullable<WorkspaceSecret['delivery_status']>;
  egressPolicy: WorkspaceSecret['egress_policy'];
  valueChanged?: boolean;
};

function items(cache: WorkspaceSecretsCache): WorkspaceSecret[] {
  return Array.isArray(cache) ? cache : cache.items;
}

function withItems(cache: WorkspaceSecretsCache, nextItems: WorkspaceSecret[]): WorkspaceSecretsCache {
  return Array.isArray(cache) ? nextItems : { ...cache, items: nextItems };
}

function replaceOrAppend(
  cache: WorkspaceSecretsCache,
  identifier: string,
  nextSecret: WorkspaceSecret,
): WorkspaceSecretsCache {
  const currentItems = items(cache);
  const index = currentItems.findIndex((secret) => secret.identifier === identifier);
  if (index === -1) return withItems(cache, [...currentItems, nextSecret]);
  const nextItems = currentItems.slice();
  nextItems[index] = nextSecret;
  return withItems(cache, nextItems);
}

export function applyOptimisticWorkspaceSecretSave(
  cache: WorkspaceSecretsCache,
  input: OptimisticWorkspaceSecretInput,
): WorkspaceSecretsCache {
  const existing = items(cache).find((secret) => secret.identifier === input.identifier);
  const nextSecret: WorkspaceSecret = {
    identifier: input.identifier,
    name: input.name,
    workspace_id: existing?.workspace_id ?? input.workspaceId,
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

export function beginOptimisticWorkspaceSecretSave(
  queryClient: QueryClient,
  queryKey: QueryKey,
  input: OptimisticWorkspaceSecretInput,
): { previous: WorkspaceSecretsCache | undefined } {
  const previous = queryClient.getQueryData<WorkspaceSecretsCache>(queryKey);
  if (previous) {
    queryClient.setQueryData<WorkspaceSecretsCache>(
      queryKey,
      applyOptimisticWorkspaceSecretSave(previous, input),
    );
  }
  return { previous };
}

export function rollbackOptimisticWorkspaceSecretSave(
  queryClient: QueryClient,
  queryKey: QueryKey,
  previous: WorkspaceSecretsCache | undefined,
): void {
  if (previous) queryClient.setQueryData(queryKey, previous);
}

export function applyWorkspaceSecretResponse(
  cache: WorkspaceSecretsCache,
  updated: WorkspaceSecret,
): WorkspaceSecretsCache {
  return replaceOrAppend(cache, updated.identifier, updated);
}

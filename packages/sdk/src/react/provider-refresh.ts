'use client';

import type { QueryClient } from '@tanstack/react-query';

import { listProjectSecrets } from '../core/rest/projects-client';
import { connectedGatewayProviderIdsFromSecretNames } from './provider-selection';
import { configKeys } from './use-opencode-config';
import { clearProjectProviderCache, opencodeKeys } from './use-opencode-sessions';

type RefreshProjectProviderStateOptions = {
  removeProjectScopedCache?: boolean;
  /**
   * Provider id (e.g. 'anthropic', 'codex') whose credential was just saved.
   * When set, the refresh keeps polling until the project's secrets actually
   * resolve that provider as connected — instead of a fixed retry window that
   * a slow save/opencode restart can outlive, leaving the picker stale until
   * a hard page refresh.
   */
  expectProviderId?: string;
};

const CONVERGE_POLL_MS = 2_500;
const CONVERGE_DEADLINE_MS = 45_000;

/**
 * Whether a raw secrets-list response resolves `expectedProviderId` as a
 * connected gateway provider. Pure — the convergence signal for the
 * poll-until-connected refresh below.
 */
export function providerConnectedInSecrets(
  secrets: unknown,
  expectedProviderId: string,
): boolean {
  const items = Array.isArray(secrets)
    ? secrets
    : ((secrets as { items?: Array<{ name?: unknown }> } | null | undefined)?.items ?? []);
  const names = new Set<string>();
  for (const item of items) {
    if (item && typeof (item as { name?: unknown }).name === 'string') {
      names.add((item as { name: string }).name);
    }
  }
  return connectedGatewayProviderIdsFromSecretNames(names).has(expectedProviderId);
}

function invalidateProviderQueries(queryClient: QueryClient, projectId: string): void {
  const projectProviderKey = ['project-providers', projectId];
  clearProjectProviderCache(projectId);
  void queryClient.invalidateQueries({ queryKey: projectProviderKey });
  void queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
  void queryClient.refetchQueries({ queryKey: ['project-secrets', projectId], type: 'all' });
  void queryClient.refetchQueries({ queryKey: projectProviderKey, type: 'all' });
  void queryClient.invalidateQueries({ queryKey: opencodeKeys.providers() });
  void queryClient.invalidateQueries({ queryKey: configKeys.all });
}

export function refreshProjectProviderState(
  queryClient: QueryClient,
  projectId: string,
  opts: RefreshProjectProviderStateOptions = {},
): void {
  const projectProviderKey = ['project-providers', projectId];
  if (opts.removeProjectScopedCache) {
    queryClient.removeQueries({ queryKey: projectProviderKey });
  }
  invalidateProviderQueries(queryClient, projectId);

  if (typeof window === 'undefined') return;

  // Saving provider credentials hot-pushes env vars into active sandboxes and
  // restarts OpenCode; the secret write itself can also land after the save
  // call returns. A refetch that races either one accepts the OLD state as
  // final — and with staleTime:Infinity on the provider list nothing ever asks
  // again, so the picker stays stale until a hard refresh. So: don't fire a
  // fixed number of blind retries — poll until the connected state actually
  // CONVERGES (the expected provider resolves from the project's secrets),
  // then do one final refresh burst and stop.
  const expected = opts.expectProviderId;
  if (!expected) {
    for (const delay of [500, 1500, 3000, 6000]) {
      window.setTimeout(() => invalidateProviderQueries(queryClient, projectId), delay);
    }
    return;
  }

  const startedAt = Date.now();
  const poll = async (): Promise<void> => {
    let connected = false;
    try {
      const secrets = await queryClient.fetchQuery({
        queryKey: ['project-secrets', projectId],
        queryFn: () => listProjectSecrets(projectId),
        staleTime: 0,
      });
      connected = providerConnectedInSecrets(secrets, expected);
    } catch {
      // transient fetch failure — keep polling until the deadline
    }
    if (connected) {
      invalidateProviderQueries(queryClient, projectId);
      return;
    }
    if (Date.now() - startedAt >= CONVERGE_DEADLINE_MS) return;
    window.setTimeout(() => void poll(), CONVERGE_POLL_MS);
  };
  window.setTimeout(() => void poll(), CONVERGE_POLL_MS);
}

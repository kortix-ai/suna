import type { QueryClient } from '@tanstack/react-query';

import { configKeys } from './use-opencode-config';
import { clearProjectProviderCache, opencodeKeys } from './use-opencode-sessions';

type RefreshProjectProviderStateOptions = {
  removeProjectScopedCache?: boolean;
};

export function refreshProjectProviderState(
  queryClient: QueryClient,
  projectId: string,
  opts: RefreshProjectProviderStateOptions = {},
): void {
  const projectProviderKey = ['project-providers', projectId];
  clearProjectProviderCache(projectId);
  if (opts.removeProjectScopedCache) {
    queryClient.removeQueries({ queryKey: projectProviderKey });
  }
  queryClient.invalidateQueries({ queryKey: projectProviderKey });
  queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
  queryClient.invalidateQueries({ queryKey: opencodeKeys.providers() });
  queryClient.invalidateQueries({ queryKey: configKeys.all });

  // Saving provider credentials hot-pushes env vars into active sandboxes and
  // restarts OpenCode. A single immediate refetch can race that restart and
  // accept the old native provider list as final, so follow up a few times.
  if (typeof window === 'undefined') return;
  for (const delay of [500, 1500, 3000, 6000]) {
    window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: projectProviderKey });
      void queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
      void queryClient.refetchQueries({ queryKey: ['project-secrets', projectId], type: 'all' });
      void queryClient.refetchQueries({ queryKey: projectProviderKey, type: 'active' });
    }, delay);
  }
}

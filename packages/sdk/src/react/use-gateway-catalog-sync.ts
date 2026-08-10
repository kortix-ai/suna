'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listWorkspaceSecrets } from '../core/rest/workspaces-client';
import { refreshWorkspaceProviderState } from './provider-refresh';
import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';
import { contract } from './query-contracts';
import { qk } from './query-keys';

const REFETCH_DELAYS_MS = [0, 1200, 3000, 6000];

export function useGatewayCatalogSync(workspaceId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const runtimeReady = useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);

  const secretsQuery = useQuery({
    // Same entry every other `listWorkspaceSecrets` reader shares.
    queryKey: qk.workspace.secrets(workspaceId ?? ''),
    queryFn: () => listWorkspaceSecrets(workspaceId as string),
    enabled: !!workspaceId && runtimeReady,
    ...contract('config'),
  });

  const signature = (() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return items.map((item) => item.name).sort().join(',');
  })();

  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (!workspaceId || secretsQuery.data === undefined) return;
    if (previous.current === null) {
      previous.current = signature;
      return;
    }
    if (previous.current === signature) return;
    previous.current = signature;

    const timers = REFETCH_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        refreshWorkspaceProviderState(queryClient, workspaceId);
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [workspaceId, signature, secretsQuery.data, queryClient]);
}

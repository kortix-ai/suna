'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listProjectSecrets } from '../platform/projects-client';
import { refreshProjectProviderState } from './provider-refresh';
import { useSandboxConnectionStore } from '../state/sandbox-connection-store';

const REFETCH_DELAYS_MS = [0, 1200, 3000, 6000];

export function useGatewayCatalogSync(projectId: string | null | undefined): void {
  const queryClient = useQueryClient();
  const runtimeReady = useSandboxConnectionStore((s) => s.status === 'connected' && s.healthy === true);

  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId as string),
    enabled: !!projectId && runtimeReady,
    staleTime: 10_000,
  });

  const signature = (() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return items.map((item) => item.name).sort().join(',');
  })();

  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || secretsQuery.data === undefined) return;
    if (previous.current === null) {
      previous.current = signature;
      return;
    }
    if (previous.current === signature) return;
    previous.current = signature;

    const timers = REFETCH_DELAYS_MS.map((delay) =>
      setTimeout(() => {
        refreshProjectProviderState(queryClient, projectId);
      }, delay),
    );
    return () => timers.forEach(clearTimeout);
  }, [projectId, signature, secretsQuery.data, queryClient]);
}

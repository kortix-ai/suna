import { listConnectors } from '@kortix/sdk';

export const PROJECT_CONNECTORS_STALE_MS = 10_000;

export function projectConnectorsQuery(projectId: string) {
  return {
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    staleTime: PROJECT_CONNECTORS_STALE_MS,
    refetchOnMount: true,
  };
}

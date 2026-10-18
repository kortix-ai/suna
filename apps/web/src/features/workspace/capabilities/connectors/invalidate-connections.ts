import { connectorConnectionQueryKeys } from '@/features/workspace/customize/sections/connector-connection-form';
import type { QueryClient } from '@tanstack/react-query';
export function invalidateConnections(client: QueryClient, projectId: string) {
  return Promise.all(
    connectorConnectionQueryKeys(projectId).map((queryKey) =>
      client.invalidateQueries({ queryKey }).catch(() => undefined),
    ),
  );
}

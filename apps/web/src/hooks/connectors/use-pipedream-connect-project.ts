'use client';

import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import {
  pipedreamConnectConnection,
  pipedreamFinalizeConnection,
  reconcileConnection,
} from '@kortix/sdk';

/**
 * Connect a labelled project-owned account under one connector.
 */
export function usePipedreamConnectProject(
  projectId: string,
  slug: string,
  onConnected: () => void,
) {
  return useMutation({
    mutationFn: async (input?: { label?: string }) => {
      let connectionId: string | null = null;
      return runConnectLinkFlow(
        async () => {
          const connection = await reconcileConnection(projectId, {
            connector_alias: slug,
            owner_type: 'project',
            label: input?.label?.trim() || 'Project connection',
          });
          connectionId = connection.connection_id;
          return pipedreamConnectConnection(projectId, connection.connection_id);
        },
        () => {
          if (!connectionId) throw new Error('The project connection was not created.');
          return pipedreamFinalizeConnection(projectId, connectionId);
        },
      );
    },
    onSuccess: (result) => {
      if (!result.connected) return;
      successToast('Project connection created');
      onConnected();
    },
    onError: (error: Error) => errorToast(error.message),
  });
}

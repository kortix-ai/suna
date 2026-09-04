'use client';

import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import {
  pipedreamConnectConnection,
  pipedreamFinalizeConnection,
  reconcileMemberConnection,
} from '@kortix/sdk';

/**
 * Connect the current user's private account for a connector.
 */
export function usePipedreamConnectMember(
  projectId: string,
  slug: string,
  onConnected: () => void,
) {
  return useMutation({
    mutationFn: async (input?: { label?: string }) => {
      let connectionId: string | null = null;
      return runConnectLinkFlow(
        async () => {
          const connection = await reconcileMemberConnection(projectId, {
            connector_alias: slug,
            label: input?.label?.trim() || 'Private connection',
          });
          connectionId = connection.connection_id;
          return pipedreamConnectConnection(projectId, connection.connection_id);
        },
        () => {
          if (!connectionId) throw new Error('The private connection was not created.');
          return pipedreamFinalizeConnection(projectId, connectionId);
        },
      );
    },
    onSuccess: (res) => {
      if (!res.connected) return;
      successToast('Connected privately — only you can use this');
      onConnected();
    },
    onError: (err: Error) => errorToast(err.message),
  });
}

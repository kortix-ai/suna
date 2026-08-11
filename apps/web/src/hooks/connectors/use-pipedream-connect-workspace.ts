'use client';

import { createFrontendClient } from '@pipedream/sdk/browser';
import { useMutation } from '@tanstack/react-query';

import { errorToast, successToast } from '@/components/ui/toast';
import { withPipedreamOverlayEscape } from '@/hooks/connectors/use-pipedream-connect-member';
import {
  pipedreamConnectConnection,
  pipedreamFinalizeConnection,
  reconcileConnection,
} from '@kortix/sdk';

/**
 * Create and connect one workspace-owned connection.
 *
 * The API enforces the workspace connector-connection management capability.
 */
export function usePipedreamConnectWorkspace(
  workspaceId: string,
  slug: string,
  onConnected: () => void,
) {
  return useMutation({
    mutationFn: async (input?: { label?: string }) => {
      const connection = await reconcileConnection(workspaceId, {
        connector_alias: slug,
        owner_type: 'workspace',
        label: input?.label?.trim() || 'Workspace connection',
      });
      const { token, app } = await pipedreamConnectConnection(
        workspaceId,
        connection.connection_id,
      );
      if (!token || !app) throw new Error('App connect is not configured');

      const client = createFrontendClient({
        externalUserId: `${workspaceId}:${slug}:${connection.connection_id}`,
        tokenCallback: async () => ({ token, connect_link_url: undefined, expires_at: '' }) as any,
      });
      const release = withPipedreamOverlayEscape();
      let connected = false;
      try {
        connected = await new Promise<boolean>((resolve, reject) => {
          client.connectAccount({
            app,
            token,
            onSuccess: () => resolve(true),
            onClose: (status: { successful: boolean }) => resolve(status.successful),
            onError: (error: unknown) =>
              reject(new Error((error as Error)?.message || 'Connection cancelled')),
          });
        });
      } finally {
        release();
      }
      if (!connected) return { connected: false };

      await pipedreamFinalizeConnection(workspaceId, connection.connection_id);
      return { connected: true };
    },
    onSuccess: (result) => {
      if (!result.connected) return;
      successToast('Workspace connection created');
      onConnected();
    },
    onError: (error: Error) => errorToast(error.message),
  });
}

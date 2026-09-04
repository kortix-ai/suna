'use client';

import { useMutation } from '@tanstack/react-query';

import {
  type ConnectorConnectResult,
  type ConnectorAuthorizationStrategy,
  createConnector,
  pipedreamConnect,
  pipedreamConnectConnection,
  pipedreamFinalize,
  pipedreamFinalizeConnection,
  reconcileMemberConnection,
} from '@kortix/sdk';

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  buildEasyConnectConnectorDraft,
  connectorSyncErrorForSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';

export interface ToolConnectInput {
  appSlug: string;
  appName: string;
  provider?: 'composio' | 'pipedream';
  connectorName: string;
  connectorSlug: string;
  authorizationStrategy: ConnectorAuthorizationStrategy;
}

export function buildToolConnectorDraft(input: ToolConnectInput) {
  return buildEasyConnectConnectorDraft(
    { slug: input.appSlug, name: input.appName, provider: input.provider },
    {
      name: input.connectorName,
      slug: input.connectorSlug,
      authorizationStrategy: input.authorizationStrategy,
    },
  );
}

export async function requestToolAuthorization(
  projectId: string,
  input: ToolConnectInput,
  deps: {
    connectProject: typeof pipedreamConnect;
    reconcileMember: typeof reconcileMemberConnection;
    connectMember: typeof pipedreamConnectConnection;
  },
): Promise<Omit<ConnectorConnectResult, 'connectionId'> & { connectionId: string | null }> {
  if (input.authorizationStrategy === 'user') {
    const connection = await deps.reconcileMember(projectId, {
      connector_alias: input.connectorSlug,
      label: input.connectorName.trim(),
    });
    const connect = await deps.connectMember(projectId, connection.connection_id);
    return { ...connect, connectionId: connection.connection_id };
  }
  const connect = await deps.connectProject(projectId, input.connectorSlug);
  return { ...connect, connectionId: null };
}

export function useToolConnect(projectId: string, onConnected: () => void) {
  return useMutation({
    mutationFn: async (input: ToolConnectInput) => {
      const draft = buildToolConnectorDraft(input);
      const created = await createConnector(projectId, draft);
      const syncError = connectorSyncErrorForSlug(created, draft.slug);
      if (syncError) {
        return {
          slug: draft.slug,
          connected: false,
          syncError,
          connectError: null,
        };
      }

      try {
        let connectionId: string | null = null;
        const connected = await runConnectLinkFlow(
          async () => {
            const authorization = await requestToolAuthorization(projectId, input, {
              connectProject: pipedreamConnect,
              reconcileMember: reconcileMemberConnection,
              connectMember: pipedreamConnectConnection,
            });
            connectionId = authorization.connectionId;
            const { connectionId: _connectionId, ...connect } = authorization;
            return connect;
          },
          () =>
            connectionId
              ? pipedreamFinalizeConnection(projectId, connectionId)
              : pipedreamFinalize(projectId, draft.slug),
        );

        if (!connected.connected) {
          return {
            slug: draft.slug,
            connected: false,
            syncError: null,
            connectError: null,
          };
        }
        return {
          slug: draft.slug,
          connected: true,
          syncError: null,
          connectError: null,
        };
      } catch (error) {
        return {
          slug: draft.slug,
          connected: false,
          syncError: null,
          connectError: error instanceof Error ? error.message : String(error),
        };
      }
    },
    onSuccess: (res) => {
      onConnected();
      if (res.syncError) {
        warningToast(
          `Added the connector to the manifest, but synchronization failed: ${res.syncError}. Use Sync to retry.`,
        );
        return;
      }
      if (res.connectError) {
        warningToast(`Added the connector, but authorization failed: ${res.connectError}`);
        return;
      }
      if (res.connected) successToast('Connected');
    },
    onError: (err: Error) => errorToast(err.message),
  });
}

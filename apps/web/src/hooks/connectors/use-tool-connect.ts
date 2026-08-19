'use client';

import { useMutation } from '@tanstack/react-query';

import {
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

const PIPEDREAM_IFRAME_SELECTOR = 'iframe[id^="pipedream-connect-iframe-"]';

export interface ToolConnectInput {
  appSlug: string;
  appName: string;
  connectorName: string;
  connectorSlug: string;
  authorizationStrategy: ConnectorAuthorizationStrategy;
}

export function buildToolConnectorDraft(input: ToolConnectInput) {
  return buildEasyConnectConnectorDraft(
    { slug: input.appSlug, name: input.appName },
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
): Promise<{ token?: string; app?: string; connectionId: string | null }> {
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

function withPipedreamOverlayEscape(): () => void {
  if (typeof document === 'undefined') return () => {};
  const releasePointerEvents = () => {
    document.querySelectorAll<HTMLIFrameElement>(PIPEDREAM_IFRAME_SELECTOR).forEach((el) => {
      el.style.pointerEvents = 'auto';
    });
  };
  const observer = new MutationObserver(releasePointerEvents);
  observer.observe(document.body, { childList: true });
  releasePointerEvents();

  const isPipedreamFrame = (node: EventTarget | null): boolean =>
    node instanceof Element && node.matches(PIPEDREAM_IFRAME_SELECTOR);
  const guardFocus = (event: FocusEvent) => {
    if (isPipedreamFrame(event.target) || isPipedreamFrame(event.relatedTarget)) {
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener('focusin', guardFocus, true);
  document.addEventListener('focusout', guardFocus, true);

  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', guardFocus, true);
    document.removeEventListener('focusout', guardFocus, true);
  };
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
        const { token, app, connectionId } = await requestToolAuthorization(projectId, input, {
          connectProject: pipedreamConnect,
          reconcileMember: reconcileMemberConnection,
          connectMember: pipedreamConnectConnection,
        });
        if (!token || !app) throw new Error('This app is not available to connect right now');

        const { createFrontendClient } = await import('@pipedream/sdk/browser');
        const pd = createFrontendClient({
          externalUserId: `${projectId}:${draft.slug}${connectionId ? `:${connectionId}` : ''}`,
          tokenCallback: async () => ({
            token,
            connectLinkUrl: '',
            expiresAt: new Date(Date.now() + 10 * 60_000),
          }),
        });

        const release = withPipedreamOverlayEscape();
        let connected = false;
        try {
          connected = await new Promise<boolean>((resolve, reject) => {
            pd.connectAccount({
              app,
              token,
              onSuccess: () => resolve(true),
              onClose: (status: { successful: boolean }) => resolve(status.successful),
              onError: (err: unknown) =>
                reject(new Error((err as Error)?.message || 'Connection cancelled')),
            });
          });
        } finally {
          release();
        }

        if (!connected) {
          return {
            slug: draft.slug,
            connected: false,
            syncError: null,
            connectError: null,
          };
        }
        if (connectionId) {
          await pipedreamFinalizeConnection(projectId, connectionId);
        } else {
          await pipedreamFinalize(projectId, draft.slug);
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

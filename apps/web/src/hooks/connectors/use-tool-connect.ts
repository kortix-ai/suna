'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';

import {
  type ConnectorConnectResult,
  createConnector,
  pipedreamConnect,
  pipedreamFinalize,
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
}

export function buildToolConnectorDraft(input: ToolConnectInput) {
  return buildEasyConnectConnectorDraft(
    { slug: input.appSlug, name: input.appName, provider: input.provider },
    { name: input.connectorName, slug: input.connectorSlug },
  );
}

/**
 * Authorize the connector the catalogue just added, as the PROJECT's shared
 * account.
 *
 * Adding a tool here is a project act — everyone who may use the connector gets
 * the account. Personal accounts are added afterwards, per person, from the
 * connector's Accounts tab ("Add my own", `usePipedreamConnectMember`); they are
 * no longer an exclusive alternative that has to be chosen up front.
 */
export async function requestToolAuthorization(
  projectId: string,
  input: ToolConnectInput,
  deps: { connectProject: typeof pipedreamConnect },
): Promise<ConnectorConnectResult> {
  return deps.connectProject(projectId, input.connectorSlug);
}

export function useToolConnect(projectId: string, onConnected: () => void) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
        const connected = await runConnectLinkFlow(
          () =>
            requestToolAuthorization(projectId, input, { connectProject: pipedreamConnect }),
          () => pipedreamFinalize(projectId, draft.slug),
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
        warningToast(tI18nComplete('text1a425eb8b2b6', { value0: res.syncError }));
        return;
      }
      if (res.connectError) {
        warningToast(tI18nComplete('text7d870610b59d', { value0: res.connectError }));
        return;
      }
      if (res.connected) successToast(tI18nComplete.raw('text22965568d22a'));
    },
    onError: (err: Error) => errorToast(err.message),
  });
}

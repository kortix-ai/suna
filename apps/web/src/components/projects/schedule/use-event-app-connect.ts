'use client';

/**
 * Add an app to the project and connect its shared account without leaving the
 * trigger form. One hook for the create modal, the detail sheet and the list.
 *
 * An event trigger runs on the project's shared account, so this always
 * connects as the project (`connectApp` -> `owner: 'project'`). The popup opens
 * synchronously inside the click, before any request.
 */

import { errorToast, successToast } from '@/components/ui/toast';
import { connectApp } from '@/components/projects/onboarding/connect-app';
import {
  buildEasyConnectConnectorDraft,
  connectorConnectionQueryKeys,
  connectorSyncErrorForSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { createConnector, listConnectors } from '@kortix/sdk';
import {
  contract,
  projectTriggerEventAppsKey,
  qk,
  useProjectAccountId,
} from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { newConnectorSlug } from './event-trigger-copy';

/** The app to connect. `connector` is the project's slug for it, null until it is added. */
export interface EventAppTarget {
  /** Provider app slug, e.g. `linear`. */
  app: string;
  name: string;
  connector: string | null;
}

export function useEventAppConnect(projectId: string) {
  const queryClient = useQueryClient();
  const accountId = useProjectAccountId(projectId);
  const canConnect =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId })
      .allowed === true;
  const canAdd =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  // Same key and fetch as the Connectors page, so the two share one cache entry.
  const connectors = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract('inventory'),
  });
  const [connecting, setConnecting] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const keys = [
      ...connectorConnectionQueryKeys(projectId),
      projectTriggerEventAppsKey(projectId),
      qk.project.triggers(projectId),
    ];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  }, [projectId, queryClient]);

  const takenSlugs = () => (connectors.data?.connectors ?? []).map((c) => c.slug);

  /** Adds the connector for an app the project does not have yet; resolves to its slug. */
  const add = useCallback(
    async (target: EventAppTarget): Promise<string> => {
      if (target.connector) return target.connector;
      const slug = newConnectorSlug(target.app, takenSlugs());
      const draft = buildEasyConnectConnectorDraft(
        { slug: target.app, name: target.name, provider: 'composio' },
        { name: target.name, slug },
      );
      const result = await createConnector(projectId, draft);
      const syncError = connectorSyncErrorForSlug(result, slug);
      if (syncError) throw new Error(syncError);
      refresh();
      return slug;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, connectors.data, refresh],
  );

  /** Popup sign-in as the project's shared account. Stays on the page; `onConnected` gets the connector slug. */
  const connect = useCallback(
    (target: EventAppTarget, onConnected?: (connector: string) => void) => {
      if (connecting) return;
      const slug = target.connector ?? newConnectorSlug(target.app, takenSlugs());
      setConnecting(target.app);
      connectApp(
        {
          projectId,
          app: { slug: target.app, name: target.name, provider: 'composio' },
          connectorSlug: slug,
          created: Boolean(target.connector),
        },
        undefined,
        refresh,
      )
        .then(() => {
          successToast(`${target.name} connected`, {
            description: 'Triggers on this app go live now.',
          });
          onConnected?.(slug);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          // Closing the popup is the person changing their mind, not a failure.
          if (!/popup closed/i.test(message)) errorToast(message);
        })
        .finally(() => {
          setConnecting(null);
          refresh();
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, connecting, connectors.data, refresh],
  );

  return { connect, add, connecting, canConnect, canAdd };
}

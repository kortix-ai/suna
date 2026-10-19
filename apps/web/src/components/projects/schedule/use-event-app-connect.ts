'use client';

/**
 * Add an app to the project and connect its shared account without leaving the
 * trigger form. One hook for the create modal, the detail sheet and the list.
 *
 * An event trigger runs on the project's shared account, so this always
 * connects as the project. The popup opens synchronously inside the click,
 * before any request. A Composio app connects through `connectApp`
 * (`owner: 'project'`). An app Kortix checks itself (source `mcp`) installs its
 * catalogue MCP server and signs in with that server's own OAuth.
 */

import { errorToast, successToast } from '@/components/ui/toast';
import { connectApp } from '@/components/projects/onboarding/connect-app';
import {
  type AddMcpServerDeps,
  addMcpServer,
} from '@/features/workspace/capabilities/connectors/add-mcp/add-mcp-server';
import { sdkAddMcpServerDeps } from '@/features/workspace/capabilities/connectors/add-mcp/add-mcp-server-deps';
import { connectorHref } from '@/features/workspace/capabilities/connectors/connector-routes';
import {
  buildEasyConnectConnectorDraft,
  connectorConnectionQueryKeys,
  connectorSyncErrorForSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { createConnector, getConnectionOAuth2Status, listConnections, listConnectors } from '@kortix/sdk';
import {
  contract,
  projectTriggerEventAppsKey,
  qk,
  useProjectAccountId,
} from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

import { type EventAppTarget, newConnectorSlug } from './event-trigger-copy';

/**
 * Signs in the project's shared account of a `mcp` app in the popup
 * `runConnectLinkFlow` opens inside the click. With no connector yet it first
 * installs the app's catalogue MCP server, named after the app, and calls
 * `onCreated`. The provider returns the popup to the connector's page.
 * Resolves to the connector slug.
 */
async function connectMcpApp(
  projectId: string,
  target: EventAppTarget,
  options: {
    deps: AddMcpServerDeps;
    takenSlugs: readonly string[];
    onCreated: () => void;
    /** The error for a server without one-click OAuth. */
    noSignIn: string;
  },
): Promise<string> {
  let slug = target.connector ?? '';
  let connectionId: string | null = null;
  // The token the account held before this sign-in: done means a new one, not the old one
  // (a parked trigger's account still holds the token the app refused).
  let tokenBefore: string | null = null;
  const returnUrl = (connector: string) =>
    `${window.location.origin}${connectorHref(projectId, connector)}`;
  await runConnectLinkFlow(
    async () => {
      let signInUrl: string | null;
      if (slug) {
        connectionId = await sharedAccountOf(projectId, slug, target, options.deps);
        const before = await getConnectionOAuth2Status(projectId, connectionId).catch(() => null);
        tokenBefore = before?.status === 'active' ? (before.expires_at ?? 'active') : null;
        signInUrl = await options.deps.startSignIn(projectId, connectionId, returnUrl(slug));
      } else {
        if (!target.mcpUrl) throw new Error(`${target.name} has no MCP server to install.`);
        const added = await addMcpServer(
          projectId,
          {
            url: target.mcpUrl,
            appName: target.name,
            ...(target.newConnectorSlug ? { slug: target.newConnectorSlug } : {}),
            signIn: true,
            audience: 'project',
            takenSlugs: options.takenSlugs,
            returnUrl,
          },
          options.deps,
        );
        slug = added.slug;
        connectionId = added.connectionId;
        options.onCreated();
        if (added.signInError) throw new Error(added.signInError);
        signInUrl = added.signInUrl;
      }
      // A credential the server asks for instead is entered on the connector's page.
      if (!signInUrl) throw new Error(options.noSignIn);
      return { connectUrl: signInUrl };
    },
    async () => {
      if (!connectionId) return { connected: false };
      const [status, { connectors }] = await Promise.all([
        getConnectionOAuth2Status(projectId, connectionId),
        listConnectors(projectId, { includeSchemas: false }),
      ]);
      // This sign-in stored a new token, then the server's tools were read again:
      // the app's events exist only after both.
      const signedIn = status.status === 'active' && (status.expires_at ?? 'active') !== tokenBefore;
      return { connected: signedIn && connectors.find((c) => c.slug === slug)?.status !== 'error' };
    },
  );
  return slug;
}

/**
 * The project-owned account a trigger runs on: the one it names, else the
 * connector's default, else the first. None yet: the connector's own.
 */
async function sharedAccountOf(
  projectId: string,
  slug: string,
  target: EventAppTarget,
  deps: AddMcpServerDeps,
): Promise<string> {
  const { connections } = await listConnections(projectId);
  const shared = connections.filter((c) => c.connector_alias === slug && c.owner_type === 'project');
  const picked = target.account
    ? shared.find((c) => c.label === target.account)
    : (shared.find((c) => c.is_default) ?? shared[0]);
  if (picked) return picked.connection_id;
  if (target.account) throw new Error(`${target.name} has no shared account labelled "${target.account}".`);
  return (await deps.projectAccount(projectId, slug, target.name)).connection_id;
}

export function useEventAppConnect(projectId: string) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tComposer = useTranslations('triggerComposer');
  const queryClient = useQueryClient();
  const accountId = useProjectAccountId(projectId);
  const canConnect =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId })
      .allowed === true;
  const canAdd =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  // Same key and fetch as the Connectors page, so the two share one cache entry. Only `add`
  // reads it (to pick a free slug), and the route asserts connector read: a person who cannot
  // add a connector never sends it.
  const connectors = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    enabled: canAdd,
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

  /**
   * Adds the connector for an app the project does not have yet, without signing in;
   * resolves to its slug. The trigger composer calls it from Create, never while browsing.
   */
  const add = useCallback(
    async (target: EventAppTarget): Promise<string> => {
      if (target.connector) return target.connector;
      if (target.source === 'mcp') {
        if (!target.mcpUrl) throw new Error(`${target.name} has no MCP server to install.`);
        // No sign-in here (`startSignIn` is a no-op): the trigger's "Connect" does it. A first
        // tools read that fails, such as the 401 before sign-in, still leaves the connector.
        const added = await addMcpServer(
          projectId,
          {
            url: target.mcpUrl,
            appName: target.name,
            ...(target.newConnectorSlug ? { slug: target.newConnectorSlug } : {}),
            audience: 'project',
            takenSlugs: takenSlugs(),
            returnUrl: () => window.location.href,
          },
          { ...sdkAddMcpServerDeps(accountId), startSignIn: async () => null },
        );
        refresh();
        return added.slug;
      }
      const slug = (target.newConnectorSlug ?? newConnectorSlug(target.app, takenSlugs()));
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
    [projectId, accountId, connectors.data, refresh],
  );

  /** Popup sign-in as the project's shared account. Stays on the page; `onConnected` gets the connector slug. */
  const connect = useCallback(
    (target: EventAppTarget, onConnected?: (connector: string) => void) => {
      if (connecting) return;
      const slug = target.connector ?? (target.newConnectorSlug ?? newConnectorSlug(target.app, takenSlugs()));
      setConnecting(target.app);
      const flow =
        target.source === 'mcp'
          ? connectMcpApp(projectId, target, {
              deps: sdkAddMcpServerDeps(accountId),
              takenSlugs: takenSlugs(),
              onCreated: refresh,
              noSignIn: tComposer('mcpSignInUnavailable', { name: target.name }),
            })
          : connectApp(
              {
                projectId,
                app: { slug: target.app, name: target.name, provider: 'composio' },
                connectorSlug: slug,
                created: Boolean(target.connector),
              },
              undefined,
              refresh,
            ).then(() => slug);
      flow
        .then((connector) => {
          successToast(tI18nComplete('text2dca9f542da4', { name: target.name }), {
            description: tI18nComplete.raw('text54e2237efa16'),
          });
          onConnected?.(connector);
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
    [projectId, accountId, connecting, connectors.data, refresh],
  );

  return { connect, add, connecting, canConnect, canAdd };
}

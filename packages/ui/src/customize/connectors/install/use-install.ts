'use client';
import { invalidateConnections } from '../invalidate-connections';

import {
  checkMcpServerSignIn,
  createConnector,
  getDiscoverConnector,
  type AdminConnector,
} from '@kortix/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useUiRouter } from '../../../providers/ui-provider';
import { useCallback, useState } from 'react';

import { errorToast, successToast, warningToast } from '../../../primitives/toast';
import type { CatalogEntry } from '../catalog/catalog-entry';
import {
  appHref,
  appRefFromEntry,
  connectorHref,
  type AppRef,
} from '../connector-routes';
import { useTranslations } from '../../../i18n';

import {
  discoverInstallTarget,
  easyConnectInstallTarget,
  runInstall,
  type InstallDeps,
  type InstallTarget,
} from './install';
import { mcpServerFor, type McpServerApp } from './mcp-first';
import { pickSurface } from './pick-surface';

const sdkInstallDeps: InstallDeps = { createConnector };

/**
 * Install one app: add its connector profile to the project, then open the
 * connector page with "Add account" showing. Who may use an account is chosen
 * there, per account; the profile itself is always the project's. When the
 * first sync fails, the page opens on its error and Retry instead.
 *
 * A managed app whose own MCP server signs in with one click goes to
 * `onMcpServer` instead: the MCP dialog connects it in one step.
 */
export function useInstall(
  projectId: string,
  options: { onMcpServer?: (server: McpServerApp) => void } = {},
) {
  const { onMcpServer } = options;
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useUiRouter();
  const queryClient = useQueryClient();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const install = useCallback(
    (
      target: InstallTarget,
      options: {
        connectors: readonly AdminConnector[];
        app: AppRef | null;
        /** Open "Add account" on the connector page. False for a server with
         *  nothing to sign in to: its project account is the connection. */
        addAccount?: boolean;
      },
    ) => {
      /** Settles when every invalidated query has refetched. Never rejects. */
      const refresh = () => invalidateConnections(queryClient, projectId);
      setPendingKey(options.app?.slug ?? target.appName);
      void runInstall(sdkInstallDeps, { projectId, target, connectors: options.connectors })
        .then(async (result) => {
          // Before the navigation: the connector page reads the fresh list.
          await refresh();
          // The profile exists either way, so land on its page. A failed sync
          // shows its reason and Retry there instead of opening Add account.
          const failed = result.status === 'sync_failed';
          if (failed) {
            warningToast(t('installedSyncFailed', { name: result.name, error: result.error }));
          } else {
            successToast(t('installed', { name: target.appName }));
          }
          router.push(
            connectorHref(projectId, result.slug, {
              app: options.app,
              addAccount: !failed && options.addAccount !== false,
            }),
          );
        })
        .catch(async (error: Error) => {
          // A failure can land after the connector was created. A retry must
          // see it, or it creates a second one: Install stays pending until
          // the refreshed list has arrived.
          errorToast(error.message || tI18nComplete.raw('texta34a2714da91'));
          await refresh();
        })
        .finally(() => setPendingKey(null));
    },
    [projectId, queryClient, router, t, tI18nComplete],
  );

  /** Install straight from a catalogue card. */
  const installEntry = useCallback(
    (entry: CatalogEntry, connectors: readonly AdminConnector[]) => {
      const app = appRefFromEntry(entry);
      if (entry.source === 'easy-connect') {
        const target = easyConnectInstallTarget(entry.app);
        if (!target.managed || !onMcpServer || !entry.app.directMcpUrl) {
          install(target, { connectors, app });
          return;
        }
        setPendingKey(app?.slug ?? entry.app.name);
        void mcpServerFor(projectId, entry.app).then((server) => {
          if (server) {
            setPendingKey(null);
            onMcpServer(server);
          } else {
            install(target, { connectors, app });
          }
        });
        return;
      }
      if (entry.source !== 'discover' || !app) return;
      // A Discover card does not carry its surfaces; the detail does. Direct
      // providers open no provider window, so this fetch costs no click.
      setPendingKey(app.slug);
      void queryClient
        .fetchQuery({
          queryKey: ['discover-connector-detail', projectId, entry.connector.id],
          queryFn: () => getDiscoverConnector(projectId, entry.connector.id),
          staleTime: 15 * 60_000,
        })
        .then(async (detail) => {
          const variant = pickSurface(detail.variants);
          if (!variant) {
            // Nothing installable from here: the app page shows its surfaces.
            setPendingKey(null);
            router.push(appHref(projectId, app));
            return;
          }
          const mcpUrl = variant.kind === 'mcp' ? variant.template.url : undefined;
          // A Kortix catalogue app (connectors_v2) is its vendor's MCP server:
          // a one-click sign-in opens the one-step MCP dialog, a public server
          // installs with no account to add, anything else installs as before.
          if (entry.connector.feeds.includes('kortix') && mcpUrl && onMcpServer) {
            const check = await checkMcpServerSignIn(projectId, mcpUrl).catch(() => null);
            if (check?.one_click) {
              setPendingKey(null);
              onMcpServer({ name: entry.name, url: mcpUrl });
              return;
            }
            install(discoverInstallTarget(entry.name, variant), {
              connectors,
              app,
              addAccount: check?.requires_sign_in !== false,
            });
            return;
          }
          install(discoverInstallTarget(entry.name, variant), { connectors, app });
        })
        .catch((error: Error) => {
          setPendingKey(null);
          errorToast(error.message || tI18nComplete.raw('texta34a2714da91'));
        });
    },
    [install, onMcpServer, projectId, queryClient, router, tI18nComplete],
  );

  return { install, installEntry, pendingKey, setPendingKey };
}

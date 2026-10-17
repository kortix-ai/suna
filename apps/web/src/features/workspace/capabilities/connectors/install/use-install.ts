'use client';

import { createConnector, getDiscoverConnector, type AdminConnector } from '@kortix/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import type { CatalogEntry } from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import {
  appHref,
  appRefFromEntry,
  connectorHref,
  type AppRef,
} from '@/features/workspace/capabilities/connectors/connector-routes';
import { connectorConnectionQueryKeys } from '@/features/workspace/customize/sections/connector-connection-form';
import { useTranslations } from '@/i18n/use-translations';

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
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const install = useCallback(
    (
      target: InstallTarget,
      options: { connectors: readonly AdminConnector[]; app: AppRef | null },
    ) => {
      /** Settles when every invalidated query has refetched. Never rejects. */
      const refresh = () =>
        Promise.all(
          connectorConnectionQueryKeys(projectId).map((key) =>
            queryClient.invalidateQueries({ queryKey: key }).catch(() => undefined),
          ),
        );
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
            connectorHref(projectId, result.slug, { app: options.app, addAccount: !failed }),
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
        if (!onMcpServer || !entry.app.directMcpUrl) {
          install(easyConnectInstallTarget(entry.app), { connectors, app });
          return;
        }
        setPendingKey(app?.slug ?? entry.app.name);
        void mcpServerFor(projectId, entry.app).then((server) => {
          if (server) {
            setPendingKey(null);
            onMcpServer(server);
          } else {
            install(easyConnectInstallTarget(entry.app), { connectors, app });
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
        .then((detail) => {
          const variant = pickSurface(detail.variants);
          if (!variant) {
            // Nothing installable from here: the app page shows its surfaces.
            setPendingKey(null);
            router.push(appHref(projectId, app));
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

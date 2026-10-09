'use client';

import {
  createConnector,
  getDiscoverConnector,
  listConnections,
  pipedreamConnectConnection,
  pipedreamFinalizeConnection,
  reconcileConnection,
  reconcileMemberConnection,
  type AdminConnector,
} from '@kortix/sdk';
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
import { connectorConnectionRows } from '@/features/workspace/customize/sections/view/connector-connections';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import {
  projectConnectSteps,
  sdkProjectConnectDeps,
} from '@/hooks/connectors/use-pipedream-connect-project';
import { useTranslations } from '@/i18n/use-translations';

import {
  discoverInstallTarget,
  easyConnectInstallTarget,
  runInstall,
  type InstallAudience,
  type InstallDeps,
  type InstallTarget,
} from './install';
import { startDiscoveredSignIn } from '@/features/workspace/customize/sections/connector-oauth2-start';

import { pickSurface } from './pick-surface';

const sdkInstallDeps: InstallDeps = {
  createConnector,
  listAccountLabels: async (projectId, connectorSlug) =>
    connectorConnectionRows((await listConnections(projectId)).connections, connectorSlug).map(
      (connection) => connection.label,
    ),
  reconcileMine: reconcileMemberConnection,
  reconcileProject: reconcileConnection,
  connectConnection: pipedreamConnectConnection,
  finalizeConnection: pipedreamFinalizeConnection,
  projectSteps: (projectId, slug, label) =>
    projectConnectSteps(projectId, slug, label, sdkProjectConnectDeps),
  runLinkFlow: (start, finalize) => runConnectLinkFlow(start, finalize),
};

/**
 * Install one app for one audience, then open its connector page.
 *
 * `install` must be called straight from the click handler. A managed install
 * opens the provider window inside `runInstall`, before any `await`; an
 * `await` in front of it would get the window blocked.
 */
export function useInstall(projectId: string) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const install = useCallback(
    (
      target: InstallTarget,
      audience: InstallAudience,
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
      void runInstall(sdkInstallDeps, {
        projectId,
        target,
        audience,
        connectors: options.connectors,
      })
        .then((result): Promise<unknown> | undefined => {
          // Before the navigation: the connector page opens credential entry
          // only once `['connections', projectId]` has refetched with the new
          // account in it.
          const refreshed = refresh();
          if (result.status === 'sync_failed') {
            warningToast(
              tI18nComplete('textd6a135de3872', { value0: result.name, value1: result.error }),
            );
            // Install stays pending until the list is fresh, as in `catch`.
            return refreshed;
          }
          if (result.status === 'connected') successToast(t('installed', { name: target.appName }));
          if (result.status === 'sign_in') {
            // Straight to the server's sign-in, as "Connect <host>" does. The
            // provider returns to the connector page. A server without
            // one-click OAuth falls back to credential entry there.
            const page = connectorHref(projectId, result.slug, { app: options.app });
            return startDiscoveredSignIn(
              projectId,
              result.connectionId,
              new URL(page, window.location.origin).toString(),
            ).then((authorizationUrl) => {
              if (authorizationUrl) window.location.assign(authorizationUrl);
              else
                router.push(
                  connectorHref(projectId, result.slug, {
                    app: options.app,
                    connect: { connectionId: result.connectionId },
                  }),
                );
            });
          }
          router.push(
            connectorHref(projectId, result.slug, {
              app: options.app,
              ...(result.status === 'needs_credential'
                ? { connect: { connectionId: result.connectionId } }
                : {}),
            }),
          );
        })
        .catch((error: Error) => {
          // A failure can land after the connector was created. A retry must
          // see it, or it creates a second one: Install stays pending until
          // the refreshed list has arrived.
          const refreshed = refresh();
          errorToast(error.message || tI18nComplete.raw('texta34a2714da91'));
          return refreshed;
        })
        .finally(() => setPendingKey(null));
    },
    [projectId, queryClient, router, t, tI18nComplete],
  );

  /** Install straight from a catalogue card. */
  const installEntry = useCallback(
    (entry: CatalogEntry, audience: InstallAudience, connectors: readonly AdminConnector[]) => {
      const app = appRefFromEntry(entry);
      if (entry.source === 'easy-connect') {
        install(easyConnectInstallTarget(entry.app), audience, { connectors, app });
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
          install(discoverInstallTarget(entry.name, variant), audience, { connectors, app });
        })
        .catch((error: Error) => {
          setPendingKey(null);
          errorToast(error.message || tI18nComplete.raw('texta34a2714da91'));
        });
    },
    [install, projectId, queryClient, router, tI18nComplete],
  );

  return { install, installEntry, pendingKey };
}

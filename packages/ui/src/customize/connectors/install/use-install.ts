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
import { connectToolkitApp, type CatalogEntry } from '../catalog/catalog-entry';
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
import type { InstallWay } from './install-dialog';
import type { McpServerApp } from './mcp-first';
import { pickSurface } from './pick-surface';

/** An Install waiting for the user to name the profile (`InstallDialog`). */
export interface InstallRequest {
  target: InstallTarget;
  way: InstallWay;
  connectors: readonly AdminConnector[];
  app: AppRef | null;
  addAccount?: boolean;
  asNewProfile?: boolean;
}

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
  const [request, setRequest] = useState<InstallRequest | null>(null);

  const install = useCallback(
    (
      target: InstallTarget,
      options: {
        connectors: readonly AdminConnector[];
        app: AppRef | null;
        /** Open "Add account" on the connector page. False for a server with
         *  nothing to sign in to: its project account is the connection. */
        addAccount?: boolean;
        /** The profile's name, as the user chose it. */
        name?: string;
        asNewProfile?: boolean;
      },
    ) => {
      /** Settles when every invalidated query has refetched. Never rejects. */
      const refresh = () => invalidateConnections(queryClient, projectId);
      setPendingKey(options.app?.slug ?? target.appName);
      void runInstall(sdkInstallDeps, {
        projectId,
        target,
        connectors: options.connectors,
        name: options.name,
        asNewProfile: options.asNewProfile,
      })
        .then(async (result) => {
          // Before the navigation: the connector page reads the fresh list.
          await refresh();
          // The profile exists either way, so land on its page. A failed sync
          // shows its reason and Retry there instead of opening Add account.
          const failed = result.status === 'sync_failed';
          if (failed) {
            warningToast(t('installedSyncFailed', { name: result.name, error: result.error }));
          } else if (result.existing) {
            successToast(t('installedAlready', { name: options.name?.trim() || target.appName }));
          } else {
            successToast(t('installed', { name: options.name?.trim() || target.appName }));
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

  /** Ask for the profile's name, then install (`confirm`). */
  const ask = useCallback((next: InstallRequest) => {
    setPendingKey(null);
    setRequest(next);
  }, []);

  /** The user named the profile in `InstallDialog`: install it. */
  const confirm = useCallback(
    (name: string) => {
      if (!request) return;
      setRequest(null);
      install(request.target, {
        connectors: request.connectors,
        app: request.app,
        addAccount: request.addAccount,
        asNewProfile: request.asNewProfile,
        name,
      });
    },
    [install, request],
  );

  /** Install straight from a catalogue card: its recommended way, after the
   *  user names the profile. A one-click MCP server opens the MCP dialog. */
  const installEntry = useCallback(
    (entry: CatalogEntry, connectors: readonly AdminConnector[]) => {
      const app = appRefFromEntry(entry);
      // What Kortix built is set up on its own page, not installed.
      if (entry.connector.kind === 'kortix') {
        router.push(appHref(projectId, app));
        return;
      }
      // A Discover card does not carry its ways to connect; the detail does,
      // best first, with the recommended one marked.
      setPendingKey(app.slug);
      void queryClient
        .fetchQuery({
          queryKey: ['discover-connector-detail', projectId, entry.connector.id],
          queryFn: () => getDiscoverConnector(projectId, entry.connector.id),
          staleTime: 15 * 60_000,
        })
        .then(async (detail) => {
          const recommended = detail.variants.find((variant) => variant.recommended);
          if (recommended?.kind === 'composio' && recommended.composio) {
            ask({
              target: easyConnectInstallTarget(connectToolkitApp(recommended.composio)),
              way: { kind: 'composio', oneClick: true },
              connectors,
              app,
            });
            return;
          }
          const variant = pickSurface(recommended ? [recommended] : detail.variants);
          if (!variant) {
            // Nothing installable from here: the app page shows its surfaces.
            setPendingKey(null);
            router.push(appHref(projectId, app));
            return;
          }
          const mcpUrl = variant.kind === 'mcp' ? variant.template.url : undefined;
          // A Kortix catalogue app or a one-click server is the vendor's MCP
          // server: a one-click sign-in opens the one-step MCP dialog (which
          // names the profile too); anything else asks for the name first.
          const oneClickServer = entry.connector.feeds.includes('kortix') || recommended?.oneClick === true || entry.connector.oneClick === true;
          let addAccount: boolean | undefined;
          if (oneClickServer && mcpUrl && onMcpServer) {
            const check = await checkMcpServerSignIn(projectId, mcpUrl).catch(() => null);
            if (check?.one_click) {
              setPendingKey(null);
              onMcpServer({ name: entry.name, url: mcpUrl });
              return;
            }
            addAccount = check?.requires_sign_in !== false;
          }
          ask({
            target: discoverInstallTarget(entry.name, variant),
            way: { kind: variant.kind, oneClick: recommended?.oneClick === true, provider: variant.template.provider },
            connectors,
            app,
            ...(addAccount !== undefined ? { addAccount } : {}),
          });
        })
        .catch((error: Error) => {
          setPendingKey(null);
          errorToast(error.message || tI18nComplete.raw('texta34a2714da91'));
        });
    },
    [ask, onMcpServer, projectId, queryClient, router, tI18nComplete],
  );

  return { install, installEntry, ask, confirm, request, setRequest, pendingKey, setPendingKey };
}

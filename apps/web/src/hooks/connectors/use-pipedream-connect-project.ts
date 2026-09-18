'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';

import { errorToast, successToast } from '@/components/ui/toast';
import { runConnectLinkFlow } from '@/hooks/connectors/use-connect-link';
import {
  type ConnectorConnectResult,
  type ConnectorFinalizeResult,
  connectorConnect,
  connectorFinalize,
  pipedreamConnectConnection,
  pipedreamFinalizeConnection,
  reconcileConnection,
} from '@kortix/sdk';

/** Which connect route authorized the account, so finalize polls the same one. */
export type ProjectConnectRoute = 'connection' | 'connector';

export interface ProjectConnectDeps {
  reconcile: (
    projectId: string,
    input: { connector_alias: string; owner_type: 'project'; label: string },
  ) => Promise<{ connection_id: string }>;
  connectConnection: (projectId: string, connectionId: string) => Promise<ConnectorConnectResult>;
  finalizeConnection: (
    projectId: string,
    connectionId: string,
  ) => Promise<ConnectorFinalizeResult>;
  connectConnector: (
    projectId: string,
    slug: string,
    options: { owner: 'project' },
  ) => Promise<ConnectorConnectResult>;
  finalizeConnector: (
    projectId: string,
    slug: string,
    options: { owner: 'project'; connectionId: string },
  ) => Promise<ConnectorFinalizeResult>;
}

export const DEFAULT_PROJECT_CONNECTION_LABEL = 'Project connection';

/**
 * Did the connection-scoped connect route refuse because this account is the
 * connector's EFFECTIVE project default?
 *
 * `apps/api/src/projects/routes/r4.ts` (INVARIANT, 2026-09-16 `account_required`
 * rule) blocks that route for the connector's sole active project-owned row
 * even when nothing is pinned, and names the route to use instead. That guard
 * is the ONLY 409 the handler returns, so the status alone identifies it — and
 * matching on status rather than the sentence keeps this from breaking again
 * the next time the copy is reworded.
 *
 * The status is read structurally, never with `instanceof ApiError`: the SDK
 * ships an ESM build and an IIFE global, and a consumer that loads both gets
 * two distinct classes, so `instanceof` can be false for a genuine error (see
 * `catalog-error.ts`).
 */
export function isSharedDefaultConnectConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { status?: unknown }).status === 409;
}

/**
 * The `start`/`finalize` pair `runConnectLinkFlow` drives for a project-owned
 * (team-shared) account.
 *
 * Split out of the hook so the route choice is testable without a renderer —
 * the same shape `toolConnectSteps` uses in `use-tool-connect.ts`.
 */
export function projectConnectSteps(
  projectId: string,
  slug: string,
  label: string | undefined,
  deps: ProjectConnectDeps,
): {
  start: () => Promise<ConnectorConnectResult>;
  finalize: () => Promise<ConnectorFinalizeResult>;
} {
  let connectionId: string | null = null;
  let route: ProjectConnectRoute = 'connection';

  return {
    start: async () => {
      // Reconcile first either way: it creates (or updates) the row carrying the
      // label the user typed. When this turns out to be the connector's
      // effective default, `owner: 'project'` below resolves that SAME row
      // through `ensureDefaultConnection`, so the label survives the fallback.
      const connection = await deps.reconcile(projectId, {
        connector_alias: slug,
        owner_type: 'project',
        label: label?.trim() || DEFAULT_PROJECT_CONNECTION_LABEL,
      });
      connectionId = connection.connection_id;
      try {
        return await deps.connectConnection(projectId, connection.connection_id);
      } catch (error) {
        if (!isSharedDefaultConnectConflict(error)) throw error;
        // Do exactly what the 409 asks. Only the default account is redirected:
        // several project-owned connections per connector are supported and are
        // distinguished by label, and `owner: 'project'` reuses
        // `ensureDefaultConnection` — so sending a labelled NON-default account
        // here would re-authorize the default and leave the new row
        // unauthorized.
        route = 'connector';
        return await deps.connectConnector(projectId, slug, { owner: 'project' });
      }
    },
    finalize: () => {
      if (!connectionId) throw new Error('The project connection was not created.');
      // The owner MUST match the connect: the connector-scoped finalize route
      // defaults an absent owner to `me`, which would poll the caller's own
      // member account and never report the shared one active. `connectionId`
      // pins the poll to the reconciled row instead of the most recent one.
      if (route === 'connector') {
        return deps.finalizeConnector(projectId, slug, { owner: 'project', connectionId });
      }
      return deps.finalizeConnection(projectId, connectionId);
    },
  };
}

const sdkProjectConnectDeps: ProjectConnectDeps = {
  reconcile: reconcileConnection,
  connectConnection: pipedreamConnectConnection,
  finalizeConnection: pipedreamFinalizeConnection,
  connectConnector: connectorConnect,
  finalizeConnector: connectorFinalize,
};

/**
 * Connect a labelled project-owned account under one connector.
 */
export function usePipedreamConnectProject(
  projectId: string,
  slug: string,
  onConnected: () => void,
) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return useMutation({
    mutationFn: async (input?: { label?: string }) => {
      const steps = projectConnectSteps(projectId, slug, input?.label, sdkProjectConnectDeps);
      return runConnectLinkFlow(steps.start, steps.finalize);
    },
    onSuccess: (result) => {
      if (!result.connected) return;
      successToast(tI18nComplete.raw('textf04f9fcae903'));
      onConnected();
    },
    onError: (error: Error) => errorToast(error.message),
  });
}

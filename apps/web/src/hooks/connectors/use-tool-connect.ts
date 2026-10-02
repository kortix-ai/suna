'use client';

import {
  type ConnectorConnectResult,
  type ConnectorFinalizeResult,
  type connectorConnect,
  type connectorFinalize,
} from '@kortix/sdk';

import {
  buildEasyConnectConnectorDraft,
} from '@/features/workspace/customize/sections/connector-connection-form';

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

export interface ToolConnectDeps {
  connectProject: typeof connectorConnect;
  finalizeProject: typeof connectorFinalize;
}

/**
 * Authorize the connector the catalogue just added, as the PROJECT's shared
 * account.
 *
 * Adding a tool here is a project act — everyone who may use the connector gets
 * the account. Personal accounts are added afterwards, per person, from the
 * connector's Accounts tab ("Add my own", `usePipedreamConnectMember`); they are
 * no longer an exclusive alternative that has to be chosen up front.
 *
 * `owner: 'project'` is NOT optional decoration. Both connector-scoped routes
 * default an ABSENT owner to `me`
 * (`apps/api/src/projects/lib/connection-access.ts:94`, applied at
 * `apps/api/src/connectors/db-deps.ts:2325` and `:2439`), which routes to
 * `ensureMemberConnection` and lands `owner_type = 'member'`, `owner_id =`
 * whoever clicked. That account is reachable by that one user and NEVER by a
 * service account (`connectionIsReachable`, `connection-access.ts:42`), so the
 * project-owned row this connector was created with stayed unauthorized and
 * every other member — and every trigger — got nothing, while the UI reported
 * the tool connected.
 *
 * The two verbs are split into one `start`/`finalize` pair, holding the
 * connection id the start returned, because the owner has to MATCH across them:
 * finalize selects the row by owner scope, so finalizing a `project`
 * authorization without the owner polls the caller's own member connection and
 * never reports the shared account active. Same shape and same reasoning as
 * `projectConnectSteps` in `use-pipedream-connect-project.ts`.
 */
export function toolConnectSteps(
  projectId: string,
  slug: string,
  deps: ToolConnectDeps,
): {
  start: () => Promise<ConnectorConnectResult>;
  finalize: () => Promise<ConnectorFinalizeResult>;
} {
  let connectionId: string | null = null;

  return {
    start: async () => {
      const result = await deps.connectProject(projectId, slug, { owner: 'project' });
      connectionId = result.connectionId ?? null;
      return result;
    },
    // `connectionId` is optional on `ConnectorConnectResult`, so it is omitted
    // rather than sent empty when the provider named none — the route then
    // resolves the most recently updated row in the `project` owner scope,
    // which is the one the start above just touched.
    finalize: () =>
      deps.finalizeProject(projectId, slug, {
        owner: 'project',
        ...(connectionId ? { connectionId } : {}),
      }),
  };
}

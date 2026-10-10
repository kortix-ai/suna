'use client';

import {
  listConnections,
  reconcileConnection,
  reconcileMemberConnection,
  type AdminConnector,
} from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { errorToast } from '@/components/ui/toast';
import { proposeAccountLabel } from '@/features/workspace/capabilities/connectors/install/install';
import { isManagedConnectorProvider } from '@/features/workspace/capabilities/connectors/provider-label';
import { startDiscoveredSignIn } from '@/features/workspace/customize/sections/connector-oauth2-start';
import {
  connectorConnectionRows,
  newAccountGrantees,
  type NewAccountDraft,
} from '@/features/workspace/customize/sections/view/connector-connections';
import { grantConnectionAccess } from '@/features/workspace/shared/access/access-dialog-share';
import { useAddManagedAccount } from '@/hooks/connectors/use-add-managed-account';
import { useTranslations } from '@/i18n/use-translations';

/**
 * Add one account to a connector. The connector profile is the project's; the
 * ACCOUNT carries who may use it: only the caller, everyone in the project, or
 * picked people and groups (`NewAccountDraft`).
 *
 * Then sign it in at once:
 * - a managed provider (Composio, Pipedream) runs its hosted Connect Link;
 * - a direct provider starts the server's one-click OAuth when it has one,
 *   else hands the account to `onCredential` for credential entry;
 * - a connector with no auth is ready as soon as the account exists.
 */
export function useAddAccount({
  projectId,
  connector,
  displayName,
  onAdded,
  onCredential,
}: {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  onAdded: () => void;
  onCredential: (target: { connectionId: string; owner: 'project' | 'me' }) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const accountId = useProjectAccountId(projectId);
  // Same key and fetcher as `ConnectionsList`, so both share one cache entry.
  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
    // A channel connector has no accounts: same guard as `useConnectorDetail`.
    enabled: connector.provider !== 'channel',
  });
  const addManaged = useAddManagedAccount(projectId, connector.slug, accountId, onAdded);
  // Direct providers: create the account, narrow it before it holds a
  // credential (so it is never open to everyone), then sign it in.
  const createAccount = useMutation({
    mutationFn: async (draft: NewAccountDraft) => {
      const label = draft.label.trim();
      if (draft.audience === 'private') {
        return reconcileMemberConnection(projectId, { connector_alias: connector.slug, label });
      }
      const connection = await reconcileConnection(projectId, {
        connector_alias: connector.slug,
        owner_type: 'project',
        label,
      });
      if (draft.audience === 'members') {
        await grantConnectionAccess(
          accountId ?? '',
          projectId,
          connection.connection_id,
          newAccountGrantees(draft.picked),
        );
      }
      return connection;
    },
    onSuccess: async (connection, draft) => {
      // A connector with no auth has no credential to enter: the account is ready.
      if (!connector.authSecret) {
        onAdded();
        return;
      }
      const target = {
        connectionId: connection.connection_id,
        owner: draft.audience === 'private' ? ('me' as const) : ('project' as const),
      };
      // An MCP server that signs in with OAuth: straight to its consent page.
      if (connector.provider === 'mcp') {
        try {
          const url = await startDiscoveredSignIn(
            projectId,
            connection.connection_id,
            window.location.href,
          );
          if (url) {
            window.location.assign(url);
            return;
          }
        } catch {
          // No one-click OAuth here: fall through to credential entry.
        }
      }
      onAdded();
      onCredential(target);
    },
    onError: (e: Error) => {
      // A partly written account (created, then a grant refused) is listed now.
      onAdded();
      errorToast(e.message || tI18nComplete.raw('texta2cf78785484'));
    },
  });

  const pending = createAccount.isPending || addManaged.isPending;
  /** The next free name for a new account: `<name>`, `<name> 2`, … */
  const proposedLabel = () =>
    proposeAccountLabel(
      displayName,
      connectorConnectionRows(connectionsQuery.data?.connections, connector.slug).map(
        (row) => row.label,
      ),
    );
  const submit = (draft: NewAccountDraft) => {
    if (pending) return;
    if (isManagedConnectorProvider(connector.provider)) {
      // The hooks toast their own errors.
      void addManaged.add(draft).catch(() => undefined);
    } else {
      createAccount.mutate(draft);
    }
  };

  return { submit, pending, proposedLabel };
}

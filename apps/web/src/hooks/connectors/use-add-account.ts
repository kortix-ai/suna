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
import {
  proposeAccountLabel,
  type InstallAudience,
} from '@/features/workspace/capabilities/connectors/install/install';
import { isManagedConnectorProvider } from '@/features/workspace/capabilities/connectors/provider-label';
import {
  connectorConnectionRows,
  type NewAccountDraft,
} from '@/features/workspace/customize/sections/view/connector-connections';
import { useAddManagedAccount } from '@/hooks/connectors/use-add-managed-account';
import { useTranslations } from '@/i18n/use-translations';

/**
 * Add one account to an existing connector, for one audience. The account is
 * named from the connector (`<name>`, `<name> 2`, …), so nothing is asked but
 * who it is for.
 *
 * Managed providers run the hosted Connect Link. Direct providers create the
 * account, then hand it to `onCredential` when the connector needs a
 * credential.
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
  const createAccount = useMutation({
    mutationFn: (draft: NewAccountDraft) =>
      draft.audience === 'private'
        ? reconcileMemberConnection(projectId, {
            connector_alias: connector.slug,
            label: draft.label,
          })
        : reconcileConnection(projectId, {
            connector_alias: connector.slug,
            owner_type: 'project',
            label: draft.label,
          }),
    onSuccess: (connection, draft) => {
      // A connector with no auth has no credential to enter: the account is ready.
      if (!connector.authSecret) {
        onAdded();
        return;
      }
      onCredential({
        connectionId: connection.connection_id,
        owner: draft.audience === 'private' ? 'me' : 'project',
      });
    },
    onError: (e: Error) => {
      onAdded();
      errorToast(e.message || tI18nComplete.raw('texta2cf78785484'));
    },
  });

  const pending = createAccount.isPending || addManaged.isPending || connectionsQuery.isLoading;
  const add = (audience: InstallAudience) => {
    if (pending) return;
    // An unloaded list would propose a label an account already uses, and a
    // taken label updates that account instead of adding one.
    if (!connectionsQuery.data) {
      errorToast(tI18nComplete.raw('texta2cf78785484'));
      void connectionsQuery.refetch();
      return;
    }
    const rows = connectorConnectionRows(connectionsQuery.data.connections, connector.slug);
    const draft: NewAccountDraft = {
      label: proposeAccountLabel(
        displayName,
        rows.map((row) => row.label),
      ),
      audience,
      picked: { memberIds: [], groupIds: [] },
    };
    if (isManagedConnectorProvider(connector.provider)) {
      // The hooks toast their own errors.
      void addManaged.add(draft).catch(() => undefined);
    } else {
      createAccount.mutate(draft);
    }
  };

  return { add, pending };
}

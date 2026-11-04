'use client';

import {
  listConnections,
  reconcileConnection,
  reconcileMemberConnection,
  renameConnection,
  type AdminConnector,
  type Connection,
} from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { errorToast, warningToast } from '../../../primitives/toast';
import { proposeAccountLabel } from '../../../customize/connectors/install/install';
import { isManagedConnectorProvider } from '../../../customize/connectors/provider-label';
import {
  signInOrReason,
  startDiscoveredSignIn,
} from '../../../customize/sections/connector-oauth2-start';
import {
  connectorConnectionRows,
  newAccountGrantees,
  type NewAccountDraft,
} from '../../../customize/sections/view/connector-connections';
import { grantConnectionAccess } from '../../../access/access/access-dialog-share';
import { useAddManagedAccount } from './use-add-managed-account';
import { useTranslations } from '../../../i18n';

/**
 * Add one account to a connector. The connector profile is the project's; the
 * ACCOUNT carries who may use it: only the caller, everyone in the project, or
 * picked people and groups (`NewAccountDraft`). A shared account on a
 * connector whose only shared account is the empty one made with it reuses
 * that one (`emptyProjectSlot`), so it stays the connector's default.
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
  const tPages = useTranslations('connectorPages');
  const accountId = useProjectAccountId(projectId);
  // Same key and fetcher as `ConnectionsList`, so both share one cache entry.
  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
    // A channel connector has no accounts: same guard as `useConnectorDetail`.
    enabled: connector.provider !== 'channel' || connector.platform === 'email',
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
      // The empty shared account the server made with the connector IS the
      // project's account: sign that one in. A second unpinned shared account
      // leaves the connector with no default, so its sign-in never loads the
      // tools. Read the list fresh: someone may have signed the slot in since.
      const { data } = await connectionsQuery.refetch();
      const rows = connectorConnectionRows(data?.connections, connector.slug);
      const slot = emptyProjectSlot(connector, rows);
      // The proposed name numbers past the slot itself ("<name> 2"): the slot
      // keeps its name unless the user typed one of their own.
      const proposal = proposeAccountLabel(
        displayName,
        rows.map((row) => row.label),
      );
      const connection = !slot
        ? await reconcileConnection(projectId, {
            connector_alias: connector.slug,
            owner_type: 'project',
            label,
          })
        : label === slot.label || label === proposal
          ? slot
          : await renameConnection(projectId, slot.connection_id, label);
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
      // Without one-click OAuth, credential entry; a start that failed says why.
      if (connector.provider === 'mcp') {
        const { url, error } = await signInOrReason(() =>
          startDiscoveredSignIn(projectId, connection.connection_id, window.location.href),
        );
        if (url) {
          window.location.assign(url);
          return;
        }
        if (error) warningToast(tPages('addMcpSignInFailed', { name: displayName, reason: error }));
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
  /** The next free name for a new account: `<name>`, `<name> 2`, … The
   *  unlisted empty slot does not take a name: "Everyone" reuses it. */
  const proposedLabel = () => {
    const rows = connectorConnectionRows(connectionsQuery.data?.connections, connector.slug);
    const slot = emptyProjectSlot(connector, rows);
    return proposeAccountLabel(
      displayName,
      rows.filter((row) => row !== slot).map((row) => row.label),
    );
  };
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

/**
 * The connector's empty shared account: the row the server made with the
 * connector (`metadata.default_slot` `'project'`), never signed in, and the
 * only shared account. Older servers send no `authorized`: no slot then. A
 * connector that needs no credential (`requestAuthType` `'none'`) has none:
 * its first account already works.
 */
export function emptyProjectSlot(
  connector: AdminConnector,
  rows: readonly Connection[],
): Connection | null {
  // `none` means the account works unsigned, for a direct connector only: a
  // managed app reports `none` because Composio holds its sign-in.
  if (connector.requestAuthType === 'none' && !isManagedConnectorProvider(connector.provider)) {
    return null;
  }
  const shared = rows.filter((row) => row.owner_type === 'project');
  const slot = shared.length === 1 ? shared[0]! : null;
  return slot?.authorized === false && slot.metadata?.default_slot === 'project' ? slot : null;
}

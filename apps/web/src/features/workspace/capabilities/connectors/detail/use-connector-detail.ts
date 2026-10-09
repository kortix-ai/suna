'use client';

import { type AdminConnector, type Connection, listConnections } from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { connectorDisplayName } from '@/features/workspace/capabilities/connectors/connector-filter';
import { isManagedConnectorProvider } from '@/features/workspace/capabilities/connectors/provider-label';
import { connectorSetupStatus } from '@/features/workspace/customize/sections/connector-connection-form';
import { connectorConnectionRows } from '@/features/workspace/customize/sections/view/connector-connections';
import { usePipedreamConnectMember } from '@/hooks/connectors/use-pipedream-connect-member';
import { usePipedreamConnectProject } from '@/hooks/connectors/use-pipedream-connect-project';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { connectorHeaderCta } from './connector-header-cta';

export type CredentialTarget = { connectionId: string; owner: 'project' | 'me' };

/**
 * One connector's account picture and the actions its header offers. Shared by
 * the connector page and `ConnectorModal`, so the two cannot disagree.
 */
export function useConnectorDetail({
  projectId,
  connector,
  canWrite,
  onChanged,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  /** Refetch every authorization-derived query. */
  onChanged: () => void;
}) {
  const isManagedProvider = isManagedConnectorProvider(connector.provider);
  const isChannel = connector.provider === 'channel';
  const isComputer = connector.provider === 'computer';
  const displayName = connectorDisplayName(connector);

  const [credentialTarget, setCredentialTarget] = useState<CredentialTarget | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);

  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
    enabled: !isChannel,
  });
  // Every account this caller can reach on the connector: the project's shared
  // rows plus the caller's own private ones. A connector is not an account —
  // the header must never pick "the" connection, because there may be several
  // (Work + Personal) or none.
  // A revoked row is history, not an account: it must not turn "connect the
  // first account" into "finish setting up" (found 2026-09-17 on a connector
  // whose only shared account had just been disconnected).
  const accounts = connectorConnectionRows(
    connectionsQuery.data?.connections,
    connector.slug,
  ).filter((connection) => connection.status !== 'revoked');
  const soleAccount = accounts.length === 1 ? accounts[0]! : null;
  // Server-computed and account-aware: `needs_auth` means no reachable account
  // holds a usable credential, whatever the owner type.
  const setupStatus = connectorSetupStatus(connector);
  const connected = setupStatus === 'connected' || setupStatus === 'user_managed';

  const refreshAccounts = () => {
    void connectionsQuery.refetch();
    onChanged();
  };
  const connectShared = usePipedreamConnectProject(projectId, connector.slug, refreshAccounts);
  const connectMine = usePipedreamConnectMember(projectId, connector.slug, refreshAccounts);

  // `accountId` rides the qk.project.detail(id) cache the connectors page
  // already filled, so the connections probe resolves on the first render
  // instead of after its own getProject round-trip.
  const accountId = useProjectAccountId(projectId);
  const canManageConnections =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId })
      .allowed === true;

  const newSession = useNewProjectSession(projectId);
  /**
   * Start a new session. Given a connection, bind it to THIS connector so the
   * session runs as that exact account — `inherit_unbound` keeps the project
   * default for every OTHER connector, so binding just this one doesn't null
   * the rest. Sessions are private by default, which is what lets a
   * member-owned binding resolve.
   *
   * No connection (the "not connected yet" banner) just opens a fresh private
   * session — there is no more session-level connector requirement to carry;
   * connecting an account already has its own direct flow on this tab.
   */
  const startPrivateSession = (connection?: Connection) => {
    newSession({
      create: connection
        ? {
            connector_bindings: { [connector.slug]: { connection_id: connection.connection_id } },
            inherit_unbound: true,
          }
        : {},
    });
  };

  // `accounts` holds only the computers the caller can use (their own or a
  // project-shared one).
  const headerCta = connectorHeaderCta({
    provider: connector.provider,
    canWrite,
    hasAuth: isManagedProvider || Boolean(connector.authSecret),
    connected,
    accountCount: accounts.length,
    hasComputer: accounts.some((account) => Boolean(account.tunnel_id)),
  });

  /** Re-authorize one account: the provider window for a managed one,
   *  credential entry for a direct one. */
  const reconnectAccount = (account: Connection) => {
    const owner = account.owner_type === 'project' ? 'project' : 'me';
    if (isManagedProvider) {
      // Reconciling the SAME label re-points this row, never a second account.
      if (owner === 'project') connectShared.mutate({ label: account.label });
      else connectMine.mutate({ label: account.label });
      return;
    }
    setCredentialTarget({ connectionId: account.connection_id, owner });
  };
  const replaceSoleAccount = () => {
    if (soleAccount) reconnectAccount(soleAccount);
  };

  return {
    displayName,
    isManagedProvider,
    isChannel,
    isComputer,
    connectionsQuery,
    accounts,
    connected,
    canManageConnections,
    headerCta,
    connectPending: connectShared.isPending || connectMine.isPending,
    refreshAccounts,
    replaceSoleAccount,
    startPrivateSession,
    reconnectAccount,
    credentialTarget,
    setCredentialTarget,
    computerOpen,
    setComputerOpen,
  };
}

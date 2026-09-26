'use client';

import type { AdminConnector, Connection } from '@kortix/sdk';
import { useTranslations } from '@/i18n/use-translations';

import { Label } from '@/components/ui/label';
import {
  ChannelConnectionSection,
  ConnectionRoster,
  ConnectionsList,
} from '@/features/workspace/customize/sections/connectors-view';
import { isManagedConnectorProvider } from '../provider-label';
import { ComputerConnectorAccount } from './computer-connector-account';

export interface ConnectorAccountsProps {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  canManageConnections: boolean;
  onChanged: () => void;
  onRemoved: () => void;
  /** Start a session bound to this exact account. */
  onStartSession: (connection: Connection) => void;
  /** Bumped to open the Add account dialog from outside the tab. */
  addRequest?: number;
}

/**
 * Accounts — which accounts this connector runs as.
 *
 * A connector is a declared capability with no identity; an account
 * (`connector_connections` row) is an authorized identity on it, owned by the
 * project (shared) or by one member — and BOTH can coexist on the very same
 * connector, direct or managed alike. So every provider except Computer
 * Tunnel (`ComputerConnectorAccount`, its own machine-assignment UI) and
 * Channel (`ChannelConnectionSection`, its own per-platform connect flow)
 * gets the same one-list `ConnectionsList`:
 *
 * - Managed (Composio/Pipedream) — "Add" runs the hosted Connect Link OAuth
 *   flow (`usePipedreamConnectProject` / `usePipedreamConnectMember`).
 * - Direct (openapi/http/mcp/graphql/postman/…) — "Add" creates the account
 *   then opens `SetCredentialModal` for it, wired inside `ConnectionsList`
 *   itself. Every row also gets a "Set credential" action to re-enter it.
 *
 * `ConnectionSection` (the transport config — slug/provider/spec/auth/
 * headers) is NOT mounted here any more. It moved to the Settings tab
 * (`connector-settings.tsx`) — see that file's docstring. Mounting it here
 * too would print the same form twice.
 */
export function ConnectorAccounts({
  projectId,
  connector,
  displayName,
  canWrite,
  canManageConnections,
  onChanged,
  onRemoved,
  onStartSession,
  addRequest,
}: ConnectorAccountsProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isManagedProvider = isManagedConnectorProvider(connector.provider);
  const isChannel = connector.provider === 'channel';
  const isComputer = connector.provider === 'computer';
  const showRoster =
    isManagedProvider && canManageConnections && connector.authorizationStrategy === 'user';

  if (isComputer) {
    return (
      <ComputerConnectorAccount
        projectId={projectId}
        connector={connector}
        canWrite={canWrite}
        onChanged={onChanged}
      />
    );
  }

  if (isChannel) {
    return (
      <ChannelConnectionSection
        projectId={projectId}
        connector={connector}
        onChanged={onChanged}
        onRemoved={onRemoved}
        canWrite={canWrite}
      />
    );
  }

  return (
    <div className="space-y-5">
      <ConnectionsList
        projectId={projectId}
        connector={connector}
        displayName={displayName}
        canManageConnections={canManageConnections}
        onChanged={onChanged}
        onStartSession={onStartSession}
        addRequest={addRequest}
      />
      {showRoster ? (
        <section className="space-y-2">
          <Label>{tI18nComplete.raw('text74156382383b')}</Label>
          <ConnectionRoster
            projectId={projectId}
            connectorSlug={connector.slug}
            displayName={displayName}
          />
        </section>
      ) : null}
    </div>
  );
}

'use client';

import { useTranslations } from '@/i18n/use-translations';
import type { AdminConnector, Connection } from '@kortix/sdk';

import { Label } from '@/components/ui/label';
import {
  ChannelConnectionSection,
  ConnectionRoster,
  ConnectionsList,
} from '@/features/workspace/customize/sections/connectors-view';
import { isManagedConnectorProvider } from '../provider-label';
import { AccountInfo } from './account-info';

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
  /** Where credential entry opens. Omitted = the list's own dialog. */
  onSetCredential?: (target: { connectionId: string; owner: 'project' | 'me' }) => void;
  /** Show the ⓘ that explains accounts. The page sets it; the modal does not. */
  showAccountInfo?: boolean;
}

/**
 * Accounts — which accounts this connector runs as.
 *
 * A connector is a declared capability with no identity; an account
 * (`connector_connections` row) is an authorized identity on it, owned by the
 * project (shared) or by one member — and BOTH can coexist on the very same
 * connector, direct or managed alike. So every provider except Channel
 * (`ChannelConnectionSection`, its own per-platform connect flow) gets the
 * same one-list `ConnectionsList`:
 *
 * - Managed (Composio/Pipedream) — "Add" runs the hosted Connect Link OAuth
 *   flow (`usePipedreamConnectProject` / `usePipedreamConnectMember`).
 * - Direct (openapi/http/mcp/graphql/postman/…) — "Add" creates the account
 *   then opens `SetCredentialModal` for it, wired inside `ConnectionsList`
 *   itself. Every row also gets a "Set credential" action to re-enter it.
 * - Computer — each account is one paired machine. "Add" opens
 *   `ComputerConnectModal` (connect this machine, or download + npx) instead
 *   of credential entry. Everything else — the row, Share, the menu — is the
 *   same as every other connector.
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
  onSetCredential,
  showAccountInfo = false,
}: ConnectorAccountsProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isManagedProvider = isManagedConnectorProvider(connector.provider);
  const isChannel = connector.provider === 'channel';
  const showRoster =
    isManagedProvider && canManageConnections && connector.authorizationStrategy === 'user';

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
        onSetCredential={onSetCredential}
        addVariant="default"
        titleAddon={
          showAccountInfo ? (
            <AccountInfo projectId={projectId} displayName={displayName} />
          ) : undefined
        }
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

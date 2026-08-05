'use client';

import type { AdminConnector } from '@kortix/sdk';

import { Label } from '@/components/ui/label';
import {
  ChannelConnectionSection,
  ConnectionRoster,
  ConnectionSection,
  ConnectionsList,
} from '@/features/workspace/customize/sections/connectors-view';

export interface ConnectorAccountsProps {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  canManageProfiles: boolean;
  strategyUpdating: boolean;
  onChanged: () => void;
  onRemoved: () => void;
  onStartSession: () => void;
  onSetCredential: () => void;
}

/**
 * Accounts — which accounts this connector runs as.
 *
 * Pipedream connectors hold many authorizations (one project account plus one
 * per member), so they get `ConnectionsList` and, for a per-user connector, the
 * team roster below it. Every other connector has at most one credential, owned
 * by `ConnectionSection` — or `ChannelConnectionSection` for channels.
 *
 * `ConnectionSection` also carries the transport config, which belongs on
 * Settings. It is one component with no seam between the two, and splitting it
 * means editing `connectors-view.tsx`, so it is mounted here only — showing it
 * on both tabs would print the same form twice.
 */
export function ConnectorAccounts({
  projectId,
  connector,
  displayName,
  canWrite,
  canManageProfiles,
  strategyUpdating,
  onChanged,
  onRemoved,
  onStartSession,
  onSetCredential,
}: ConnectorAccountsProps) {
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
  const showRoster =
    isPipedream && canManageProfiles && connector.authorizationStrategy === 'user';

  if (isPipedream) {
    return (
      <div className="space-y-5">
        <ConnectionsList
          projectId={projectId}
          connector={connector}
          displayName={displayName}
          canManageProfiles={canManageProfiles}
          onChanged={onChanged}
          onStartSession={onStartSession}
          disabled={strategyUpdating}
        />
        {showRoster ? (
          <section className="space-y-2">
            <Label>Team members</Label>
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

  // `ConnectionSection` fetches its config with `enabled: canWrite` and renders
  // a skeleton until that resolves, so showing it to a reader would leave three
  // grey bars on screen for good. The old panel had the same gate
  // (`showProfileTab = canWrite && …`); a reader is told why instead.
  if (!canWrite) {
    return (
      <p className="text-muted-foreground text-sm text-pretty">
        {displayName} runs on{' '}
        {usesProjectAuthorization
          ? 'one account shared by the whole project'
          : 'each person’s own account'}
        . You do not have permission to change it — ask a project manager.
      </p>
    );
  }

  // `canWrite` is already true past the guard above, so the only thing left to
  // gate on is the in-flight strategy change — writing an account while the
  // authorization owner is moving would race it.
  return isChannel ? (
    <ChannelConnectionSection
      projectId={projectId}
      connector={connector}
      onChanged={onChanged}
      onRemoved={onRemoved}
      canWrite={!strategyUpdating}
    />
  ) : (
    <ConnectionSection
      projectId={projectId}
      connector={connector}
      onChanged={onChanged}
      canWrite={!strategyUpdating}
      onSetCredential={usesProjectAuthorization ? onSetCredential : undefined}
    />
  );
}

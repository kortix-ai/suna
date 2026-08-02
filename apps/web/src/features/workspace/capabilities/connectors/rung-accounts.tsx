'use client';

import type { AdminConnector } from '@kortix/sdk';

import { Label } from '@/components/ui/label';
import {
  ChannelConnectionSection,
  ConnectionRoster,
  ConnectionSection,
  ConnectionsList,
} from '@/features/workspace/customize/sections/connectors-view';

export interface RungAccountsProps {
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
 * Accounts — capabilities #7 and #10, plus, for the connectors with no
 * account list, capability #8's shared-credential form.
 *
 * Pipedream connectors hold many authorizations (project + per-member), so
 * they get `ConnectionsList` — the exact component from `connectors-view.tsx`
 * (Task 8), unchanged: add project account, add my account, set default,
 * disconnect, copy connection ID and "Use in a new session" all move with it.
 * Every other connector has at most one credential, which `ConnectionSection`
 * (or `ChannelConnectionSection` for `provider === 'channel'`) owns. The
 * branch picks on the same predicate the old panel used:
 * `connector.provider === 'pipedream'`.
 *
 * Below the list, the team roster (capability #10) is a section of THIS rung,
 * not a fourth tab — visible without a click, on the old panel's exact
 * `showRoster` condition: `isPipedream && canManageProfiles &&
 * authorizationStrategy === 'user'`.
 *
 * FOLLOW-UP (not done here): the brief asks for the connection-ID label to
 * read "Account ID" instead of "Connection ID". Every place that string
 * appears — `connectors-view.tsx:898` (the `Hint` tooltip, which keeps its
 * technical wording per the brief), `:917` ("Copy connection ID" dropdown
 * item) and `:989` ("Connection ID copied" toast) — lives inside the
 * module-private `ConnectionRow` or `ConnectionsList`'s own `copyConnectionId`
 * closure. Neither is exported with a label-override prop, and both are
 * frozen (`connectors-view.tsx` must hold a zero-line diff). Relabeling those
 * three strings needs a prop added to `ConnectionRow`/`ConnectionsList` in a
 * task scoped to edit that file — left as-is here rather than touching shared
 * code mid-task.
 *
 * DEVIATION worth flagging to Task 12: the Capability Inventory files
 * `ConnectionSection` under Settings (#8) and Accounts (#7). It is ONE
 * component carrying both the credential row and the transport config, and it
 * cannot be split without editing the frozen `connectors-view.tsx`. Mounting
 * it on both rungs would print the same form twice, so it is mounted once,
 * here — the wider slot, since Accounts exists for readers and Settings does
 * not. Task 12 decides where it finally lives.
 */
export function RungAccounts({
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
}: RungAccountsProps) {
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
  // Capability #10, on the old panel's `showRoster` condition.
  const showRoster =
    isPipedream && canManageProfiles && connector.authorizationStrategy === 'user';

  if (isPipedream) {
    return (
      <div className="space-y-5">
        {/* Capability #7, verbatim. */}
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

  // Capability #8.
  return isChannel ? (
    <ChannelConnectionSection
      projectId={projectId}
      connector={connector}
      onChanged={onChanged}
      onRemoved={onRemoved}
      canWrite={canWrite && !strategyUpdating}
    />
  ) : (
    <ConnectionSection
      projectId={projectId}
      connector={connector}
      onChanged={onChanged}
      canWrite={canWrite && !strategyUpdating}
      onSetCredential={usesProjectAuthorization ? onSetCredential : undefined}
    />
  );
}

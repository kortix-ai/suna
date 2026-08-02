'use client';

import {
  type AdminConnector,
  type ConnectorAuthorizationStrategy,
  deleteConnector,
  listConnectionProfiles,
  setConnectorAuthorizationStrategy,
  setConnectorName,
} from '@kortix/sdk';
import {
  CheckIcon,
  KeyIcon,
  LockIcon,
  MonitorIcon,
  PencilSimpleIcon,
  TrashIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import {
  authorizationOwnerTypeForStrategy,
  connectorAuthorizationStrategyIsEditable,
  connectorAuthorizationUpdateIsPending,
} from '@/features/workspace/customize/sections/connector-profile-form';
import { AuthorizationStrategyField } from '@/features/workspace/customize/sections/connector-profile-modal';
import {
  ChannelConnectionSection,
  ConnectionRoster,
  ConnectionSection,
  ConnectionsList,
  ConnectorAppIcon,
  ConnectorStatusBadge,
  PermissionsSection,
  providerLabel,
  SetCredentialModal,
  usePipedreamConnect,
} from '@/features/workspace/customize/sections/connectors-view';
import { connectorConnectionRows } from '@/features/workspace/customize/sections/view/connector-connections';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { useCustomizeStore } from '@/stores/customize-store';

import { CONNECTOR_RUNG_LABEL, type ConnectorRung, visibleRungs } from './connector-rungs';

export interface ConnectorModalProps {
  projectId: string;
  /** The connector to show. `null` while nothing is selected — callers keep
   *  `open` false in that case. */
  connector: AdminConnector | null;
  canWrite: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refetch every authorization-derived query. Every mutation below calls it. */
  onChanged: () => void;
  /** The connector no longer exists — clear the selection and close. */
  onRemoved: () => void;
}

/**
 * A connector's detail, as a fixed ladder of rungs instead of a tab bar that
 * reshapes per connector.
 *
 * The panel this replaces (`ConnectorDetail`, `connectors-view.tsx:1258`)
 * derived four independent booleans — `showConnections`, `showProfileTab`,
 * `showPermissions`, `showRoster` — from provider, authorization strategy and
 * permission, so it rendered anywhere from zero to four tabs and the surface
 * changed shape between two connectors in the same grid. `visibleRungs` keeps
 * one canonical order: a rung that does not apply is absent, the rest never
 * move.
 *
 * `ConnectorModalBody` is keyed on `connector.slug`, the same treatment
 * `EntityDetailModal` gives its entity: picking a different card while the
 * modal stays open resets the active rung, the credential dialog and the
 * rename draft, without remounting `Modal`/`ModalContent` (which would replay
 * the open animation and drop focus-trap continuity).
 *
 * INTERIM: each rung mounts the shipped component for its capability verbatim,
 * so nothing in the Capability Inventory becomes unreachable between this task
 * and the four that refine the rung bodies (`rung-overview.tsx`,
 * `rung-accounts.tsx`, `rung-permissions.tsx`, `rung-settings.tsx`). No rung is
 * a stub.
 */
export function ConnectorModal({
  projectId,
  connector,
  canWrite,
  open,
  onOpenChange,
  onChanged,
  onRemoved,
}: ConnectorModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      {/* The header prints the connector's name as a real, visible `ModalTitle`,
          so Radix has its accessible name and no `VisuallyHidden` stand-in is
          needed (the panel this replaced owned its own heading, which is why
          one was). There is no `ModalDescription` — the meta row under the
          title is badges and a slug, not prose — so Radix's documented
          `aria-describedby={undefined}` opt-out applies. */}
      <ModalContent className="lg:max-w-4xl" aria-describedby={undefined}>
        {connector ? (
          <ConnectorModalBody
            key={connector.slug}
            projectId={projectId}
            connector={connector}
            canWrite={canWrite}
            onChanged={onChanged}
            onRemoved={onRemoved}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function ConnectorModalBody({
  projectId,
  connector,
  canWrite,
  onChanged,
  onRemoved,
  onClose,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  onChanged: () => void;
  onRemoved: () => void;
  onClose: () => void;
}) {
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  // Computer (Agent Computer Tunnel) connectors are paired, granted and
  // audited in the Computers tab. Same carve-out the old panel made.
  const isComputer = connector.provider === 'computer';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
  const connected = usesProjectAuthorization && connector.secretSet;
  const displayName = connector.name?.trim() || connector.slug;
  const toolCount = connector.actions.length;

  const rungs = visibleRungs(connector, { canWrite });
  const [selectedRung, setSelectedRung] = useState<ConnectorRung>('overview');
  // Derived, not an effect: `canWrite` can resolve late and a provider's rung
  // set can shrink while the modal is open. Clamping here means there is never
  // a render where the nav highlights a rung whose body is not mounted, which
  // an effect-based reset would allow for one frame.
  const rung = rungs.includes(selectedRung) ? selectedRung : 'overview';

  const [credOpen, setCredOpen] = useState(false);

  // One query, two readers — the same key `ConnectionsList` uses, so the
  // Accounts count on the nav can never disagree with the rows it counts
  // (react-query dedupes the fetch).
  const profilesQuery = useQuery({
    queryKey: ['connector-profiles', projectId],
    queryFn: () => listConnectionProfiles(projectId),
    staleTime: 30_000,
    enabled: !isChannel && !isComputer,
  });
  // The project-default profile — the `profile_id` a backend passes in
  // `connector_bindings` to run a session as this connection.
  const connectionProfile = profilesQuery.data?.profiles.find(
    (p) => p.connector_alias === connector.slug && p.owner_type === 'project' && p.is_default,
  );
  // The CURRENT USER's own member-owned connection, if any. The API scopes
  // this list to the caller, so a member sees only their own here.
  const myPrivateProfile = profilesQuery.data?.profiles.find(
    (p) => p.connector_alias === connector.slug && p.owner_type === 'member',
  );
  const connectionCount = connectorConnectionRows(
    profilesQuery.data?.profiles,
    connector.slug,
  ).filter(
    (profile) =>
      profile.owner_type === authorizationOwnerTypeForStrategy(connector.authorizationStrategy),
  ).length;

  const reconnect = usePipedreamConnect(projectId, connector.slug, onChanged);

  // Administering project authorizations (adding another, changing the project
  // default) is manager-gated; a member always manages their OWN connections.
  const canManageProfiles =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE).allowed === true;

  // Start a session bound to THIS member's own connection for this connector.
  // `require_connectors` makes the server resolve their member profile and, if
  // it was revoked, the connect-to-start gate re-prompts.
  const newSession = useNewProjectSession(projectId);
  const startPrivateSession = () => {
    newSession({ create: { require_connectors: [connector.slug] } });
  };

  const [authorizationStrategyAwaitingRefresh, setAuthorizationStrategyAwaitingRefresh] =
    useState<ConnectorAuthorizationStrategy | null>(null);
  // Ported from `connectors-view.tsx:1371-1375`. Clear the submitted value the
  // moment the refetched connector reports it — NOT in the mutation's
  // `onSuccess`.
  //
  // The state exists to hold the field locked across the gap between the
  // mutation resolving and `onChanged`'s refetch landing. Clearing it in
  // `onSuccess` closes that gap: `mutationPending` drops in the same tick, so
  // `strategyUpdating` goes false while `connector.authorizationStrategy` is
  // still the OLD value, and the user watches their change appear not to have
  // taken until the refetch arrives. Clearing on catch-up fixes the real
  // defect — a submitted value outliving its request, which would re-lock
  // every rung if the server later moved the strategy again — without
  // reopening that window.
  useEffect(() => {
    if (authorizationStrategyAwaitingRefresh === connector.authorizationStrategy) {
      setAuthorizationStrategyAwaitingRefresh(null);
    }
  }, [authorizationStrategyAwaitingRefresh, connector.authorizationStrategy]);
  const updateAuthorizationStrategy = useMutation({
    mutationFn: (next: ConnectorAuthorizationStrategy) =>
      setConnectorAuthorizationStrategy(projectId, connector.slug, next),
    onSuccess: (result, next) => {
      const syncError = result.sync?.errors.find((error) => error.slug === connector.slug);
      if (syncError) {
        warningToast(
          `Authorization owner changed, but synchronization failed: ${syncError.error}. Use Sync to retry.`,
        );
        onChanged();
        return;
      }
      successToast(`Authorization owner set to ${next === 'project' ? 'Project' : 'User'}`);
      onChanged();
    },
    onError: (error: Error) => {
      setAuthorizationStrategyAwaitingRefresh(null);
      errorToast(error.message || 'Failed to update authorization owner');
    },
  });
  const strategyUpdating = connectorAuthorizationUpdateIsPending(
    connector.authorizationStrategy,
    authorizationStrategyAwaitingRefresh,
    updateAuthorizationStrategy.isPending,
  );

  // Capability #3 — the compact reconnect/replace pair. It sits in the header
  // rather than a rung because it applies whichever rung is open. `pr-14`
  // clears `ModalContent`'s absolutely-positioned close button (`right-3` +
  // `size-8` = 40.5px of occupied gutter).
  const showHeaderCredentialAction =
    canWrite && Boolean(connector.authSecret) && connected && !isChannel;

  return (
    <>
      <ModalHeader className="flex-row items-start gap-3.5 pr-14">
        <ConnectorAppIcon connector={connector} size="lg" />
        <div className="min-w-0 flex-1">
          {/* Capability #1 */}
          <HeaderName
            projectId={projectId}
            slug={connector.slug}
            displayName={displayName}
            canWrite={canWrite}
            disabled={strategyUpdating}
            onChanged={onChanged}
          />
          {/* Capability #2 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge variant="outline" size="sm">
              {providerLabel(connector.provider)}
            </Badge>
            <ConnectorStatusBadge connector={connector} />
            <InlineMeta>
              <code className="font-mono">{connector.slug}</code>
              {toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : null}
            </InlineMeta>
          </div>
        </div>
        {showHeaderCredentialAction ? (
          isPipedream ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => reconnect.mutate()}
              disabled={reconnect.isPending || strategyUpdating}
            >
              {reconnect.isPending ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <KeyIcon className="size-4 shrink-0" />
              )}
              Reconnect
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => setCredOpen(true)}
              disabled={strategyUpdating}
            >
              <KeyIcon className="size-4 shrink-0" />
              Replace credential
            </Button>
          )
        ) : null}
      </ModalHeader>

      <ModalBody className="max-h-[70vh] overflow-hidden p-0">
        <div className="flex min-h-0 flex-col overflow-y-auto lg:h-[70vh] lg:flex-row lg:overflow-hidden">
          {/* The rung ladder: a rail beside the content on desktop, the same
              ladder laid on its side above it on a phone, where a 191px rail
              would eat a third of the width for four words.

              ONE control, re-flowed — not a rail plus a `TabsListCompact`
              strip. Two rendered controls for one value means a screen reader
              meets every rung twice, and Radix's `TabsTrigger` emits
              `aria-controls` pointing at a `TabsContent` id, which a nav-driven
              pane does not have. Buttons carrying `aria-current` are what the
              shipped `EntityDetailModal` file rail uses for the same job. */}
          <nav
            aria-label={`${displayName} sections`}
            className={cn(
              'border-border/60 flex shrink-0 gap-1 overflow-x-auto border-b p-2',
              'lg:w-52 lg:flex-col lg:gap-0.5 lg:overflow-x-visible lg:overflow-y-auto lg:border-r lg:border-b-0',
            )}
          >
            {rungs.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setSelectedRung(value)}
                aria-current={value === rung}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap transition-colors',
                  'lg:w-full lg:justify-between',
                  'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
                  value === rung
                    ? 'bg-primary/[0.06] text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-primary/[0.03] hover:text-foreground',
                )}
              >
                {CONNECTOR_RUNG_LABEL[value]}
                {/* Only Pipedream connectors hold more than one authorization,
                    so only they have a number worth printing. */}
                {value === 'accounts' && isPipedream && connectionCount > 0 ? (
                  <Badge variant="secondary" size="sm">
                    {connectionCount}
                  </Badge>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {rung === 'overview' ? (
              <OverviewRung
                connector={connector}
                displayName={displayName}
                canWrite={canWrite}
                connected={connected}
                strategyUpdating={strategyUpdating}
                reconnectPending={reconnect.isPending}
                onReconnect={() => reconnect.mutate()}
                onSetCredential={() => setCredOpen(true)}
                onClose={onClose}
              />
            ) : null}
            {rung === 'accounts' ? (
              <AccountsRung
                projectId={projectId}
                connector={connector}
                displayName={displayName}
                canWrite={canWrite}
                canManageProfiles={canManageProfiles}
                strategyUpdating={strategyUpdating}
                onChanged={onChanged}
                onRemoved={onRemoved}
                onStartSession={startPrivateSession}
                onSetCredential={() => setCredOpen(true)}
              />
            ) : null}
            {rung === 'permissions' ? (
              // Capability #9, verbatim.
              <PermissionsSection
                projectId={projectId}
                connector={connector}
                onChanged={onChanged}
                canWrite={canWrite && !strategyUpdating}
              />
            ) : null}
            {rung === 'settings' ? (
              <SettingsRung
                projectId={projectId}
                connector={connector}
                displayName={displayName}
                canWrite={canWrite}
                strategyUpdating={strategyUpdating}
                onAuthorizationStrategyChange={(next) => {
                  setCredOpen(false);
                  setAuthorizationStrategyAwaitingRefresh(next);
                  updateAuthorizationStrategy.mutate(next);
                }}
                onRemoved={onRemoved}
              />
            ) : null}
          </div>
        </div>
      </ModalBody>

      {/* Capability #12 — hosted at shell level so the header action and any
          rung can open the one dialog. */}
      <SetCredentialModal
        projectId={projectId}
        connector={credOpen ? connector : null}
        profileId={
          usesProjectAuthorization
            ? (connectionProfile?.profile_id ?? null)
            : (myPrivateProfile?.profile_id ?? null)
        }
        authorizationStrategy={connector.authorizationStrategy}
        open={credOpen}
        onOpenChange={setCredOpen}
        onSaved={onChanged}
      />
    </>
  );
}

/**
 * Overview — capabilities #5, #6 and #13, on the conditions the old panel used
 * line for line, plus a plain statement of the connection state when none of
 * the three applies (otherwise a connected connector's first rung would be
 * blank).
 *
 * Task 9 replaces the body with the designed version; the conditions and the
 * flows they fire are what must survive that edit unchanged.
 */
function OverviewRung({
  connector,
  displayName,
  canWrite,
  connected,
  strategyUpdating,
  reconnectPending,
  onReconnect,
  onSetCredential,
  onClose,
}: {
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  connected: boolean;
  strategyUpdating: boolean;
  reconnectPending: boolean;
  onReconnect: () => void;
  onSetCredential: () => void;
  onClose: () => void;
}) {
  const openCustomize = useCustomizeStore((s) => s.openCustomize);
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  const isComputer = connector.provider === 'computer';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';

  const showProjectConnect =
    Boolean(connector.authSecret) && !connected && !isChannel && usesProjectAuthorization;
  const showPersonalConnect =
    Boolean(connector.authSecret) &&
    !isPipedream &&
    !isChannel &&
    !isComputer &&
    !usesProjectAuthorization;
  // Nothing to act on — say where the connector stands instead of showing an
  // empty rung.
  const showState = !showProjectConnect && !showPersonalConnect && !isComputer;

  return (
    <div className="space-y-4">
      {/* Capability #13. Computers stayed in the Customize overlay when
          Connectors, Skills and Commands graduated to routes, so this is a
          deliberate cross-surface jump: close the modal, then open the overlay
          on that section. `setSection` alone — what the old panel called, back
          when it was itself inside the overlay — would now mutate overlay state
          without ever showing it. */}
      {isComputer ? (
        <InfoBanner
          tone="info"
          icon={MonitorIcon}
          title={`${displayName} is managed in Computers`}
          action={
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => {
                onClose();
                openCustomize('computers');
              }}
            >
              <MonitorIcon className="size-4 shrink-0" />
              Open Computers
            </Button>
          }
        >
          Connect a machine, and grant or revoke per-capability access, in the Computers tab. Here
          you control who can use it and review its tools.
        </InfoBanner>
      ) : null}

      {/* Capability #5. Project-owned profiles accept only project-managed
          authorizations. */}
      {showProjectConnect ? (
        <InfoBanner
          tone="info"
          icon={UsersIcon}
          title={`Connect ${displayName} for the project`}
          action={
            canWrite ? (
              <Button
                size="lg"
                className="h-11 shrink-0 gap-2 px-5 font-semibold"
                onClick={() => (isPipedream ? onReconnect() : onSetCredential())}
                disabled={strategyUpdating || (isPipedream && reconnectPending)}
              >
                {isPipedream && reconnectPending ? <Loading className="size-4 shrink-0" /> : null}
                {isPipedream ? 'Connect for the project' : 'Set shared credential'}
              </Button>
            ) : undefined
          }
        >
          {isPipedream
            ? `One project-managed ${displayName} account is available to allowed sessions and triggers.`
            : 'One shared credential that everyone on this project uses — the agent and your triggers run on it.'}
        </InfoBanner>
      ) : null}

      {/* Capability #6. Deliberately NOT gated on `canWrite`: a member always
          manages their own private credential. */}
      {showPersonalConnect ? (
        <InfoBanner
          tone="info"
          icon={LockIcon}
          title={`Connect ${displayName} for your sessions`}
          action={
            <Button
              size="lg"
              className="h-11 shrink-0 gap-2 px-5 font-semibold"
              onClick={onSetCredential}
              disabled={strategyUpdating}
            >
              <KeyIcon className="size-4 shrink-0" />
              Set or replace my credential
            </Button>
          }
        >
          Your credential is private to your account. Only your private sessions can use this
          connector authorization.
        </InfoBanner>
      ) : null}

      {showState ? (
        <ConnectorStatePanel
          connector={connector}
          displayName={displayName}
          connected={connected}
        />
      ) : null}
    </div>
  );
}

/**
 * Where the connector stands, read off its own record — no invented copy, and
 * no claim the record cannot support.
 *
 * `connected` only means something under project authorization (it is
 * `authorizationStrategy === 'project' && secretSet`). A user-strategy
 * connector has one credential per person, none of which this record knows
 * about, so it must never be reported here as "not connected" — that account
 * list is the Accounts rung's job.
 */
function ConnectorStatePanel({
  connector,
  displayName,
  connected,
}: {
  connector: AdminConnector;
  displayName: string;
  connected: boolean;
}) {
  const toolCount = connector.actions.length;
  const isChannel = connector.provider === 'channel';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';

  // A channel's install state lives in the platform installation, not on this
  // record, so state the kind and defer the state to the rung that knows it.
  const headline = isChannel
    ? `${displayName} is a channel your agent talks through.`
    : !connector.authSecret
      ? 'No credential is needed.'
      : usesProjectAuthorization
        ? connected
          ? 'Connected.'
          : 'Not connected yet.'
        : 'Each person connects their own account.';

  const detail = isChannel
    ? 'Its connection, and what the agent may send through it, are managed under Accounts.'
    : usesProjectAuthorization
      ? 'Sessions in this project run on one shared account.'
      : 'A session runs on the account of whoever started it, and only their private sessions can use it.';

  return (
    <section className="space-y-2">
      <Label>Status</Label>
      <div className="bg-popover space-y-1.5 rounded-md border px-4 py-5">
        <p className="text-foreground text-sm font-medium">{headline}</p>
        <p className="text-muted-foreground text-sm text-pretty">{detail}</p>
        <p className="text-muted-foreground text-sm">
          {toolCount > 0
            ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'} available to the agent.`
            : 'No tools have been synchronized for this connector yet.'}
        </p>
      </div>
    </section>
  );
}

/**
 * Accounts — capabilities #7 and #10, and, for the connectors that have no
 * account list, capability #8's shared-credential form.
 *
 * Pipedream connectors hold many authorizations (project + per-member), so they
 * get `ConnectionsList`. Every other connector has at most one credential,
 * which `ConnectionSection` (or `ChannelConnectionSection`) owns.
 *
 * DEVIATION worth flagging to Task 12: the Capability Inventory files
 * `ConnectionSection` under Settings (#8) and Accounts (#7). It is ONE
 * component carrying both the credential row and the transport config, and it
 * cannot be split without editing the frozen `connectors-view.tsx`. Mounting it
 * on both rungs would print the same form twice, so it is mounted once, here —
 * the wider slot, since Accounts exists for readers and Settings does not.
 * Task 12 decides where it finally lives.
 */
function AccountsRung({
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
}: {
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
}) {
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
  // Capability #10, on the old panel's `showRoster` condition.
  const showRoster = isPipedream && canManageProfiles && connector.authorizationStrategy === 'user';

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
            <Label>Project members</Label>
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

/**
 * Settings — capabilities #4 and #11. Writer-only, and never for a computer
 * connector.
 *
 * Capability #1 (rename) is NOT here: it lives in the header, because a
 * connector's name is not a property of one rung and a computer connector —
 * which has no Settings rung — can be renamed.
 *
 * Task 12 builds the designed version and decides whether #8's connection
 * config moves here from Accounts.
 */
function SettingsRung({
  projectId,
  connector,
  displayName,
  canWrite,
  strategyUpdating,
  onAuthorizationStrategyChange,
  onRemoved,
}: {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  strategyUpdating: boolean;
  onAuthorizationStrategyChange: (next: ConnectorAuthorizationStrategy) => void;
  onRemoved: () => void;
}) {
  const isChannel = connector.provider === 'channel';
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => deleteConnector(projectId, connector.slug),
    onSuccess: () => {
      successToast(`Removed ${displayName}`);
      onRemoved();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to remove'),
  });

  return (
    <div className="space-y-5">
      {/* Capability #4 */}
      <section className="space-y-2">
        <Label>Authorization</Label>
        <div className="bg-popover rounded-md border px-4 py-5">
          <AuthorizationStrategyField
            idPrefix={`connector-${connector.slug}`}
            value={connector.authorizationStrategy}
            onChange={onAuthorizationStrategyChange}
            disabled={!canWrite || !connectorAuthorizationStrategyIsEditable(connector.provider)}
            // Settled once the connector exists. Switching owner after the
            // fact silently changes WHOSE account every future session runs
            // as, and orphans the profiles and permission rules already
            // attached under the old owner — a change that looks like a
            // toggle and behaves like a migration.
            lockedReason="Set when the connector was created. Remove and re-add the connector to change it — switching now would orphan the connections and permission rules already stored under the current owner."
            pending={strategyUpdating}
          />
        </div>
      </section>

      {/* Capability #11. Channel connectors are removed from their own
          connection form (`ChannelConnectionSection`'s disconnect), which is
          why the old panel excluded them here too. */}
      {!isChannel ? (
        <div className="bg-popover rounded-md border px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Remove connector</p>
              <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                Deletes it from kortix.yaml. Stored profiles and permission rules are dropped.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => setConfirmDelete(true)}
              disabled={strategyUpdating}
            >
              <TrashIcon className="size-3.5 shrink-0" />
              Remove
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Remove ${displayName}?`}
        description={
          <>
            This removes <code className="font-mono">{connector.slug}</code> from kortix.yaml and
            drops its stored profile and permission rules. This can’t be undone.
          </>
        }
        confirmLabel="Remove connector"
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-4 shrink-0" />}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

/**
 * Capability #1 — the connector's name, edited in place, exactly where the
 * panel this replaces put it.
 *
 * It belongs in the header rather than a rung: renaming applies to the whole
 * connector, not to one rung's subject, and a rung placement silently made it
 * unreachable for `computer` connectors, which have no Settings rung but can
 * be renamed today.
 *
 * `ModalTitle` is Radix's `Dialog.Title` and is the dialog's accessible name,
 * so it stays MOUNTED while the form is up — visually hidden, not unmounted.
 * Unmounting it would strip the dialog's accessible name for the duration of
 * the edit and trip Radix's missing-title warning. The announced name is the
 * one still stored on the server, which is the honest thing to announce while
 * a new one is being typed.
 */
function HeaderName({
  projectId,
  slug,
  displayName,
  canWrite,
  disabled,
  onChanged,
}: {
  projectId: string;
  slug: string;
  displayName: string;
  canWrite: boolean;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);

  // Ported from `connectors-view.tsx:1367-1370`. A rename landing (or any
  // refetch that changes the stored name) closes the editor and re-seeds the
  // draft, so the field can never sit on a name the server has moved past.
  useEffect(() => {
    setEditing(false);
    setDraft(displayName);
  }, [displayName]);

  const rename = useMutation({
    mutationFn: () => setConnectorName(projectId, slug, draft.trim()),
    onSuccess: () => {
      successToast('Renamed');
      setEditing(false);
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to rename'),
  });

  if (editing && canWrite) {
    return (
      <>
        <VisuallyHidden asChild>
          <ModalTitle>{displayName}</ModalTitle>
        </VisuallyHidden>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && draft.trim() !== displayName) rename.mutate();
            else setEditing(false);
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-9 max-w-xs text-lg font-semibold"
            autoFocus
            disabled={disabled}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="h-9 w-9"
            disabled={rename.isPending || disabled}
            aria-label="Save name"
          >
            {rename.isPending ? (
              <Loading className="size-4 shrink-0" />
            ) : (
              <CheckIcon className="size-4 shrink-0" />
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setDraft(displayName);
            }}
            disabled={rename.isPending || disabled}
          >
            Cancel
          </Button>
        </form>
      </>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <ModalTitle className="truncate text-lg">{displayName}</ModalTitle>
      {canWrite ? (
        <Hint label="Rename">
          <button
            type="button"
            onClick={() => !disabled && setEditing(true)}
            disabled={disabled}
            aria-label="Rename"
            className="text-muted-foreground hover:text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <PencilSimpleIcon className="size-3.5 shrink-0" />
          </button>
        </Hint>
      ) : null}
    </div>
  );
}

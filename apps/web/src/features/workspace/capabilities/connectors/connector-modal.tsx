'use client';

import {
  type AdminConnector,
  type ConnectorAuthorizationStrategy,
  deleteConnector,
  listConnectionProfiles,
  setConnectorAuthorizationStrategy,
  setConnectorName,
} from '@kortix/sdk';
import { CheckIcon, KeyIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
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

import { CONNECTOR_RUNG_LABEL, type ConnectorRung, visibleRungs } from './connector-rungs';
import { RungAccounts } from './rung-accounts';
import { RungOverview } from './rung-overview';

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
 * INTERIM: Permissions and Settings still mount the shipped component for
 * their capability verbatim, so nothing in the Capability Inventory becomes
 * unreachable before the tasks that refine those rung bodies
 * (`rung-permissions.tsx`, `rung-settings.tsx`) land. No rung is a stub.
 * Overview and Accounts are designed — see `./rung-overview.tsx` and
 * `./rung-accounts.tsx`.
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
              <RungOverview
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
              <RungAccounts
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

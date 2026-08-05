'use client';

import {
  type AdminConnector,
  type ConnectorAuthorizationStrategy,
  listConnectionProfiles,
  listPipedreamApps,
  setConnectorAuthorizationStrategy,
  setConnectorName,
} from '@kortix/sdk';
import { CheckIcon, KeyIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { connectorAuthorizationUpdateIsPending } from '@/features/workspace/customize/sections/connector-profile-form';
import { SetCredentialModal } from '@/features/workspace/customize/sections/connectors-view';
import { usePipedreamConnect } from '@/hooks/connectors/use-pipedream-connect-app';

import {
  ConnectorAppIcon,
  ConnectorStatusBadge,
} from '@/features/workspace/capabilities/connectors/connector-identity';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';

import { Icon } from '@/features/icon/icon';
import { foldKey } from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import { connectorDisplayName } from '@/features/workspace/capabilities/connectors/connector-filter';
import { CONNECTOR_RUNG_LABEL, type ConnectorRung, visibleRungs } from './connector-rungs';
import { RungAccounts } from './rung-accounts';
import { RungPermissions } from './rung-permissions';
import { RungSettings } from './rung-settings';

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
 * Connector detail — header identity + rung nav + content pane.
 *
 * Header: icon, name, description, primary connect action.
 * Left: Accounts / Tools / Settings nav.
 * Right: the active rung.
 *
 * `ConnectorModalBody` is keyed on `connector.slug` so picking a different card
 * while the modal stays open resets the active rung without remounting
 * `Modal`/`ModalContent` (which would replay the open animation).
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
      <ModalContent className="h-[70vh] space-y-0 lg:max-w-7xl bg-popover" aria-describedby={undefined}>
        {connector ? (
          <ConnectorModalBody
            key={connector.slug}
            projectId={projectId}
            connector={connector}
            canWrite={canWrite}
            onChanged={onChanged}
            onRemoved={onRemoved}
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
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  const isComputer = connector.provider === 'computer';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
  const connected = usesProjectAuthorization && connector.secretSet;
  const displayName = connectorDisplayName(connector);

  const rungs = visibleRungs(connector, { canWrite });
  const [selectedRung, setSelectedRung] = useState<ConnectorRung>('accounts');
  const rung = rungs.includes(selectedRung) ? selectedRung : (rungs[0] ?? 'accounts');

  const [credOpen, setCredOpen] = useState(false);

  const profilesQuery = useQuery({
    queryKey: ['connector-profiles', projectId],
    queryFn: () => listConnectionProfiles(projectId),
    staleTime: 30_000,
    enabled: !isChannel && !isComputer,
  });
  const connectionProfile = profilesQuery.data?.profiles.find(
    (p) => p.connector_alias === connector.slug && p.owner_type === 'project' && p.is_default,
  );
  const myPrivateProfile = profilesQuery.data?.profiles.find(
    (p) => p.connector_alias === connector.slug && p.owner_type === 'member',
  );

  const reconnect = usePipedreamConnect(projectId, connector.slug, onChanged);

  // Best-effort catalogue description. Never blocks first paint — the header
  // renders without it, then fills in. That is the main open-latency fix:
  // previously this query sat in the critical path of feeling "ready".
  const appDescriptionQuery = useQuery({
    queryKey: ['connector-app-description', projectId, connector.slug, displayName],
    queryFn: async () => {
      const result = await listPipedreamApps(projectId, displayName);
      const match = result.apps.find(
        (app) =>
          foldKey(app.slug) === foldKey(connector.slug) ||
          foldKey(app.name) === foldKey(displayName),
      );
      return match?.description ?? null;
    },
    enabled: isPipedream,
    staleTime: 5 * 60_000,
  });
  const appDescription = isPipedream ? (appDescriptionQuery.data ?? null) : null;

  const canManageProfiles =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE).allowed === true;

  const newSession = useNewProjectSession(projectId);
  const startPrivateSession = () => {
    newSession({ create: { require_connectors: [connector.slug] } });
  };

  const [authorizationStrategyAwaitingRefresh, setAuthorizationStrategyAwaitingRefresh] =
    useState<ConnectorAuthorizationStrategy | null>(null);
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

  const showConnectCta =
    canWrite &&
    Boolean(connector.authSecret) &&
    !connected &&
    !isChannel &&
    usesProjectAuthorization;
  const showReconnectCta = canWrite && Boolean(connector.authSecret) && connected && !isChannel;

  return (
    <>
      <ModalHeader className="flex-row items-start gap-4 border-b pr-14 pb-4">
        <span className="p-1">
          <ConnectorAppIcon connector={connector} size="lg" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <HeaderName
              projectId={projectId}
              slug={connector.slug}
              displayName={displayName}
              canWrite={canWrite}
              disabled={strategyUpdating}
              onChanged={onChanged}
            />
            <ConnectorStatusBadge connector={connector} />
          </div>
          {appDescription ? (
            <p className="text-muted-foreground text-sm text-pretty">{appDescription}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {showConnectCta ? (
            <Button
              size="sm"
              className="gap-1.5 active:scale-[0.96]"
              onClick={() => (isPipedream ? reconnect.mutate() : setCredOpen(true))}
              disabled={strategyUpdating || (isPipedream && reconnect.isPending)}
            >
              {isPipedream && reconnect.isPending ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <PlusIcon className="size-4 shrink-0" weight="bold" />
              )}
              {isPipedream ? 'Connect' : 'Add credential'}
            </Button>
          ) : null}
          {showReconnectCta ? (
            isPipedream ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 active:scale-[0.96]"
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
                className="gap-1.5 active:scale-[0.96]"
                onClick={() => setCredOpen(true)}
                disabled={strategyUpdating}
              >
                <KeyIcon className="size-4 shrink-0" />
                Replace credential
              </Button>
            )
          ) : null}
        </div>
      </ModalHeader>

      <ModalBody className="max-h-[70vh] overflow-hidden p-0">
        <Tabs
          value={rung}
          onValueChange={(next) => setSelectedRung(next as ConnectorRung)}
          className="flex min-h-0 flex-col gap-0 overflow-y-auto lg:h-[70vh] lg:flex-row lg:overflow-hidden"
        >
          <TabsList
            type="underline"
            underlineSize="md"
            size="sm"
            aria-label={`${displayName} sections`}
            className={cn(
              'h-auto w-full shrink-0 justify-start gap-1 rounded-none px-2',
              'overflow-x-auto',
              'lg:border-border lg:h-full lg:w-64 lg:flex-col lg:items-stretch lg:gap-0.5',
              'lg:overflow-x-visible lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-3',
              'lg:**:data-[slot=tabs-trigger]:after:hidden',
              'lg:**:data-[slot=tabs-trigger]:h-auto lg:**:data-[slot=tabs-trigger]:w-full',
              'lg:**:data-[slot=tabs-trigger]:justify-between lg:**:data-[slot=tabs-trigger]:rounded-md',
              'lg:**:data-[slot=tabs-trigger]:px-3 lg:**:data-[slot=tabs-trigger]:py-2',
              'lg:**:data-[slot=tabs-trigger]:data-[state=active]:bg-primary/6',
              'lg:**:data-[slot=tabs-trigger]:data-[state=active]:font-medium',
              'lg:**:data-[slot=tabs-trigger]:data-[state=inactive]:hover:bg-primary/3',
            )}
          >
            {rungs.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="w-fit flex-none gap-2 px-3 py-2.5 active:scale-[0.98] lg:w-full"
              >
                {CONNECTOR_RUNG_LABEL[value]}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="bg-popover min-w-0 flex-1 overflow-hidden overflow-y-auto px-5 py-4 lg:px-6">
            <TabsContent value="accounts">
              {profilesQuery.isError ? (
                <ErrorState
                  size="sm"
                  title="Couldn’t load connections"
                  description={
                    profilesQuery.error instanceof Error
                      ? profilesQuery.error.message
                      : 'The accounts stored for this connector could not be read.'
                  }
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void profilesQuery.refetch()}
                    >
                      Retry
                    </Button>
                  }
                />
              ) : (
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
              )}
            </TabsContent>

            <TabsContent value="permissions">
              <RungPermissions
                projectId={projectId}
                connector={connector}
                displayName={displayName}
                canWrite={canWrite}
                disabled={strategyUpdating}
                onChanged={onChanged}
              />
            </TabsContent>

            <TabsContent value="settings">
              <RungSettings
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
            </TabsContent>
          </div>
        </Tabs>
      </ModalBody>

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
 * Capability #1 — the connector's name, edited in place.
 *
 * `ModalTitle` stays mounted while the form is up (visually hidden) so Radix
 * keeps an accessible name for the dialog during the edit.
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
            className="h-auto max-w-xs border-none py-2 text-sm font-medium ring-0"
            autoFocus
            variant="transparent"
            disabled={disabled}
          />
          <Button
            type="submit"
            size="icon-xs"
            variant="ghost"
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
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setDraft(displayName);
            }}
            disabled={rename.isPending || disabled}
          >
            <Icon.Close className="size-4 shrink-0" />
          </Button>
        </form>
      </>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <ModalTitle className="truncate text-lg font-semibold">{displayName}</ModalTitle>
      {canWrite ? (
        <Hint label="Rename" side="bottom">
          <button
            type="button"
            onClick={() => !disabled && setEditing(true)}
            disabled={disabled}
            aria-label="Rename"
            className="text-muted-foreground hover:text-foreground"
          >
            <PencilSimpleIcon className="size-3.5 shrink-0" />
          </button>
        </Hint>
      ) : null}
    </div>
  );
}

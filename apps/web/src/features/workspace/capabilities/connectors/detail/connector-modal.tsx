'use client';

import { useTranslations } from '@/i18n/use-translations';
import {
  type AdminConnector,
  type Connection,
  listConnections,
  listPipedreamApps,
  reconcileConnection,
  reconcileMemberConnection,
  setConnectorName,
} from '@kortix/sdk';
import { useProjectAccountId } from '@kortix/sdk/react';
import { CheckIcon, KeyIcon, PencilSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalClose,
  ModalContent,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { connectorSetupStatus } from '@/features/workspace/customize/sections/connector-connection-form';
import { SetCredentialModal } from '@/features/workspace/customize/sections/connectors-view';
import { connectorConnectionRows } from '@/features/workspace/customize/sections/view/connector-connections';
import { usePipedreamConnectMember } from '@/hooks/connectors/use-pipedream-connect-member';
import { usePipedreamConnectProject } from '@/hooks/connectors/use-pipedream-connect-project';

import {
  ConnectorAppIcon,
  ConnectorStatusBadge,
} from '@/features/workspace/capabilities/connectors/connector-identity';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';

import { ButtonGroup } from '@/components/ui/button-group';
import { Close } from '@/features/icon/icons/close';
import { foldKey } from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import { connectorDisplayName } from '@/features/workspace/capabilities/connectors/connector-filter';
import { isManagedConnectorProvider } from '@/features/workspace/capabilities/connectors/provider-label';
import { ConnectorAccounts } from './connector-accounts';
import { ConnectorSettings } from './connector-settings';
import { CONNECTOR_TAB_LABEL, type ConnectorTab, connectorTabs } from './connector-tabs';
import { ConnectorTools } from './connector-tools';

export interface ConnectorModalProps {
  projectId: string;
  /** The connector to show, or `null` when it has not resolved yet. `open` is
   *  driven by the SELECTION, not by this — see `shared/detail-selection.ts`. */
  connector: AdminConnector | null;
  canWrite: boolean;
  open: boolean;
  /** Open on a selection whose record is still loading — `?c=<slug>` on a cold
   *  page, which is how every OAuth 2.0 return arrives. Renders the shell so
   *  the modal is present from the first frame instead of appearing on its own
   *  once the list lands. */
  isResolving?: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refetch every authorization-derived query. Every mutation below calls it. */
  onChanged: () => void;
  /** The connector no longer exists — clear the selection and close. */
  onRemoved: () => void;
}

/**
 * Connector detail — header identity + tab nav + content pane.
 *
 * Header: icon, name, description, primary connect action.
 * Left: Accounts / Tools / Settings nav.
 * Right: the active tab.
 *
 * `ConnectorModalBody` is keyed on `connector.slug` so picking a different card
 * while the modal stays open resets the active tab without remounting
 * `Modal`/`ModalContent` (which would replay the open animation).
 */
export function ConnectorModal({
  projectId,
  connector,
  canWrite,
  open,
  isResolving = false,
  onOpenChange,
  onChanged,
  onRemoved,
}: ConnectorModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        className="bg-popover h-[80vh] space-y-0 lg:max-w-6xl"
        aria-describedby={undefined}
        showCloseButton={false}
      >
        {connector ? (
          <ConnectorModalBody
            key={connector.slug}
            projectId={projectId}
            connector={connector}
            canWrite={canWrite}
            onChanged={onChanged}
            onRemoved={onRemoved}
          />
        ) : isResolving ? (
          <ConnectorModalSkeleton />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

/**
 * The shell, while `?c=<slug>` is resolving against a list that has not
 * arrived. Shape-matched to `ConnectorModalBody` — same header height, same
 * left rail width — so the handover fills the placeholders in place instead of
 * relaying the modal out from under the pointer.
 *
 * The `ModalTitle` is real and visually hidden: Radix's Dialog needs an
 * accessible name at all times, and a screen reader announcing "Loading
 * connector" is the honest answer during this window.
 */
function ConnectorModalSkeleton() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <>
      <ModalHeader className="flex-row items-start gap-2.5 border-b pb-4">
        <VisuallyHidden>
          <ModalTitle>{tI18nComplete.raw('text0c21b0363778')}</ModalTitle>
        </VisuallyHidden>
        <span className="p-1">
          <Skeleton className="size-10 rounded-md" />
        </span>
        <div className="min-w-0 flex-1 space-y-2 pt-1">
          <Skeleton className="h-4 w-40 rounded-sm" />
          <Skeleton className="h-3 w-64 rounded-sm" />
        </div>
      </ModalHeader>
      <ModalBody className="max-h-[70vh] overflow-hidden p-0">
        <div className="flex min-h-0 flex-col lg:h-[70vh] lg:flex-row">
          <div className="lg:border-border shrink-0 gap-1 p-3 lg:h-full lg:w-64 lg:border-r">
            <div className="hidden space-y-1.5 lg:block">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9 w-full rounded-md" />
              ))}
            </div>
          </div>
          <div className="min-w-0 flex-1 space-y-3 px-5 py-4 lg:px-6">
            <Skeleton className="h-5 w-32 rounded-sm" />
            <Skeleton className="h-20 w-full rounded-md" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        </div>
      </ModalBody>
    </>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const isManagedProvider = isManagedConnectorProvider(connector.provider);
  const isPipedream = connector.provider === 'pipedream';
  const isChannel = connector.provider === 'channel';
  const isComputer = connector.provider === 'computer';
  const displayName = connectorDisplayName(connector);

  const tabs = connectorTabs(connector, { canWrite });
  const [selectedTab, setSelectedTab] = useState<ConnectorTab>('accounts');
  const tab = tabs.includes(selectedTab) ? selectedTab : (tabs[0] ?? 'accounts');

  const [credentialTarget, setCredentialTarget] = useState<{
    connectionId: string;
    owner: 'project' | 'me';
  } | null>(null);

  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
    enabled: !isChannel && !isComputer,
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
  // Direct providers: create the account first, then collect its credential —
  // the same two-step sequence the Accounts tab runs.
  const createSharedAccount = useMutation({
    mutationFn: (label: string) =>
      reconcileConnection(projectId, {
        connector_alias: connector.slug,
        owner_type: 'project',
        label,
      }),
    onSuccess: (connection) =>
      setCredentialTarget({ connectionId: connection.connection_id, owner: 'project' }),
    onError: (e: Error) => errorToast(e.message),
  });
  const createOwnAccount = useMutation({
    mutationFn: (label: string) =>
      reconcileMemberConnection(projectId, { connector_alias: connector.slug, label }),
    onSuccess: (connection) =>
      setCredentialTarget({ connectionId: connection.connection_id, owner: 'me' }),
    onError: (e: Error) => errorToast(e.message),
  });

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

  // `accountId` rides the qk.project.detail(id) cache the connectors page
  // already filled, so the connections probe resolves on the modal's first
  // render instead of after its own getProject round-trip.
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

  // The "Connects as" control that used to mutate `authorization_strategy`
  // from this modal is gone — see `connector-settings.tsx`. Ownership is now
  // an ACCOUNT property (`owner_type`), set per connection on the Accounts tab.

  // The header carries ONE action, chosen by the account picture, never by an
  // owner mode:
  //   connect — no account yet: create the first one (shared when the caller
  //             may manage project connections, else their own) and authorize it;
  //   finish  — accounts exist but none is usable: the fix is per row, on the
  //             Accounts tab (the CTA takes you there);
  //   replace — connected with exactly one account: re-authorize / replace THAT
  //             credential. Two or more accounts have their own row menus.
  const headerCta: 'connect' | 'finish' | 'replace' | null =
    !canWrite || isChannel || isComputer || !(isManagedProvider || Boolean(connector.authSecret))
      ? null
      : !connected
        ? accounts.length === 0
          ? 'connect'
          : 'finish'
        : soleAccount
          ? 'replace'
          : null;
  const ownerForNewAccount: 'project' | 'me' = canManageConnections ? 'project' : 'me';
  const connectPending =
    connectShared.isPending ||
    connectMine.isPending ||
    createSharedAccount.isPending ||
    createOwnAccount.isPending;
  const quickConnect = () => {
    if (isManagedProvider) {
      if (ownerForNewAccount === 'project') connectShared.mutate({ label: displayName });
      else connectMine.mutate({ label: displayName });
      return;
    }
    if (ownerForNewAccount === 'project') createSharedAccount.mutate(displayName);
    else createOwnAccount.mutate(displayName);
  };
  const replaceSoleAccount = () => {
    if (!soleAccount) return;
    const owner = soleAccount.owner_type === 'project' ? 'project' : 'me';
    if (isManagedProvider) {
      // Reconciling the SAME label re-points this row, never a second account.
      if (owner === 'project') connectShared.mutate({ label: soleAccount.label });
      else connectMine.mutate({ label: soleAccount.label });
      return;
    }
    setCredentialTarget({ connectionId: soleAccount.connection_id, owner });
  };

  return (
    <>
      <ModalHeader className="flex-row items-start gap-2.5 border-b pb-4">
        <span className="p-1">
          <ConnectorAppIcon connector={connector} size="lg" />
        </span>
        <div className="min-w-0 flex-1 space-y-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <HeaderName
              projectId={projectId}
              slug={connector.slug}
              displayName={displayName}
              canWrite={canWrite}
              disabled={false}
              onChanged={onChanged}
            />
            <ConnectorStatusBadge connector={connector} />
          </div>
          {appDescription ? (
            <p className="text-muted-foreground text-sm text-pretty">{appDescription}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <ButtonGroup className="shrink-0">
            {headerCta === 'connect' ? (
              <Button
                size="sm"
                className="gap-1.5 active:scale-[0.96]"
                onClick={quickConnect}
                disabled={connectPending}
              >
                {connectPending ? (
                  <Loading className="size-4 shrink-0" />
                ) : (
                  <PlusIcon className="size-4 shrink-0" weight="bold" />
                )}
                {isManagedProvider
                  ? tI18nComplete.raw('text1a2303ede074')
                  : tI18nComplete.raw('text2dcccf29ebf4')}
              </Button>
            ) : null}
            {headerCta === 'finish' ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 active:scale-[0.96]"
                onClick={() => setSelectedTab('accounts')}
              >
                <KeyIcon className="size-4 shrink-0" />
                {isManagedProvider
                  ? tI18nComplete.raw('text1a2303ede074')
                  : tI18nComplete.raw('text3d6627454174')}
              </Button>
            ) : null}
            {headerCta === 'replace' ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 active:scale-[0.96]"
                onClick={replaceSoleAccount}
                disabled={connectPending}
              >
                {isManagedProvider ? (
                  connectPending ? (
                    <Loading className="size-4 shrink-0" />
                  ) : null
                ) : (
                  <KeyIcon className="size-4 shrink-0" />
                )}
                {isManagedProvider
                  ? tI18nComplete.raw('textbf8a9eab9e7e')
                  : tI18nComplete.raw('text54483ce856e0')}
              </Button>
            ) : null}
          </ButtonGroup>
          <ModalClose asChild>
            <Button
              variant="secondary"
              size="icon"
              className="size-8 shrink-0 rounded-md"
              aria-label={tI18nComplete.raw('text7d9eb7acb13e')}
            >
              <Close className="text-foreground size-4 stroke-1" />
            </Button>
          </ModalClose>
        </div>
      </ModalHeader>

      <ModalBody className="flex max-h-[70vh] flex-col overflow-hidden p-0">
        {/* Not connected is the one state a person opening this modal must not
            miss — an agent granted this connector cannot use it until someone
            acts (Marko, 2026-09-03: "if it isn't connected we should make it
            very clear"). The header's status chip says it; this says what to do. */}
        {!connected && !isChannel && !isComputer && connectionsQuery.isSuccess ? (
          <InfoBanner
            tone="warning"
            title={tI18nComplete('text6506d9ea4341', { value0: displayName })}
            className="shrink-0 rounded-none border-x-0 border-t-0"
            action={
              headerCta === 'connect' ? (
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={quickConnect}
                  disabled={connectPending}
                >
                  {connectPending ? <Loading className="size-4 shrink-0" /> : null}
                  {isManagedProvider
                    ? tI18nComplete.raw('textf5e732583fb2')
                    : tI18nComplete.raw('text2dcccf29ebf4')}
                </Button>
              ) : headerCta === 'finish' ? (
                <Button size="sm" variant="outline" onClick={() => setSelectedTab('accounts')}>
                  {isManagedProvider
                    ? tI18nComplete.raw('text1a2303ede074')
                    : tI18nComplete.raw('text3d6627454174')}
                </Button>
              ) : undefined
            }
          >
            {canWrite
              ? tI18nComplete.raw('text929505ef815a')
              : tI18nComplete.raw('text6a05ddf8cca1')}
          </InfoBanner>
        ) : null}
        <Tabs
          value={tab}
          onValueChange={(next) => setSelectedTab(next as ConnectorTab)}
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto lg:flex-row lg:overflow-hidden"
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
            {tabs.map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="w-fit flex-none gap-2 px-3 py-2.5 active:scale-[0.98] lg:w-full"
              >
                {CONNECTOR_TAB_LABEL[value]}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="bg-popover min-w-0 flex-1 overflow-hidden overflow-y-auto px-5 py-4 lg:px-6">
            <TabsContent value="accounts">
              {connectionsQuery.isError ? (
                <ErrorState
                  size="sm"
                  title={tI18nComplete.raw('textbda9de7688c0')}
                  description={
                    connectionsQuery.error instanceof Error
                      ? connectionsQuery.error.message
                      : tI18nComplete.raw('textd8eda34a089a')
                  }
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void connectionsQuery.refetch()}
                    >
                      {tI18nComplete.raw('text942087cc2d41')}
                    </Button>
                  }
                />
              ) : (
                <ConnectorAccounts
                  projectId={projectId}
                  connector={connector}
                  displayName={displayName}
                  canWrite={canWrite}
                  canManageConnections={canManageConnections}
                  onChanged={onChanged}
                  onRemoved={onRemoved}
                  onStartSession={startPrivateSession}
                />
              )}
            </TabsContent>

            <TabsContent value="tools">
              <ConnectorTools
                projectId={projectId}
                connector={connector}
                displayName={displayName}
                canWrite={canWrite}
                disabled={false}
                onChanged={onChanged}
              />
            </TabsContent>

            <TabsContent value="settings">
              <ConnectorSettings
                projectId={projectId}
                connector={connector}
                displayName={displayName}
                onChanged={onChanged}
                onRemoved={onRemoved}
              />
            </TabsContent>
          </div>
        </Tabs>
      </ModalBody>

      <SetCredentialModal
        projectId={projectId}
        connector={credentialTarget ? connector : null}
        connectionId={credentialTarget?.connectionId ?? null}
        owner={credentialTarget?.owner ?? 'me'}
        open={credentialTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCredentialTarget(null);
        }}
        onSaved={() => {
          setCredentialTarget(null);
          refreshAccounts();
        }}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);

  useEffect(() => {
    setEditing(false);
    setDraft(displayName);
  }, [displayName]);

  const rename = useMutation({
    mutationFn: () => setConnectorName(projectId, slug, draft.trim()),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text05487af3f074'));
      setEditing(false);
      onChanged();
    },
    onError: (e: Error) => errorToast(e.message || tI18nComplete.raw('text8fcf8ce07dcf')),
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
            className="text-foreground h-[28px] max-w-xs border-none p-0 text-base font-semibold ring-0"
            autoFocus
            variant="transparent"
            disabled={disabled}
          />
          <Button
            type="submit"
            size="icon-xs"
            variant="ghost"
            disabled={rename.isPending || disabled}
            aria-label={tI18nComplete.raw('textb7297226fd1f')}
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
            <Close className="size-4 shrink-0" />
          </Button>
        </form>
      </>
    );
  }

  return (
    <div className="group flex items-center gap-2">
      <ModalTitle className="truncate text-lg font-semibold">{displayName}</ModalTitle>
      {canWrite ? (
        <button
          type="button"
          onClick={() => !disabled && setEditing(true)}
          disabled={disabled}
          aria-label={tI18nComplete.raw('text3064d79a295c')}
          className="text-muted-foreground hover:text-foreground"
        >
          <PencilSimpleIcon className="size-3.5 shrink-0" />
        </button>
      ) : null}
    </div>
  );
}

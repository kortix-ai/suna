'use client';

import { useTranslations } from '@/i18n/use-translations';
import { type AdminConnector, getProjectDetail, listPipedreamApps } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { KeyIcon, PlusIcon } from '@phosphor-icons/react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { ErrorState } from '@/features/layout/section/error-state';
import { ComputerConnectModal } from '@/features/tunnel/computer-connect';
import { SetCredentialModal } from '@/features/workspace/customize/sections/connectors-view';

import {
  ConnectorAppIcon,
  ConnectorStatusBadge,
} from '@/features/workspace/capabilities/connectors/connector-identity';
import { cn } from '@/lib/utils';

import { ButtonGroup } from '@/components/ui/button-group';
import { Close } from '@/features/icon/icons/close';
import { foldKey } from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import { ConnectorAccounts } from './connector-accounts';
import { ConnectorSettings } from './connector-settings';
import { CONNECTOR_TAB_LABEL_KEY, type ConnectorTab, connectorTabs } from './connector-tabs';
import { ConnectorTools } from './connector-tools';
import { ConnectorTriggers, useConnectorEventTriggers } from './connector-triggers';
import { useConnectorDetail } from './use-connector-detail';

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
 * Left: Accounts / Tools / Triggers / Settings nav.
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
  const {
    displayName,
    isManagedProvider,
    isChannel,
    isComputer,
    connectionsQuery,
    connected,
    canManageConnections,
    headerCta,
    connectPending,
    refreshAccounts,
    replaceSoleAccount,
    startPrivateSession,
    credentialTarget,
    setCredentialTarget,
    computerOpen,
    setComputerOpen,
  } = useConnectorDetail({ projectId, connector, canWrite, onChanged });
  const tSharing = useTranslations('accessSharing');
  // Opens the account list's "Add account" dialog: name and who may use it.
  const [addRequest, setAddRequest] = useState(0);
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = projectDetailQuery.data?.project?.name ?? '';
  const everyoneLabel = projectName
    ? tSharing('everyone', { project: projectName })
    : tSharing('visibilityEveryone');
  const isPipedream = connector.provider === 'pipedream';

  const eventTriggers = useConnectorEventTriggers(projectId, connector);
  const tabs = connectorTabs(connector, { canWrite, hasEvents: eventTriggers.hasEvents });
  const [selectedTab, setSelectedTab] = useState<ConnectorTab>('accounts');
  const tab = tabs.includes(selectedTab) ? selectedTab : (tabs[0] ?? 'accounts');

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

  const addAccountMenu = isComputer ? (
    <Button size="sm" className="gap-1.5" onClick={() => setComputerOpen(true)}>
      <PlusIcon className="size-4 shrink-0" weight="bold" />
      {tI18nComplete.raw('text1a2303ede074')}
    </Button>
  ) : (
    <Button
      size="sm"
      className="gap-1.5"
      onClick={() => {
        setSelectedTab('accounts');
        setAddRequest((n) => n + 1);
      }}
      disabled={connectPending}
    >
      <PlusIcon className="size-4 shrink-0" weight="bold" />
      {tSharing('addAccount')}
    </Button>
  );

  return (
    <>
      <ModalHeader className="flex-row items-start gap-2.5 border-b pb-4">
        <span className="p-1">
          <ConnectorAppIcon connector={connector} size="lg" />
        </span>
        <div className="min-w-0 flex-1 space-y-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ModalTitle className="truncate text-lg font-semibold">{displayName}</ModalTitle>
            <ConnectorStatusBadge connector={connector} />
          </div>
          {appDescription ? (
            <p className="text-muted-foreground text-sm text-pretty">{appDescription}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <ButtonGroup className="shrink-0">
            {headerCta === 'connect' ? addAccountMenu : null}
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
                addAccountMenu
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
                {tI18nComplete.raw(CONNECTOR_TAB_LABEL_KEY[value])}
                {value === 'triggers' ? (
                  <Badge variant="secondary" size="sm">
                    {eventTriggers.rows.length}
                  </Badge>
                ) : null}
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
                  addRequest={addRequest}
                  onAddRequestHandled={() => setAddRequest(0)}
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

            <TabsContent value="triggers">
              <ConnectorTriggers
                projectId={projectId}
                connector={connector}
                displayName={displayName}
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
      {isComputer ? (
        <ComputerConnectModal
          projectId={projectId}
          open={computerOpen}
          onOpenChange={setComputerOpen}
          onConnected={refreshAccounts}
        />
      ) : null}
    </>
  );
}

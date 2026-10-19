'use client';
import { invalidateConnections } from '../invalidate-connections';
import { connectorConnectionQueryKeys } from '@/features/workspace/customize/sections/connector-connection-form';
import {
  ConnectorNoticeRow,
  NOTICE_BODY,
  NOTICE_TITLE,
  NoticeLogLine,
} from './connector-notice-view';
import { DetailPageShell, DETAIL_PAGE_COLUMN as PAGE_COLUMN } from './detail-page-shell';

import { getProjectDetail, listConnectors, syncConnectors, type AdminConnector } from '@kortix/sdk';
import { contract, FRESHNESS, qk, useProjectAccountId } from '@kortix/sdk/react';
import { CaretLeftIcon, PlugIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { SplitSheet, SplitSheetMain } from '@/components/ui/split-sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { ComputerConnectModal } from '@/features/tunnel/computer-connect';
import { ConnectorAppIcon } from '@/features/workspace/capabilities/connectors/connector-identity';
import {
  appHref,
  appRefFromLocation,
  connectorsHref,
} from '@/features/workspace/capabilities/connectors/connector-routes';
import { startDiscoveredSignIn } from '@/features/workspace/customize/sections/connector-oauth2-start';
import { SetCredentialModal } from '@/features/workspace/customize/sections/connectors-view';
import { useOauth2Return } from '@/hooks/connectors/use-oauth2-return';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { isManagedConnectorProvider } from '../provider-label';
import { ConnectorDetailTabs } from './connector-detail-tabs';
import { connectorNotice, noticeButton, noticeTarget } from './connector-notice';
import { connectHandoff, connectorPageState } from './connector-page-state';
import { connectorRunsOver, connectorStatusTone } from './connector-status';
import { CONNECTOR_TAB_LABEL_KEY, connectorTabs, type ConnectorTab } from './connector-tabs';
import { useConnectorEventTriggers } from './connector-triggers';
import { ProviderInfo, providerName } from './provider-info';
import { ConnectorStatusBadge } from './status-badge';
import { useConnectorDetail } from './use-connector-detail';

/** The column `CapabilityPageShell` gives the list page beside this one. */

/**
 * `/projects/<id>/customize/connectors/<app>/<connector>` — one connector, as
 * a page: its accounts, its tools, its settings.
 *
 * `appSegment` is navigation context only. It decides where Back goes: the
 * app's page, or the Connected tab when the connector was reached without an
 * app (`connected`).
 */
export function ConnectorPage({
  projectId,
  appSegment,
  connectorSlug,
}: {
  projectId: string;
  appSegment: string;
  connectorSlug: string;
}) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const search = useSearchParams();
  const queryClient = useQueryClient();
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract(FRESHNESS.connectors),
  });
  const connector =
    connectorsQuery.data?.connectors.find((candidate) => candidate.slug === connectorSlug) ?? null;

  const invalidate = useCallback(() => {
    void invalidateConnections(queryClient, projectId);
  }, [projectId, queryClient]);
  // After a remove, the deleted slug's own queries (its config) stay out of
  // the refetch: they would 404 and toast "connector not found".
  const invalidateAfterRemove = useCallback(() => {
    const removed = qk.project.connectorConfig(projectId, connectorSlug);
    for (const key of connectorConnectionQueryKeys(projectId)) {
      void queryClient.invalidateQueries({
        queryKey: key,
        predicate: (query) => !removed.every((part, index) => query.queryKey[index] === part),
      });
    }
  }, [connectorSlug, projectId, queryClient]);
  useOauth2Return(invalidate);

  const app = appRefFromLocation(appSegment, search);
  const backHref = app ? appHref(projectId, app) : connectorsHref(projectId, 'connected');

  const state = connectorPageState({
    found: connector !== null,
    isPending: connectorsQuery.isPending,
    isFetching: connectorsQuery.isFetching,
    isError: connectorsQuery.isError,
  });

  if (state === 'loading') {
    return (
      <DetailPageShell busy>
        <Skeleton className="h-4 w-24 rounded-sm py-0" />
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 py-0" />
          <Skeleton className="h-6 w-48 rounded-sm py-0" />
        </div>
        <Skeleton className="h-8 w-64 py-0" />
        <Skeleton className="h-20 w-full py-0" />
        <Skeleton className="h-20 w-full py-0" />
      </DetailPageShell>
    );
  }

  if (state === 'error') {
    return (
      <DetailPageShell>
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('textbda9de7688c0')}
          description={
            connectorsQuery.error instanceof Error
              ? connectorsQuery.error.message
              : tI18nComplete.raw('textd8eda34a089a')
          }
          action={
            <Button variant="outline" size="sm" onClick={() => void connectorsQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      </DetailPageShell>
    );
  }

  if (!connector) {
    return (
      <DetailPageShell>
        <EmptyState
          icon={PlugIcon}
          size="sm"
          title={t('notFoundTitle')}
          description={t('notFoundDescription')}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href={connectorsHref(projectId, 'connected')}>{t('backToConnectors')}</Link>
            </Button>
          }
        />
      </DetailPageShell>
    );
  }

  return (
    <ConnectorPageBody
      key={connector.slug}
      projectId={projectId}
      connector={connector}
      canWrite={canWrite}
      backHref={backHref}
      onChanged={invalidate}
      onRemoved={invalidateAfterRemove}
    />
  );
}

function ConnectorPageBody({
  projectId,
  connector,
  canWrite,
  backHref,
  onChanged,
  onRemoved,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  backHref: string;
  onChanged: () => void;
  /** The connector was deleted: refresh everything but its own queries. */
  onRemoved: () => void;
}) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tSharing = useTranslations('accessSharing');
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const {
    displayName,
    isManagedProvider,
    isChannel,
    isComputer,
    connectionsQuery,
    accounts,
    connected,
    canManageConnections,
    headerCta,
    connectPending,
    refreshAccounts,
    startPrivateSession,
    reconnectAccount,
    credentialTarget,
    setCredentialTarget,
    computerOpen,
    setComputerOpen,
  } = useConnectorDetail({ projectId, connector, canWrite, onChanged });

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(search?.toString() ?? '');
      mutate(params);
      const suffix = params.toString();
      router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  // The tab is in the URL, so a link opens the right one.
  const eventTriggers = useConnectorEventTriggers(projectId, connector);
  const tabs = connectorTabs(connector, { canWrite, hasEvents: eventTriggers.hasEvents });
  const requestedTab = search?.get('tab');
  const tab = tabs.find((value) => value === requestedTab) ?? tabs[0] ?? 'accounts';
  const setTab = (next: ConnectorTab) =>
    replaceParams((params) => {
      if (next === 'accounts') params.delete('tab');
      else params.set('tab', next);
    });

  // The install hand-off: `?connect=<connection id>` opens credential entry
  // for that account once, then leaves the URL. The id is untrusted, so
  // `connectHandoff` opens only one of THIS connector's accounts and takes the
  // owner from the row; the URL's `owner` param is stripped, never read.
  const connectId = search?.get('connect') ?? null;
  // Same cache entry as the probe in `useConnectorDetail`; read here for its
  // loading state, so a shared account is not refused before the answer lands.
  const accountId = useProjectAccountId(projectId);
  const manageProbeLoading = useProjectCan(
    projectId,
    PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
    { accountId },
  ).isLoading;
  // The id whose account list has been refetched. Set when that refetch ends.
  const [refetchedFor, setRefetchedFor] = useState<string | null>(null);
  // The id a refetch was started for, so it starts once.
  const refetchStartedFor = useRef<string | null>(null);
  const handoff = connectHandoff({
    connectId,
    accounts,
    settled: !connectionsQuery.isFetching && !manageProbeLoading,
    refetched: refetchedFor === connectId,
    canManageConnections,
    direct: !isManagedProvider && !isComputer && !isChannel,
  });
  const handoffAction = handoff.action;
  const handoffConnectionId = handoff.action === 'open' ? handoff.connectionId : null;
  const handoffOwner = handoff.action === 'open' ? handoff.owner : null;
  const refetchConnections = connectionsQuery.refetch;
  useEffect(() => {
    if (handoffAction === 'none' || handoffAction === 'wait') return;
    if (handoffAction === 'refetch') {
      if (refetchStartedFor.current === connectId) return;
      refetchStartedFor.current = connectId;
      void refetchConnections().finally(() => setRefetchedFor(connectId));
      return;
    }
    if (handoffConnectionId && handoffOwner) {
      setCredentialTarget({ connectionId: handoffConnectionId, owner: handoffOwner });
    }
    replaceParams((params) => {
      params.delete('connect');
      params.delete('owner');
    });
  }, [
    connectId,
    handoffAction,
    handoffConnectionId,
    handoffOwner,
    refetchConnections,
    replaceParams,
    setCredentialTarget,
  ]);

  // `SplitSheet` returns focus only to its own trigger, and this sheet opens
  // from state. When it closes with focus left on nothing, put it on the
  // heading so a keyboard user keeps their place. Never on first mount.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sheetOpen = credentialTarget !== null;
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    if (sheetWasOpen.current && !sheetOpen && document.activeElement === document.body) {
      headingRef.current?.focus();
    }
    sheetWasOpen.current = sheetOpen;
  }, [sheetOpen]);

  // Opens the account list's "Add account" dialog: name and who may use it.
  const [addRequest, setAddRequest] = useState(0);
  const requestAdd = () => {
    setTab('accounts');
    setAddRequest((n) => n + 1);
  };
  // Right after Install (`?add=1`): ask for the first account once, then
  // leave the URL. Adjusted during render, not in an effect.
  const addParam = search?.get('add') === '1';
  const [addHandled, setAddHandled] = useState(false);
  if (addParam && !addHandled && canWrite && !isChannel) {
    setAddHandled(true);
    setAddRequest((n) => n + 1);
  }
  useEffect(() => {
    if (addParam && addHandled) replaceParams((params) => params.delete('add'));
  }, [addParam, addHandled, replaceParams]);
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });
  const projectName = projectDetailQuery.data?.project?.name ?? '';
  const everyoneLabel = projectName
    ? tSharing('everyone', { project: projectName })
    : tSharing('visibilityEveryone');

  // One banner says what is wrong and carries the button that fixes it.
  const notice = connectorNotice({
    provider: connector.provider,
    status: connector.status,
    lastError: connector.lastError,
    connected,
    hasAuth: isManagedProvider || Boolean(connector.authSecret),
    credentialSet: connector.secretSet,
    managed: isManagedProvider,
    accountCount: accounts.length,
    accountsLoaded: connectionsQuery.isSuccess,
  });
  // Re-read the connector's tools. The list refetch that follows shows the
  // new status, or the same error with its reason.
  const retry = useMutation({
    mutationFn: () => syncConnectors(projectId),
    onError: (error: Error) => errorToast(error.message),
    onSettled: onChanged,
  });
  // Finish an MCP account's OAuth sign-in: the same start Install runs. A
  // server without one-click OAuth opens credential entry instead.
  const signIn = useMutation({
    mutationFn: async (account: { connection_id: string; owner_type: string }) => {
      const url = await startDiscoveredSignIn(
        projectId,
        account.connection_id,
        window.location.href,
      );
      if (url) window.location.assign(url);
      else
        setCredentialTarget({
          connectionId: account.connection_id,
          owner: account.owner_type === 'project' ? 'project' : 'me',
        });
    },
    onError: (error: Error) => errorToast(error.message),
  });
  // The banner's button fixes one of the caller's own accounts. With none it
  // opens "Add account" ("Only you" preselected), never the project's shared
  // account: a shared account is signed in from its own row.
  const fix = noticeButton(notice, noticeTarget(accounts), isManagedProvider);
  const runFix = () => {
    if (fix?.run === 'add') requestAdd();
    else if (fix?.run === 'sign_in' && fix.account) signIn.mutate(fix.account);
    else if (fix?.account) reconnectAccount(fix.account);
  };
  // Connect on an account row: the same sign-in the notice runs. A managed
  // account reconnects through its provider window.
  const needsSignIn = isManagedProvider || Boolean(connector.authSecret);
  const connectAccount = (account: (typeof accounts)[number]) =>
    isManagedProvider ? reconnectAccount(account) : signIn.mutate(account);

  const tone = connectorStatusTone(connector);
  const providerManagedBy = isManagedConnectorProvider(connector.provider)
    ? connectorRunsOver(connector.provider)
    : null;
  const stripCells: Array<{
    key: string;
    label: string;
    labelAddon?: ReactNode;
    value: ReactNode;
  }> = [
    {
      key: 'status',
      label: t('stripStatus'),
      value: <ConnectorStatusBadge tone={tone} />,
    },
    {
      key: 'provider',
      // Who holds the login and who runs the actions; the info button explains it.
      label: t('infoRunsThrough'),
      labelAddon: <ProviderInfo appName={displayName} managedBy={providerManagedBy} />,
      value: providerName(displayName, providerManagedBy),
    },
    ...(isManagedConnectorProvider(connector.provider)
      ? []
      : [{ key: 'runs', label: t('infoRunsOver'), value: connectorRunsOver(connector.provider) }]),
  ];
  // The Accounts tab's own query; a channel has none, and the cell waits for it.
  if (!isChannel && connectionsQuery.isSuccess)
    stripCells.push({ key: 'accounts', label: t('stripAccounts'), value: String(accounts.length) });
  stripCells.push({
    key: 'tools',
    label: t('stripTools'),
    value: String(connector.actions.length),
  });

  const closeCredential = (open: boolean) => {
    if (!open) setCredentialTarget(null);
  };

  const addAccountControl = isComputer ? (
    <Button size="sm" className="gap-1.5" onClick={() => setComputerOpen(true)}>
      <PlusIcon className="size-4 shrink-0" />
      {tI18nComplete.raw('text1a2303ede074')}
    </Button>
  ) : (
    <Button size="sm" className="gap-1.5" onClick={requestAdd} disabled={connectPending}>
      <PlusIcon className="size-4 shrink-0" />
      {tSharing('addAccount')}
    </Button>
  );

  return (
    <SplitSheet open={sheetOpen} onOpenChange={closeCredential} size="lg" className="flex-1">
      <SplitSheetMain>
        <div className={PAGE_COLUMN}>
          <Button asChild variant="text" size="sm" className="-ml-1 w-fit px-0 has-[>svg]:px-0">
            <Link href={backHref}>
              <CaretLeftIcon className="size-3.5 shrink-0" />
              {tI18nComplete.raw('textc3d2e79ebdd0')}
            </Link>
          </Button>

          <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <ConnectorAppIcon connector={connector} size="lg" />
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-foreground min-w-0 text-xl font-medium text-balance wrap-break-word"
              >
                {displayName}
              </h1>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {/* A computer is paired, not installed: it has no notice, so its
                  connect control stays in the header. */}
              {isComputer && headerCta === 'connect' ? addAccountControl : null}
              {connected ? (
                <Button size="sm" variant="outline" onClick={() => startPrivateSession()}>
                  {t('newSession')}
                </Button>
              ) : null}
            </div>
          </header>

          {/* The strip and its notice are one card: the notice is the strip's
              bottom row, not a second panel below it. */}
          <div className="bg-popover divide-border divide-y overflow-hidden rounded-md border">
            <dl className="divide-border flex divide-x">
              {stripCells.map((cell) => (
                <div key={cell.key} className="min-w-0 flex-1 space-y-0.5 px-4 py-2.5">
                  <dt className="text-muted-foreground flex h-4 items-center justify-between gap-2 text-xs">
                    <span className="truncate">{cell.label}</span>
                    {cell.labelAddon}
                  </dt>
                  <dd className="text-foreground flex min-w-0 items-center gap-1.5 truncate text-sm font-medium">
                    {cell.value}
                  </dd>
                </div>
              ))}
            </dl>

            {notice.kind !== 'none' ? (
              <ConnectorNoticeRow
                title={t(NOTICE_TITLE[notice.kind], { name: displayName })}
                detail={
                  notice.kind === 'error' && notice.reason ? (
                    <NoticeLogLine reason={notice.reason} />
                  ) : (
                    <p className="text-muted-foreground text-xs text-pretty">
                      {t(
                        notice.kind === 'needs_credential' && isManagedProvider
                          ? 'noticeReconnectBody'
                          : NOTICE_BODY[notice.kind],
                        { name: displayName },
                      )}
                    </p>
                  )
                }
              >
                {notice.kind === 'error' && canWrite ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5"
                    onClick={() => retry.mutate()}
                    disabled={retry.isPending}
                  >
                    {retry.isPending ? <Loading className="size-4 shrink-0" /> : null}
                    {tI18nComplete.raw('text942087cc2d41')}
                  </Button>
                ) : null}
                {fix?.kind === 'add_account' ? (
                  addAccountControl
                ) : fix?.kind === 'sign_in' ? (
                  <Button
                    size="sm"
                    className="gap-1.5"
                    onClick={runFix}
                    disabled={signIn.isPending}
                  >
                    {signIn.isPending ? <SessionDotMatrix size={14} className="shrink-0" /> : null}
                    {t('noticeSignInAction')}
                  </Button>
                ) : fix ? (
                  // Fix it here: credential entry for a direct account, the
                  // provider window for a managed one, or "Add account" for
                  // a caller with no account of their own.
                  <Button size="sm" className="gap-1.5" onClick={runFix} disabled={connectPending}>
                    {connectPending ? <Loading className="size-4 shrink-0" /> : null}
                    {fix.kind === 'connect'
                      ? t('connectAccount')
                      : fix.kind === 'reconnect'
                        ? tI18nComplete.raw('textbf8a9eab9e7e')
                        : tI18nComplete.raw('text3d6627454174')}
                  </Button>
                ) : null}
              </ConnectorNoticeRow>
            ) : null}
          </div>

          <Tabs
            value={tab}
            onValueChange={(next) => setTab(next as ConnectorTab)}
            className="gap-6"
          >
            <TabsList aria-label={t('sections', { name: displayName })}>
              {tabs.map((value) => (
                <TabsTrigger key={value} value={value} className="w-fit flex-none">
                  {tI18nComplete.raw(CONNECTOR_TAB_LABEL_KEY[value])}
                  {value === 'triggers' ? (
                    <Badge variant="secondary" size="sm">
                      {eventTriggers.rows.length}
                    </Badge>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>

            <ConnectorDetailTabs
              connectionsQuery={connectionsQuery}
              accounts={{
                projectId,
                connector,
                displayName,
                canWrite,
                canManageConnections,
                onChanged,
                onStartSession: startPrivateSession,
                addRequest,
                onAddRequestHandled: () => setAddRequest(0),
                onRemoved: () => router.push(connectorsHref(projectId, 'connected')),
                onSetCredential: setCredentialTarget,
                onConnect: needsSignIn ? connectAccount : undefined,
                showAccountInfo: true,
              }}
              settings={{
                projectId: projectId,
                connector: connector,
                displayName: displayName,
                onChanged: onChanged,
                onRemoved: () => {
                  router.push(connectorsHref(projectId, 'connected'));
                  onRemoved();
                },
              }}
            />
          </Tabs>
        </div>
      </SplitSheetMain>

      {credentialTarget ? (
        // Keyed: the sheet is non-modal, so the target can change under a typed secret.
        <SetCredentialModal
          key={credentialTarget.connectionId}
          shell="split"
          projectId={projectId}
          connector={connector}
          connectionId={credentialTarget.connectionId}
          owner={credentialTarget.owner}
          open
          onOpenChange={closeCredential}
          onSaved={() => {
            setCredentialTarget(null);
            refreshAccounts();
          }}
        />
      ) : null}

      {isComputer ? (
        <ComputerConnectModal
          projectId={projectId}
          open={computerOpen}
          onOpenChange={setComputerOpen}
          onConnected={refreshAccounts}
        />
      ) : null}
    </SplitSheet>
  );
}

/**
 * The strip's bottom row when something is wrong: a one-line title, the raw
 * failure as a quiet log line, and the buttons that fix it. No icon tile; the
 * Status badge above already carries the color.
 */

'use client';

import {
  getConnectorConfig,
  listConnections,
  listConnectors,
  type AdminConnector,
  type Connection,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { KeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { SplitSheet, SplitSheetMain } from '@/components/ui/split-sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { connectorConnectionQueryKeys } from '@/features/workspace/customize/sections/connector-connection-form';
import { usePipedreamConnect } from '@/hooks/connectors/use-pipedream-connect-app';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { connectorDisplayName } from '../connector-filter';
import { ConnectorAppIcon, ConnectorStatusBadge } from '../connector-identity';
import { connectorErrorExplanation } from '../connector-status-line';
import { composioConnectionIsAuthorized, isManagedConnectorProvider } from '../provider-label';
import { connectorConnectionIsReady } from './connector-detail-copy';
import {
  ConnectorDetailLayout,
  ConnectorDetailSkeleton,
  ConnectorDocumentationLinks,
} from './connector-detail-layout';
import { connectorDocLinks } from './connector-doc-links';
import { ConnectorSetupSteps } from './connector-setup-steps';
import { CONNECTOR_TAB_LABEL, connectorTabs, type ConnectorTab } from './connector-tabs';

import type { ConnectorOverviewState } from './connector-overview';

const ConnectorOverview = dynamic(
  () => import('./connector-overview').then((module) => module.ConnectorOverview),
  { loading: () => <ConnectorSectionFallback /> },
);
const ConnectorAccounts = dynamic(
  () => import('./connector-accounts').then((module) => module.ConnectorAccounts),
  { loading: () => <ConnectorSectionFallback /> },
);
const ConnectorTools = dynamic(
  () => import('./connector-tools').then((module) => module.ConnectorTools),
  { loading: () => <ConnectorSectionFallback /> },
);
const ConnectorSettings = dynamic(
  () => import('./connector-settings').then((module) => module.ConnectorSettings),
  { loading: () => <ConnectorSectionFallback /> },
);
const SetCredentialModal = dynamic(
  () =>
    import('@/features/workspace/customize/sections/connectors-view').then(
      (module) => module.SetCredentialModal,
    ),
  { ssr: false },
);

function ConnectorSectionFallback() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-16 rounded-md" />
      <Skeleton className="h-16 rounded-md" />
    </div>
  );
}

function ConnectedConnectorSkeleton() {
  return <ConnectorDetailSkeleton />;
}

export function ConnectedConnectorPage({
  projectId,
  slug,
  backHref,
  hideBackButton = false,
  hideDocumentation = false,
  connectCoversPage = false,
  closeAction,
}: {
  projectId: string;
  slug: string;
  /** Where Go back and post-remove navigation land. Defaults to the
   *  Connected list; the app-split view passes its app page instead. */
  backHref?: string;
  /** The split view's right pane: the column IS the exit, so no Go back. */
  hideBackButton?: boolean;
  /** Also the right pane: the app page beside it already carries the same
   *  documentation links, so the pane skips its copy. */
  hideDocumentation?: boolean;
  /** Also the right pane: Connect COVERS this page instead of opening a
   *  second column inside it — the row already holds the app page, and
   *  three surfaces on one row read as overcrowded (Jay, 2026-09-15).
   *  Closing the form uncovers the connector page. */
  connectCoversPage?: boolean;
  /** The split view's X, rendered at this page's own top right — hidden
   *  while the credential column is open so its header X stays the only
   *  close on screen. */
  closeAction?: ReactNode;
}) {
  const resolvedBackHref =
    backHref ?? `/projects/${encodeURIComponent(projectId)}/connectors?scope=connected`;
  const layoutBackHref = hideBackButton ? null : resolvedBackHref;
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const search = useSearchParams();
  const queryClient = useQueryClient();

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
    // LIVE while the viewed connector is mid-setup. Connect finishes on the
    // server (credential lands, then the tools sync runs and flips
    // `needs_auth`/0 tools → `active` + actions) with no client signal, so
    // the page sat on its cache and the ready-state UI only appeared after
    // a full reload (Jay, 2026-09-17). Poll every 4s until the connector
    // settles; a settled row answers `false` and the polling stops. Errors
    // poll too — the sync retries server-side and the page should heal
    // itself. Paused automatically while the tab is unfocused.
    refetchInterval: (query) => {
      const row = query.state.data?.connectors.find((item) => item.slug === slug);
      if (!row || row.provider === 'channel' || row.provider === 'computer') return false;
      const settling =
        row.status === 'needs_auth' || row.status === 'error' || row.actions.length === 0;
      return settling ? 4_000 : false;
    },
  });
  const connector = connectorsQuery.data?.connectors.find((item) => item.slug === slug) ?? null;

  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  const canManageConnections =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId })
      .allowed === true;

  const authorizationQueryKeys = useMemo(
    () => connectorConnectionQueryKeys(projectId),
    [projectId],
  );
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
    if (connector) {
      void queryClient.invalidateQueries({
        queryKey: qk.project.connectorConfig(projectId, connector.slug),
      });
    }
    for (const key of authorizationQueryKeys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [authorizationQueryKeys, connector, projectId, queryClient]);

  const oauth2Result = search?.get('oauth2');
  const oauth2Error = search?.get('oauth2_error');
  useEffect(() => {
    if (oauth2Result !== 'connected' && oauth2Result !== 'error') return;
    if (oauth2Result === 'connected') successToast(tI18nComplete.raw('text75586c42e862'));
    else errorToast(oauth2Error || tI18nComplete.raw('texta6fac795d6d6'));
    invalidate();
    const params = new URLSearchParams(search?.toString() ?? '');
    params.delete('oauth2');
    params.delete('oauth2_error');
    const suffix = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      suffix ? `${pathname}?${suffix}` : pathname,
    );
  }, [invalidate, oauth2Error, oauth2Result, pathname, search, tI18nComplete]);

  if (connectorsQuery.isLoading) return <ConnectedConnectorSkeleton />;

  if (connectorsQuery.isError) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-12">
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('text8626b5d27992')}
          description={
            connectorsQuery.error instanceof Error
              ? connectorsQuery.error.message
              : tI18nComplete.raw('text9720ba5a9ede')
          }
          action={
            <Button variant="outline" size="sm" onClick={() => void connectorsQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      </div>
    );
  }

  if (!connector) {
    // Absent from a list that is still (re)fetching is not "gone". The add
    // flows invalidate `qk.project.connectors` and push here in the same
    // tick, so the warm cache predates the new slug — `isLoading` is false,
    // the record is missing, and this branch used to flash a full-page
    // "Connector not found" on EVERY successful add until the refetch
    // landed. Hold the skeleton while a fetch is in flight; only a settled
    // list may declare the connector missing.
    if (connectorsQuery.isFetching) {
      return <ConnectedConnectorSkeleton />;
    }
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-12">
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('text1d35d664a8ba')}
          description={tI18nComplete('textf91b7814f64d', { value0: slug })}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={resolvedBackHref}>{tI18nComplete.raw('textf09704dad946')}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <ConnectedConnectorContent
      backHref={resolvedBackHref}
      layoutBackHref={layoutBackHref}
      hideDocumentation={hideDocumentation}
      connectCoversPage={connectCoversPage}
      projectId={projectId}
      connector={connector}
      canWrite={canWrite}
      canManageConnections={canManageConnections}
      invalidate={invalidate}
      autoConnectRequested={search?.get('connect') === '1'}
      closeAction={closeAction}
    />
  );
}

function ConnectedConnectorContent({
  backHref,
  layoutBackHref,
  hideDocumentation = false,
  connectCoversPage = false,
  projectId,
  connector,
  canWrite,
  canManageConnections,
  invalidate,
  autoConnectRequested = false,
  closeAction,
}: {
  backHref: string;
  layoutBackHref: string | null;
  hideDocumentation?: boolean;
  /** See the page-level prop: Connect covers this pane instead of splitting it. */
  connectCoversPage?: boolean;
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  canManageConnections: boolean;
  invalidate: () => void;
  /** `?connect=1` — an add flow just landed here; open the connect dialog if
   *  a credential is still needed so adding flows straight into connecting. */
  autoConnectRequested?: boolean;
  /** The split view's X — see the page-level prop of the same name. */
  closeAction?: ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const queryClient = useQueryClient();
  const displayName = connectorDisplayName(connector);
  const isManagedProvider = isManagedConnectorProvider(connector.provider);
  const isChannel = connector.provider === 'channel';
  const isComputer = connector.provider === 'computer';
  const usesProjectAuthorization = connector.authorizationStrategy === 'project';
  const [credOpen, setCredOpen] = useState(false);

  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
    enabled: !isChannel && !isComputer,
  });
  const projectConnection = connectionsQuery.data?.connections.find(
    (connection) =>
      connection.connector_alias === connector.slug &&
      connection.owner_type === 'project' &&
      connection.is_default,
  );
  const myPrivateConnection = connectionsQuery.data?.connections.find(
    (connection) =>
      connection.connector_alias === connector.slug && connection.owner_type === 'member',
  );
  const selectedConnection = usesProjectAuthorization ? projectConnection : myPrivateConnection;
  const hasStrategyConnection =
    connector.provider === 'composio'
      ? composioConnectionIsAuthorized(selectedConnection?.metadata)
      : Boolean(selectedConnection);
  const connected = connectorConnectionIsReady(connector, hasStrategyConnection);

  // The `?connect=1` handoff from an add flow. Fires once, then strips the
  // param so refresh and back do not re-open the dialog. Only for connectors
  // whose credential is entered HERE: managed providers authorize during the
  // add flow, channels connect through their platform install, and computer
  // profiles have no credential dialog at all.
  const [autoConnectConsumed, setAutoConnectConsumed] = useState(false);
  useEffect(() => {
    if (!autoConnectRequested || autoConnectConsumed) return;
    setAutoConnectConsumed(true);
    const params = new URLSearchParams(window.location.search);
    params.delete('connect');
    const suffix = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      suffix ? `${window.location.pathname}?${suffix}` : window.location.pathname,
    );
    if (canWrite && !connected && !isManagedProvider && !isChannel && !isComputer) {
      setCredOpen(true);
    }
  }, [
    autoConnectConsumed,
    autoConnectRequested,
    canWrite,
    connected,
    isChannel,
    isComputer,
    isManagedProvider,
    usesProjectAuthorization,
  ]);

  const configQuery = useQuery({
    queryKey: qk.project.connectorConfig(projectId, connector.slug),
    queryFn: () => getConnectorConfig(projectId, connector.slug),
    enabled: canWrite,
    ...contract('config'),
  });

  const reconnect = usePipedreamConnect(projectId, connector.slug, invalidate);
  const newSession = useNewProjectSession(projectId);
  /**
   * Start a new private session. Given an account, bind THIS connector to it
   * (`inherit_unbound` keeps the project default for every other connector) —
   * main's per-account ownership model; there is no session-level connector
   * requirement any more. A prompt, when given, is sent as the first turn.
   */
  const startPrivateSession = (prompt?: string, connection?: Connection) => {
    newSession({
      create: {
        ...(connection
          ? {
              connector_bindings: { [connector.slug]: { connection_id: connection.connection_id } },
              inherit_unbound: true,
            }
          : {}),
        ...(prompt ? { pending_prompt: { text: prompt } } : {}),
      },
    });
  };

  const tabs = connectorTabs(connector, { canWrite });
  // `null` = "the first tab" (Overview) until the user picks one.
  const [selectedTab, setSelectedTab] = useState<ConnectorTab | null>(null);
  const tab = selectedTab && tabs.includes(selectedTab) ? selectedTab : (tabs[0] ?? 'accounts');

  // NEVER gated on a declared `authSecret` (Jay, 2026-09-17): an MCP
  // connector whose auth auto-detect saw nothing still lands here needing a
  // credential, and the old gate left the panel saying "connection
  // required" with NO button — a hard dead end. The Connect dialog owns
  // discovering what the server actually wants (one-click OAuth via the
  // discovery probe, or a pasted credential), so it is always reachable
  // while a project-scoped connector is not connected.
  //
  // And never member-scope-blind either (same day, same report): a
  // NON-MANAGED member-scoped connector's dialog writes the member's OWN
  // credential (`authorizationStrategy: 'user'`), and the Accounts tab
  // deliberately carries no second credential button — so without this CTA
  // that connector had no way to connect anywhere on the page. Managed
  // member-scope stays with the Accounts tab, whose ConnectionsList runs
  // the real per-member OAuth flows.
  const connectsHere = usesProjectAuthorization || !isManagedProvider;
  const showConnectCta = canWrite && !connected && !isChannel && !isComputer && connectsHere;
  const showReconnectCta = canWrite && connected && !isChannel && !isComputer && connectsHere;

  const primaryAction = showConnectCta ? (
    <Button
      className="gap-1.5 max-sm:w-full"
      onClick={() => (isManagedProvider ? reconnect.mutate() : setCredOpen(true))}
      disabled={reconnect.isPending}
    >
      {reconnect.isPending ? (
        <Loading className="size-4 shrink-0" />
      ) : (
        <PlusIcon className="size-4 shrink-0" />
      )}
      {/* One verb for one job. This button used to say "Add credential" for
          every non-managed connector — the same words as the dialog it opens
          and the setup step that names it, so nothing distinguished the paths
          (Marko: "every button had the same name"). The button connects; the
          dialog it opens does the naming of HOW (one-click OAuth, or the
          specific credential the server wants). */}
      {tI18nComplete.raw('text1a2303ede074')}
    </Button>
  ) : showReconnectCta ? (
    <Button
      variant="outline"
      className="gap-1.5 max-sm:w-full"
      onClick={() => (isManagedProvider ? reconnect.mutate() : setCredOpen(true))}
      disabled={reconnect.isPending}
    >
      {reconnect.isPending ? (
        <Loading className="size-4 shrink-0" />
      ) : isManagedProvider ? null : (
        <KeyIcon className="size-4 shrink-0" />
      )}
      {isManagedProvider ? 'Reconnect' : tI18nComplete.raw('text54483ce856e0')}
    </Button>
  ) : undefined;

  // A failing connector's panel owns the FAILURE — the badge said ERROR while
  // the panel talked about member connections, two contradictory messages on
  // one screen (Jay, 2026-09-14). `lastError` is the sync engine's stored
  // reason. Everything lives in ONE card: the translated reason, the next
  // step, and the raw reported text — a mono line floating under the card
  // read as page debris.
  const failing = connector.status === 'error';
  // The fix action: project-scoped credential/managed connectors already get
  // the Connect / Replace-credential button beside this text. A user-scoped
  // connector has no shared credential to fix — its fix is each member's own
  // account, one tab below — so the text carries the pointer instead.
  const failingNextStep =
    failing && !showConnectCta && !showReconnectCta && !usesProjectAuthorization
      ? ' Connect your own account under Accounts, below.'
      : '';
  const primaryTitle = failing
    ? 'Not working'
    : connected
      ? 'Connection active'
      : usesProjectAuthorization
        ? 'Project connection required'
        : 'Member connection required';
  const primaryDescription = failing ? (
    <>
      <span className="block">
        {(connectorErrorExplanation(connector.lastError) ?? tI18nComplete.raw('texte72d6e4b58ed')) +
          failingNextStep}
      </span>
      {connector.lastError ? (
        <span className="mt-1.5 block font-mono text-xs break-words">{connector.lastError}</span>
      ) : null}
    </>
  ) : connected ? (
    usesProjectAuthorization ? (
      'Sessions in this project use the shared connected account.'
    ) : (
      'Your private sessions use your connected account.'
    )
  ) : usesProjectAuthorization ? (
    'Connect one account or credential that every authorized project session can use.'
  ) : isManagedProvider ? (
    'Each member connects a separate account from the Accounts tab.'
  ) : (
    // The Connect button sits right beside this text — see `connectsHere`.
    'Connect your own account — each member brings their own.'
  );

  // Curated: the Kortix guide anchored to this provider's section, the app's
  // own developer docs when we know them (that is where the API key or server
  // URL comes from), plus whatever URL the connector config itself carries.
  const docsLinks = [
    ...connectorDocLinks(connector, tI18nComplete),
    ...(configQuery.data?.url?.startsWith('http')
      ? [
          {
            label: tI18nComplete.raw('text6f520bd876d2'),
            href: configQuery.data.url,
            external: true,
          },
        ]
      : []),
  ];
  // Removal AWAITS the connectors refetch, then navigates — soft, no page
  // reload. The await matters when the deleted connector's slug equals its
  // app's slug ("canva"): landing on `/connectors/canva` with the stale
  // cache made the resolver find the just-deleted record and forward
  // straight back to a dead page — "Connector not found" (Jay, 2026-09-14).
  // The `isFetching` skeleton guard covers this page during the await.
  const returnToConnected = async () => {
    invalidate();
    await queryClient.refetchQueries({ queryKey: qk.project.connectors(projectId) });
    router.replace(backHref);
  };

  return (
    /* The Connect dialog is a SPLIT column of this page, not an overlay: the
       connection panel, stepper, and accounts stay readable beside the form
       while the user fills it. As the right pane of the app-split view
       (`connectCoversPage`) it COVERS the page instead — the app page is
       already the other column, and a nested second column made three. */
    <SplitSheet
      open={credOpen}
      onOpenChange={setCredOpen}
      size="lg"
      cover={connectCoversPage}
      className="min-h-0 flex-1"
    >
      <SplitSheetMain className="flex flex-col">
        <ConnectorDetailLayout
          backHref={layoutBackHref}
          closeAction={credOpen ? null : closeAction}
          // `lg` (size-10) — the SAME tile the catalogue app page renders, so
          // the split view's two headers mirror each other. Renaming moved to
          // the Settings tab; the header is identity only.
          icon={<ConnectorAppIcon connector={connector} size="lg" />}
          title={displayName}
          // ONE header row, badge only — no tool count, no provider label
          // (Jay, 2026-09-14): the header is identity + state, the details
          // live in the tabs.
          status={
            connected ? (
              <Badge variant="success" size="sm">
                {tI18nComplete.raw('text22965568d22a')}
              </Badge>
            ) : (
              <ConnectorStatusBadge connector={connector} />
            )
          }
          headerAction={
            // The page-level verb: a session that starts with THIS connector
            // required, so what was just added is usable in one click. Only a
            // CONNECTED connector gets it — a session requiring a connector
            // that cannot run would open straight onto a failure.
            // The one page verb, in the same slot in every state (R5): start
            // a session once connected, Connect (or Reconnect) before that.
            // The page verb, ALWAYS in this slot (Jay, 2026-09-26: "show the
            // connect button always"): New session once connected, Connect
            // (or Reconnect) before that — on every tab, Overview included.
            connected ? (
              <Button size="sm" onClick={() => startPrivateSession()}>
                {tI18nComplete.raw('textcffdba22adf2')}
              </Button>
            ) : (
              primaryAction
            )
          }
          // Connected and healthy: no panel (Jay's R5 pick, 2026-09-26) —
          // the badge says Connected and Overview carries the facts. The
          // panel stays while there is something to DO: connect, or fix.
          // Only a FAILURE gets a panel — it has a reason to explain. Every
          // other state reads the same: header verb, tabs, Overview first
          // (Jay, 2026-09-26: old connectors must look like the new build).
          primaryTitle={failing ? primaryTitle : undefined}
          primaryDescription={primaryDescription}
          primaryAction={connected ? primaryAction : undefined}
        >
          <ConnectorManagementTabs
            projectId={projectId}
            connector={connector}
            displayName={displayName}
            tabs={tabs}
            selectedTab={tab}
            canWrite={canWrite}
            canManageConnections={canManageConnections}
            connectionsError={connectionsQuery.isError ? connectionsQuery.error : null}
            onRetryConnections={() => void connectionsQuery.refetch()}
            onTabChange={setSelectedTab}
            onChanged={invalidate}
            onRemoved={returnToConnected}
            onStartSession={(connection) => startPrivateSession(undefined, connection)}
            onTryPrompt={startPrivateSession}
            overviewState={connected ? 'connected' : failing ? 'failing' : 'setup'}
            setupSteps={
              <ConnectorSetupSteps
                connector={connector}
                displayName={displayName}
                usesProjectAuthorization={usesProjectAuthorization}
                isManagedProvider={isManagedProvider}
                hasStrategyConnection={hasStrategyConnection}
                helpLink={docsLinks[0]}
              />
            }
          />

          {hideDocumentation ? null : <ConnectorDocumentationLinks links={docsLinks} />}
        </ConnectorDetailLayout>
      </SplitSheetMain>

      {/* Conditional mount is safe here — one panel, one submit, no chained
          internal step to lose — and it keeps the connectors-view chunk off
          this route until Connect is actually pressed. */}
      {credOpen ? (
        <SetCredentialModal
          shell="split"
          projectId={projectId}
          connector={connector}
          connectionId={
            usesProjectAuthorization
              ? (projectConnection?.connection_id ?? null)
              : (myPrivateConnection?.connection_id ?? null)
          }
          owner={usesProjectAuthorization ? 'project' : 'me'}
          open
          onOpenChange={setCredOpen}
          onSaved={invalidate}
        />
      ) : null}
    </SplitSheet>
  );
}

function ConnectorManagementTabs({
  projectId,
  connector,
  displayName,
  tabs,
  selectedTab,
  canWrite,
  canManageConnections,
  connectionsError,
  onRetryConnections,
  onTabChange,
  onChanged,
  onRemoved,
  onStartSession,
  onTryPrompt,
  overviewState,
  setupSteps,
}: {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  tabs: readonly ConnectorTab[];
  selectedTab: ConnectorTab;
  canWrite: boolean;
  canManageConnections: boolean;
  connectionsError: unknown;
  onRetryConnections: () => void;
  onTabChange: (tab: ConnectorTab) => void;
  onChanged: () => void;
  onRemoved: () => void;
  onStartSession: (connection: Connection) => void;
  onTryPrompt: (prompt: string) => void;
  overviewState: ConnectorOverviewState;
  /** Rendered under Overview's facts until the connector is connected. */
  setupSteps: ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  return (
    <Tabs value={selectedTab} onValueChange={(next) => onTabChange(next as ConnectorTab)}>
      <TabsList
        type="underline"
        className="w-full justify-start overflow-x-auto"
        aria-label={`${displayName} sections`}
      >
        {tabs.map((value) => (
          <TabsTrigger key={value} value={value} className="w-fit flex-none">
            {CONNECTOR_TAB_LABEL[value]}
          </TabsTrigger>
        ))}
      </TabsList>
      <div className="pt-5">
        <TabsContent value="overview">
          <ConnectorOverview
            projectId={projectId}
            connector={connector}
            canWrite={canWrite}
            usesProjectAuthorization={connector.authorizationStrategy === 'project'}
            state={overviewState}
            setup={setupSteps}
            onTryPrompt={onTryPrompt}
          />
        </TabsContent>
        <TabsContent value="accounts">
          {connectionsError ? (
            <ErrorState
              size="sm"
              title={tI18nComplete.raw('textbda9de7688c0')}
              description={
                connectionsError instanceof Error
                  ? connectionsError.message
                  : tI18nComplete.raw('textd8eda34a089a')
              }
              action={
                <Button variant="outline" size="sm" onClick={onRetryConnections}>
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
              onStartSession={onStartSession}
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
  );
}

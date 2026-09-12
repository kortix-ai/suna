'use client';

import {
  getConnectorConfig,
  listConnections,
  listConnectors,
  setConnectorAuthorizationStrategy,
  type AdminConnector,
  type ConnectorAuthorizationStrategy,
} from '@kortix/sdk';
import { contract, qk, useProjectAccountId } from '@kortix/sdk/react';
import { KeyIcon, PlusIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { SplitSheet, SplitSheetMain } from '@/components/ui/split-sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  connectorAuthorizationUpdateIsPending,
  connectorConnectionQueryKeys,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { usePipedreamConnect } from '@/hooks/connectors/use-pipedream-connect-app';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { connectorDisplayName, connectorSummary } from '../connector-filter';
import { ConnectorAppIcon, ConnectorStatusBadge } from '../connector-identity';
import {
  composioConnectionIsAuthorized,
  isManagedConnectorProvider,
  providerLabel,
} from '../provider-label';
import { ConnectorCredentialRow } from './connector-credential-row';
import { connectorConnectionIsReady, connectorSetupSteps } from './connector-detail-copy';
import {
  ConnectorDetailLayout,
  ConnectorDetailSkeleton,
  ConnectorDocumentationLinks,
  ConnectorSetupGuide,
} from './connector-detail-layout';
import { connectorDocLinks } from './connector-doc-links';
import { ConnectorHeaderName } from './connector-header-name';
import { CONNECTOR_TAB_LABEL, connectorTabs, type ConnectorTab } from './connector-tabs';

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

function ConnectedConnectorSkeleton({ projectId }: { projectId: string }) {
  return (
    <ConnectorDetailSkeleton
      backHref={`/projects/${encodeURIComponent(projectId)}/connectors?scope=connected`}
      iconClassName="size-14"
    />
  );
}

export function ConnectedConnectorPage({ projectId, slug }: { projectId: string; slug: string }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const pathname = usePathname();
  const search = useSearchParams();
  const queryClient = useQueryClient();

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
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

  if (connectorsQuery.isLoading) return <ConnectedConnectorSkeleton projectId={projectId} />;

  if (connectorsQuery.isError) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-12">
        <ErrorState
          size="sm"
          title="Couldn’t load connector"
          description={
            connectorsQuery.error instanceof Error
              ? connectorsQuery.error.message
              : 'The project connector list could not be read.'
          }
          action={
            <Button variant="outline" size="sm" onClick={() => void connectorsQuery.refetch()}>
              Retry
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
      return <ConnectedConnectorSkeleton projectId={projectId} />;
    }
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-12">
        <ErrorState
          size="sm"
          title="Connector not found"
          description={`No connector with slug “${slug}” exists in this project.`}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${encodeURIComponent(projectId)}/connectors?scope=connected`}>
                Return to connectors
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <ConnectedConnectorContent
      projectId={projectId}
      connector={connector}
      canWrite={canWrite}
      canManageConnections={canManageConnections}
      invalidate={invalidate}
      autoConnectRequested={search?.get('connect') === '1'}
    />
  );
}

function ConnectedConnectorContent({
  projectId,
  connector,
  canWrite,
  canManageConnections,
  invalidate,
  autoConnectRequested = false,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  canManageConnections: boolean;
  invalidate: () => void;
  /** `?connect=1` — an add flow just landed here; open the connect dialog if
   *  a credential is still needed so adding flows straight into connecting. */
  autoConnectRequested?: boolean;
}) {
  const router = useRouter();
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
    if (
      canWrite &&
      !connected &&
      !isManagedProvider &&
      !isChannel &&
      !isComputer &&
      usesProjectAuthorization &&
      connector.authSecret
    ) {
      setCredOpen(true);
    }
  }, [
    autoConnectConsumed,
    autoConnectRequested,
    canWrite,
    connected,
    connector.authSecret,
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
  const startPrivateSession = () => {
    newSession({ create: { require_connectors: [connector.slug] } });
  };

  const [authorizationStrategyAwaitingRefresh, setAuthorizationStrategyAwaitingRefresh] =
    useState<ConnectorAuthorizationStrategy | null>(null);
  if (
    authorizationStrategyAwaitingRefresh !== null &&
    authorizationStrategyAwaitingRefresh === connector.authorizationStrategy
  ) {
    setAuthorizationStrategyAwaitingRefresh(null);
  }
  const updateAuthorizationStrategy = useMutation({
    mutationFn: (next: ConnectorAuthorizationStrategy) =>
      setConnectorAuthorizationStrategy(projectId, connector.slug, next),
    onSuccess: (result, next) => {
      const syncError = result.sync?.errors.find((error) => error.slug === connector.slug);
      if (syncError) {
        warningToast(
          `Authorization owner changed, but synchronization failed: ${syncError.error}. Use Sync to retry.`,
        );
      } else {
        successToast(`Authorization owner set to ${next === 'project' ? 'Project' : 'User'}`);
      }
      invalidate();
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

  const tabs = connectorTabs(connector, { canWrite });
  const [selectedTab, setSelectedTab] = useState<ConnectorTab>('accounts');
  const tab = tabs.includes(selectedTab) ? selectedTab : (tabs[0] ?? 'accounts');

  const showConnectCta =
    canWrite &&
    (isManagedProvider || Boolean(connector.authSecret)) &&
    !connected &&
    !isChannel &&
    usesProjectAuthorization;
  const showReconnectCta =
    canWrite && (isManagedProvider || Boolean(connector.authSecret)) && connected && !isChannel;

  const primaryAction = showConnectCta ? (
    <Button
      className="gap-1.5 max-sm:w-full"
      onClick={() => (isManagedProvider ? reconnect.mutate() : setCredOpen(true))}
      disabled={strategyUpdating || reconnect.isPending}
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
      Connect
    </Button>
  ) : showReconnectCta ? (
    <Button
      variant="outline"
      className="gap-1.5 max-sm:w-full"
      onClick={() => (isManagedProvider ? reconnect.mutate() : setCredOpen(true))}
      disabled={strategyUpdating || reconnect.isPending}
    >
      {reconnect.isPending ? (
        <Loading className="size-4 shrink-0" />
      ) : isManagedProvider ? null : (
        <KeyIcon className="size-4 shrink-0" />
      )}
      {isManagedProvider ? 'Reconnect' : 'Replace credential'}
    </Button>
  ) : undefined;

  const primaryTitle = connected
    ? 'Connection active'
    : usesProjectAuthorization
      ? 'Project connection required'
      : 'Member connection required';
  const primaryDescription = connected
    ? usesProjectAuthorization
      ? 'Sessions in this project use the shared connected account.'
      : 'Your private sessions use your connected account.'
    : usesProjectAuthorization
      ? 'Connect one account or credential that every authorized project session can use.'
      : 'Each member connects a separate account from the Accounts tab.';

  const setupSteps = connectorSetupSteps({
    provider: connector.provider,
    authorizationStrategy: connector.authorizationStrategy,
    connected: false,
    requestAuthType: connector.requestAuthType,
  });
  // Curated: the Kortix guide anchored to this provider's section, the app's
  // own developer docs when we know them (that is where the API key or server
  // URL comes from), plus whatever URL the connector config itself carries.
  const docsLinks = [
    ...connectorDocLinks(connector),
    ...(configQuery.data?.url?.startsWith('http')
      ? [{ label: 'Official connector URL', href: configQuery.data.url, external: true }]
      : []),
  ];
  const returnToConnected = () =>
    router.replace(`/projects/${encodeURIComponent(projectId)}/connectors?scope=connected`);

  return (
    /* The Connect dialog is a SPLIT column of this page, not an overlay: the
       connection panel, stepper, and accounts stay readable beside the form
       while the user fills it. */
    <SplitSheet open={credOpen} onOpenChange={setCredOpen} size="lg" className="min-h-0 flex-1">
      <SplitSheetMain className="flex flex-col">
        <ConnectorDetailLayout
          backHref={`/projects/${encodeURIComponent(projectId)}/connectors?scope=connected`}
          icon={<ConnectorAppIcon connector={connector} size="xl" />}
          title={
            <ConnectorHeaderName
              projectId={projectId}
              slug={connector.slug}
              displayName={displayName}
              canWrite={canWrite}
              disabled={strategyUpdating}
              onChanged={invalidate}
            />
          }
          description={connectorSummary(connector, providerLabel(connector.provider))}
          status={
            connected ? (
              <Badge variant="success" size="sm">
                Connected
              </Badge>
            ) : (
              <ConnectorStatusBadge connector={connector} />
            )
          }
          primaryTitle={primaryTitle}
          primaryDescription={primaryDescription}
          primaryAction={primaryAction}
        >
          {/* Where the credential actually lives, and the two-way door to the
          Secrets page. Directly under the primary Connection panel — before
          any tab — because "is this a pasted value or the project secret
          LINEAR_API_KEY?" is connection state, not a settings detail. Only
          connectors with a project-owned declared credential have a source to
          name. */}
          {!isManagedProvider &&
          !isChannel &&
          !isComputer &&
          usesProjectAuthorization &&
          connector.authSecret ? (
            <ConnectorCredentialRow
              projectId={projectId}
              connector={connector}
              canWrite={canWrite}
              onChanged={invalidate}
            />
          ) : null}

          {/* Always the SETUP script, never a swapped "review" variant — the
          stepper is live, so connecting is what flips the steps to green
          checks instead of replacing the text under the user. */}
          <ConnectorSetupGuide steps={setupSteps} currentStep={connected ? setupSteps.length : 0} />

          <ConnectorManagementTabs
            projectId={projectId}
            connector={connector}
            displayName={displayName}
            tabs={tabs}
            selectedTab={tab}
            canWrite={canWrite}
            canManageConnections={canManageConnections}
            strategyUpdating={strategyUpdating}
            connectionsError={connectionsQuery.isError ? connectionsQuery.error : null}
            onRetryConnections={() => void connectionsQuery.refetch()}
            onTabChange={setSelectedTab}
            onChanged={invalidate}
            onRemoved={returnToConnected}
            onStartSession={startPrivateSession}
            onSetCredential={() => setCredOpen(true)}
            onAuthorizationStrategyChange={(next) => {
              setCredOpen(false);
              setAuthorizationStrategyAwaitingRefresh(next);
              updateAuthorizationStrategy.mutate(next);
            }}
          />

    
          <ConnectorDocumentationLinks links={docsLinks} />
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
          authorizationStrategy={connector.authorizationStrategy}
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
  strategyUpdating,
  connectionsError,
  onRetryConnections,
  onTabChange,
  onChanged,
  onRemoved,
  onStartSession,
  onSetCredential,
  onAuthorizationStrategyChange,
}: {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  tabs: readonly ConnectorTab[];
  selectedTab: ConnectorTab;
  canWrite: boolean;
  canManageConnections: boolean;
  strategyUpdating: boolean;
  connectionsError: unknown;
  onRetryConnections: () => void;
  onTabChange: (tab: ConnectorTab) => void;
  onChanged: () => void;
  onRemoved: () => void;
  onStartSession: () => void;
  onSetCredential: () => void;
  onAuthorizationStrategyChange: (strategy: ConnectorAuthorizationStrategy) => void;
}) {
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
        <TabsContent value="accounts">
          {connectionsError ? (
            <ErrorState
              size="sm"
              title="Couldn’t load connections"
              description={
                connectionsError instanceof Error
                  ? connectionsError.message
                  : 'The accounts stored for this connector could not be read.'
              }
              action={
                <Button variant="outline" size="sm" onClick={onRetryConnections}>
                  Retry
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
              strategyUpdating={strategyUpdating}
              onChanged={onChanged}
              onRemoved={onRemoved}
              onStartSession={onStartSession}
              onSetCredential={onSetCredential}
            />
          )}
        </TabsContent>
        <TabsContent value="tools">
          <ConnectorTools
            projectId={projectId}
            connector={connector}
            displayName={displayName}
            canWrite={canWrite}
            disabled={strategyUpdating}
            onChanged={onChanged}
          />
        </TabsContent>
        <TabsContent value="settings">
          <ConnectorSettings
            projectId={projectId}
            connector={connector}
            displayName={displayName}
            canWrite={canWrite}
            strategyUpdating={strategyUpdating}
            onAuthorizationStrategyChange={onAuthorizationStrategyChange}
            onRemoved={onRemoved}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}

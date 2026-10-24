'use client';

import { NewEntityMenu } from '../shared/new-entity-menu';
import {
  newConfigPrompt,
  useConfigureThread,
} from '../use-configure-thread';
import { useTranslations as useI18nTranslations } from '../../i18n';
import { getProjectDetail, listConnections, listConnectors, type AdminConnector } from '@kortix/sdk';
import { contract, FRESHNESS, qk, useProjectAccountId } from '@kortix/sdk/react';
import { CaretDownIcon, MagnifyingGlassIcon, PlugIcon, PlugsConnectedIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazyClient } from '../../lib/lazy-client';
import {
  useUiPathname,
  useUiRouter,
  useUiSearchParams,
  useUiShallowNavigate,
} from '../../providers/ui-provider';
import { useDebounce } from '../../hooks/use-debounce';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../../primitives/button';
import { Switch } from '../../primitives/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { cn } from '../../lib/utils';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import Loading from '../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { Skeleton } from '../../primitives/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { EmptyState } from '../../primitives/empty-state';
import { connectorConnectionQueryKeys } from '../sections/connector-connection-form';

import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { ConnectorStatusBadge as ToneBadge } from './detail/status-badge';
import { connectorStatusTone } from './detail/connector-status';
import { connectorAccounts } from './detail/use-connector-detail';
import { connectorRuleSetUsage } from './agent-access';
import { humanizeToolName as policySetLabel } from './tools/tool-groups';
import { ConnectorLogo } from '../../internal/connector-logo/connector-logo';
import { installedConnectorLogoSource } from '../../internal/connector-logo/connector-logo-source';
import { providerLabel } from './provider-label';

import {
  catalogEntryConnectors,
  connectedCatalogKeys,
  type CatalogEntry,
} from './catalog/catalog-entry';
import { ConnectorBrowse } from './catalog/connector-browse';
import { useCatalog } from './catalog/use-catalog';
import { CapabilityPageShell } from '../shared/capability-page-shell';
import { CatalogCard } from '../shared/catalog/catalog-card';
import { catalogEmptyKind } from '../shared/catalog/catalog-empty';
import { CatalogNoMatch } from '../shared/catalog/catalog-empty-state';
import { CatalogGrid } from '../shared/catalog/catalog-grid';
import { useTunnelConnections } from '@kortix/sdk/react';
import { useSlashFocus } from '../../internal/hooks';
import {
  connectorDisplayName,
  connectorSummary,
  CONNECTOR_SCOPES,
  filterConnectors,
  parseConnectorScope,
  type ConnectorScope,
} from './connector-filter';
import { ConnectorMovesBanner } from './connector-moves-banner';
import {
  appHref,
  appRefFromEntry,
  connectorHref,
  connectorSearchFromParams,
  legacyDetailRedirect,
  waysFromParams,
  withConnectorSearch,
} from './connector-routes';
import type { McpServerApp } from './install/mcp-first';
import { useInstall } from './install/use-install';

import { InstallDialog } from './install/install-dialog';
import { wayKindLabel } from './install/way-kind';
import type { DiscoverConnectorKind } from '@kortix/sdk';

/** The catalogue's type filter: every app, or the apps that
 *  connect one way. REST covers OpenAPI documents. Kortix's own apps are on
 *  the Channels tab. */
const CATALOG_KIND_FILTERS = {
  all: [],
  mcp: ['mcp'],
  composio: ['composio'],
  openapi: ['openapi'],
  graphql: ['graphql'],
} satisfies Record<string, DiscoverConnectorKind[]>;
type CatalogKindFilter = keyof typeof CATALOG_KIND_FILTERS;

/**
 * The click-gated Add form, split out of this route's initial chunk.
 *
 * It lives in `customize/sections/connectors-view.tsx` — 5,075 lines whose own
 * import list pulls `@pipedream/sdk/browser`, `HighlightedCode` (shiki) and
 * `PoliciesPanel`. An ES module is all-or-nothing to the bundler, so one `import` line puts that
 * entire graph in front of a page that paints a grid of cards.
 * `connector-identity.tsx` was lifted out of that file for exactly this
 * reason; a static import here is the edge that puts it straight back.
 *
 * `CustomConnectorForm` is the Add modal's body. It cannot render before a
 * click, so it need not be parsed before one. `ssr: false` keeps it out of the
 * server bundle too — a closed modal has no markup worth streaming.
 */
const CustomConnectorForm = lazyClient(
  () =>
    import('../sections/connectors-view').then(
      (m) => m.CustomConnectorForm,
    ),
  { fallback: <ModalFormFallback /> },
);

/** New → MCP server. A closed dialog needs no code before the click either. */
const AddMcpServerDialog = lazyClient(() =>
  import('./add-mcp/add-mcp-server-dialog').then((m) => m.AddMcpServerDialog),
);

/** Holds the Add modal's height while its form chunk arrives. */
function ModalFormFallback() {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Loading className="size-5 shrink-0" />
    </div>
  );
}

/**
 * The Channels scope's body — Slack / Teams / email install and the
 * per-channel bindings — lifted here from its own retired top-level tab.
 *
 * `dynamic` for the same reason the form above is, and more urgently: its
 * `EmailConnectForm` import reaches `customize/sections/connectors-view.tsx`,
 * the same 5,075-line module the Add modal's form lives in. A static import
 * would put that whole graph — `@pipedream/sdk/browser`, shiki, `PoliciesPanel`
 * — in front of the catalogue grid for every visitor, including the ones who
 * never open this tab. All is the landing scope, so this is click-gated
 * in the common case; a deep link (`?scope=channels`) pays one chunk fetch and
 * gets `ChannelsFallback` while it lands.
 */
/** The Rules tab: `PoliciesPanel` and the matrix, fetched on the click. */
const RulesTab = lazyClient(() => import('./rules-tab').then((m) => m.RulesTab), {
  fallback: <ChannelsFallback />,
});

const ChannelsSection = lazyClient(
  () =>
    import('../sections/view/channels-view').then(
      (m) => m.ChannelsSection,
    ),
  { fallback: <ChannelsFallback /> },
);

/**
 * The shape `ChannelsSection` settles into: one hero card, then the channel
 * rows. Restated here rather than imported from that module, because importing
 * anything out of it would load the chunk this fallback exists to cover.
 */
function ChannelsFallback() {
  return (
    <div className="w-full max-w-3xl space-y-6">
      <Skeleton className="h-64 rounded-md" />
      <div className="space-y-2">
        <Skeleton className="h-14 rounded-md" />
        <Skeleton className="h-14 rounded-md" />
      </div>
    </div>
  );
}

/**
 * Four tabs, one job each:
 * - **Connectors** (landing): what this project has. An installed app is
 *   here and only here; its card opens its connector page.
 * - **Browse**: the catalogue, to add an app. Channels are left out of it
 *   (they have their own tab) unless a search asks for one.
 * - **Channels**: what Kortix built for people to reach the agent.
 * - **Rules**: the project rules and the connectors × agents rule sets.
 *
 * The scope lives in `?scope=`; `parseConnectorScope` maps the old `all`,
 * `connected` and `?rules=1` links.
 */
const SCOPE_LABEL_KEY = {
  connectors: 'scopeConnectors',
  browse: 'scopeBrowse',
  channels: 'scopeChannels',
  rules: 'scopeRules',
} as const satisfies Record<ConnectorScope, string>;

/**
 * Each tab's sentence, under the tab strip: Channels makes the agent
 * reachable, Rules decides what it may do; the area heading covers all four.
 */
const SCOPE_DESCRIPTION_KEY = {
  connectors: 'scopeConnectorsDescription',
  browse: 'scopeBrowseDescription',
  channels: 'scopeChannelsDescription',
  rules: 'scopeRulesDescription',
} as const satisfies Record<ConnectorScope, string>;

/** Every catalogue kind but Kortix's own: Browse leaves channels to their tab. */
const BROWSE_KINDS: DiscoverConnectorKind[] = ['mcp', 'composio', 'openapi', 'graphql'];

/** Which page-level modal is open, if any. Only one can be at a time. */
type Panel = 'custom' | 'mcp';

/**
 * /projects/[id]/connectors — the standalone Connectors catalogue.
 *
 * Reads the project's own connectors off `qk.project.connectors(projectId)`,
 * the same key `ConnectorsMasterDetail` uses, so the two surfaces cannot
 * disagree about what a project has.
 *
 * **Four tabs** — see `SCOPE_LABEL_KEY`. There is no Needs-attention tab:
 * see `connector-filter.ts` for why it became a sort key instead.
 *
 * Channels is a different kind of thing: the inbound
 * side — Slack, Microsoft Teams and email reaching the agent — which was its
 * own top-level Customize tab until it folded in here. The two REST namespaces
 * stay separate (`…/channels/*` vs `…/connectors/*`) and no data model was
 * merged; what merged is the question a person is answering, which in both
 * cases is "wire this project to something outside it". It replaces the body
 * rather than filtering it, and takes the connector search box and the
 * custom-connector Add button off the header while it is up.
 *
 * `?scope=` is the tab, so every scope is linkable — which is what lets the
 * retired `/projects/<id>/channels` route redirect to a real destination
 * instead of a page that lands on All and hides what was asked for.
 *
 * **What Add opens.** Only the custom-connector form (OpenAPI / Postman /
 * GraphQL / MCP / HTTP). Everything the Add-connector modal used to hide
 * behind a four-tab strip now lives on the page: Easy Connect and Discover as
 * catalogue cards, Channels as catalogue entries alongside them. A modal is
 * the right home for a form; it was the wrong home for a catalogue.
 *
 * A connector's detail is its own page
 * (`/customize/connectors/<app>/<connector>`), and a catalogue card links to
 * its app's page. `?c=<slug>` is the old spelling of "this connector is open";
 * `legacyDetailRedirect` forwards it, so an OAuth grant that started before
 * the change still lands on the right connector.
 */
export function ConnectorsPage({ projectId }: { projectId: string }) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  // `accountId` comes off the detail this page already loads. Without it
  // `useProjectCan` fetches the project a second time under its own key AND
  // holds the IAM probe disabled until that lands — so Add and every write
  // affordance appeared two sequential round-trips after paint.
  const accountId = useProjectAccountId(projectId);
  const configure = useConfigureThread(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  const queryClient = useQueryClient();

  const { search, router, pathname, setScope } = useConnectorNavigation(projectId);

  // The search lives in `?q=`: opening a connector unmounts this page, and
  // browser Back must bring the same results back (KRTX-3018).
  const [query, setQuery] = useState(() => connectorSearchFromParams(search));
  useSearchInUrl(query, search, pathname);
  // An agent may not add a custom server itself: the API answers
  // `custom_connector_needs_human` with a `setup_url` to this page
  // (`?custom=1&provider=mcp&url=…&name=…`), and a person confirms it here.
  const customLink = search?.get('custom') === '1';
  const customMcp =
    customLink && search?.get('provider') === 'mcp' && search.get('url')
      ? { url: search.get('url') ?? '', name: search.get('name') ?? undefined }
      : null;
  const [panel, setPanel] = useState<Panel | null>(
    customLink ? (customMcp ? 'mcp' : 'custom') : null,
  );
  // The catalogue app whose own MCP server the MCP dialog connects. Null for
  // a server the user pastes (New → MCP server).
  const [mcpApp, setMcpApp] = useState<McpServerApp | null>(null);
  // The catalogue opens on the apps that connect in one click.
  const [oneClick, setOneClick] = useState(true);
  const [kindFilter, setKindFilter] = useState<CatalogKindFilter>('all');
  const kinds = useMemo(() => CATALOG_KIND_FILTERS[kindFilter], [kindFilter]);
  const tSharing = useI18nTranslations('accessSharing');
  const tPages = useI18nTranslations('connectorPages');

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId, { includeSchemas: false }),
    ...contract(FRESHNESS.connectors),
  });
  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });

  const connectors = useMemo(() => connectorsQuery.data?.connectors ?? [], [connectorsQuery.data]);
  // Same key and fetcher as the Accounts tab's list: one cached request.
  const connectionsQuery = useQuery({
    queryKey: ['connections', projectId],
    queryFn: () => listConnections(projectId),
    staleTime: 30_000,
  });
  const accountCounts = useMemo(() => {
    const list = connectionsQuery.data?.connections;
    if (!list) return null;
    return { get: (connector: AdminConnector) => connectorAccounts(list, connector).length };
  }, [connectionsQuery.data]);
  const ruleSets = useMemo(
    () => connectorRuleSetUsage(projectQuery.data?.config?.manifest_raw),
    [projectQuery.data?.config?.manifest_raw],
  );
  const connectedKeys = useMemo(() => connectedCatalogKeys(connectors), [connectors]);

  const { installEntry, pendingKey, request: installRequest, setRequest: setInstallRequest, confirm: confirmInstall } = useInstall(projectId, {
    onMcpServer: (server) => {
      setMcpApp(server);
      setPanel('mcp');
    },
  });
  const catalogInstall = useMemo(
    () => ({
      // `connectors` is `[]` until the list loads, and an install run against
      // that creates a second connector for an app the project already has.
      ready: connectorsQuery.isSuccess,
      canWrite,
      pendingKey,
      onInstall: (entry: CatalogEntry) => installEntry(entry, connectors),
    }),
    [canWrite, connectors, connectorsQuery.isSuccess, installEntry, pendingKey],
  );

  // What the card actually shows, handed to the search so typing a word the
  // user can read on screen matches the card carrying it.
  const describeConnector = useCallback(
    (connector: AdminConnector) => connectorSummary(connector, providerLabel(connector.provider)),
    [],
  );

  const authorizationQueryKeys = useMemo(
    () => connectorConnectionQueryKeys(projectId),
    [projectId],
  );
  const invalidate = useCallback(() => {
    for (const key of authorizationQueryKeys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [authorizationQueryKeys, queryClient]);

  // Both queries gate what this page can offer, so both have to be able to
  // report a failure and both have to be retried.
  //
  // `settled` does not save us — react-query drops `isLoading` once a query
  // has exhausted its retries, so on failure the page rendered as fully loaded
  // with capabilities silently gone. Naming only `connectorsQuery` here also
  // meant the one Retry on screen refetched the query that had not failed.
  const isError = connectorsQuery.isError || projectQuery.isError;
  const retry = useCallback(() => {
    if (connectorsQuery.isError) void connectorsQuery.refetch();
    if (projectQuery.isError) void projectQuery.refetch();
  }, [connectorsQuery, projectQuery]);

  // Gates the Connected grid only. Its empty state's wording depends on
  // `projectQuery` as well as `connectorsQuery`, so it cannot say "no
  // connectors yet" until both have landed. The TAB STRIP no longer waits on
  // this: with a constant landing tab and no per-tab count, nothing in it is
  // derived from a query, so making it appear a beat late bought nothing.
  const settled = !connectorsQuery.isLoading && !projectQuery.isLoading;

  // Constant, never derived from what the project has: the page must not
  // settle onto a different tab than it first rendered.
  const scope: ConnectorScope = parseConnectorScope(search);
  const catalogActive = scope === 'browse';
  // Channels and Rules replace the connector list, so the search box and the
  // custom-connector Add come off with it.
  const listActive = scope === 'connectors' || scope === 'browse';

  // The machine list answers 503 on a deployment with computers disabled, so
  // the Computer card shows only where a computer can be connected.
  const computersEnabled = useTunnelConnections({ refetchInterval: false }).isSuccess;
  // Channels (and the computer) live on their own tab, unless a search asks
  // for one: "slack" in Browse still finds Slack.
  const browseKinds = useMemo(
    () => (kinds.length > 0 || query.trim() ? kinds : BROWSE_KINDS),
    [kinds, query],
  );
  const catalog = useCatalog(projectId, query, {
    enabled: catalogActive,
    computers: computersEnabled && query.trim().length > 0,
    oneClick,
    kinds: browseKinds,
  });

  const filtered = useMemo(
    () => filterConnectors(connectors, { query, describe: describeConnector }),
    [connectors, query, describeConnector],
  );

  const emptyKind = catalogEmptyKind(connectors.length, filtered.length);

  // A project connector's card: its state, how many accounts it has, and its
  // rule sets with the agents on each, so the list answers "does this work,
  // and who gets what" without opening every connector.
  const ownConnectorCard = (connector: (typeof connectors)[number]) => {
    const accountCount = accountCounts?.get(connector);
    const counted = connector.provider !== 'channel';
    const parts = [
      counted && accountCount !== undefined ? tPages('cardAccounts', { count: accountCount }) : null,
      describeConnector(connector),
      ...(ruleSets[connector.slug] ?? []).map((set) =>
        tPages('cardRuleSet', { name: policySetLabel(set.name), count: set.agents }),
      ),
    ].filter(Boolean);
    return (
      <CatalogCard
        key={connector.slug}
        variant="plain"
        leading={<ConnectorLogo source={installedConnectorLogoSource(connector)} size="lg" />}
        title={connectorDisplayName(connector)}
        subtitle={<span className="text-muted-foreground text-xs text-pretty">{parts.join(' · ')}</span>}
        badges={
          <ToneBadge tone={connectorStatusTone(connector, counted ? accountCount : undefined)} />
        }
        href={connectorHref(projectId, connector.slug)}
      />
    );
  };

  // Quiet on purpose: a filter, not a second tab strip.
  const catalogFilters = (
    <div className="flex items-center gap-4">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="text"
            size="sm"
            className={cn('gap-1 px-0 transition-colors', kindFilter !== 'all' && 'text-foreground')}
            aria-label={tPages('typeFilterLabel')}
          >
            {kindFilter === 'all' ? tPages('typeFilterAll') : wayKindLabel(kindFilter)}
            <CaretDownIcon className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-40"
          // A pointer pick returns no focus ring to the quiet trigger.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuRadioGroup
            value={kindFilter}
            onValueChange={(next) => setKindFilter(next as CatalogKindFilter)}
          >
            {(Object.keys(CATALOG_KIND_FILTERS) as CatalogKindFilter[]).map((value) => (
              <DropdownMenuRadioItem key={value} value={value}>
                {value === 'all' ? tPages('typeFilterAll') : wayKindLabel(value)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Switch
        label={tPages('oneClickOnly')}
        checked={oneClick}
        onCheckedChange={setOneClick}
        className="px-0 py-0"
      />
    </div>
  );

  // Stable: the browse cards are `memo`'d, and an inline arrow here would
  // re-render every one of them on each page render.
  // An app the project has one profile of opens that connector page: the app
  // page would only redirect there. `?ways=1` (Settings → Install as another
  // profile) opens the app page instead.
  const ways = waysFromParams(search);
  const catalogHref = useCallback(
    (entry: CatalogEntry) => {
      const app = appRefFromEntry(entry);
      if (ways) return appHref(projectId, app, { ways: true });
      const installed = entry.connector.kind === 'kortix' ? [] : catalogEntryConnectors(connectors, entry);
      return installed.length === 1
        ? connectorHref(projectId, installed[0]!.slug, { app })
        : appHref(projectId, app);
    },
    [connectors, projectId, ways],
  );

  // The search field is the page's main control: focused on arrival, and "/"
  // jumps back to it (`useSlashFocus`).
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef, listActive);

  return (
        <CapabilityPageShell
          title={tI18nComplete.raw('textc3d2e79ebdd0')}
          description={tPages('areaDescription')}
          search={
            !listActive ? undefined : (
              <InputGroupSearch>
                <InputGroupSearchIcon>
                  <MagnifyingGlassIcon />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  ref={searchRef}
                  placeholder={
                    catalogActive ? tI18nComplete.raw('textc386cb852691') : tPages('searchInstalled')
                  }
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  variant="popover"
                  size="sm"
                />
              </InputGroupSearch>
            )
          }
          action={
            /* The page's one header action, and it carries its label: a bare `+`
           square made the reader guess, and what it opens — a custom-connector
           form, not the catalogue — is not guessable from a glyph. Default
           size (`h-9`), so it stays the tallest thing in the header group and
           lines up with the search field beside it. `aria-label` keeps the
           full sentence for screen readers; it opens with the visible "Add",
           so the accessible name still contains the visible label. */
            canWrite && listActive ? (
              <NewEntityMenu
                label={tI18nComplete.raw('text18fdd549b2ed')}
                pending={configure.pending}
                onChat={() => configure.start(newConfigPrompt('connector'))}
                quick={{
                  icon: PlugsConnectedIcon,
                  label: tPages('addMcpMenu'),
                  description: tPages('addMcpMenuHint'),
                  onSelect: () => {
                    setMcpApp(null);
                    setPanel('mcp');
                  },
                }}
                manual={{
                  label: tI18nComplete.raw('text90ccaee30bdc'),
                  description: tI18nComplete.raw('textb0fbe9dc1fcc'),
                  onSelect: () => setPanel('custom'),
                }}
              />
            ) : undefined
          }
          filters={
            <div className="w-full space-y-2">
              <Tabs value={scope} onValueChange={(value) => setScope(value as ConnectorScope)}>
                {/* Scrolls sideways instead of clipping at the minimum window. */}
                <div className="max-w-full overflow-x-auto">
                  <TabsList>
                    {CONNECTOR_SCOPES.map((value) => (
                      <TabsTrigger key={value} value={value}>
                        {tPages(SCOPE_LABEL_KEY[value])}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              </Tabs>
              {/* The tab's own sentence sits under the tab, not in the area heading. */}
              <p className="text-muted-foreground text-xs text-pretty">
                {tPages(SCOPE_DESCRIPTION_KEY[scope])}
              </p>
            </div>
          }
        >
          {scope === 'channels' ? (
            /* The whole of what used to be `/projects/<id>/channels`, minus the
           shell it used to bring — this page's `CapabilityPageShell` is the
           one column, the one heading and the one scroll container now. */
            <ChannelsSection projectId={projectId} />
          ) : scope === 'rules' ? (
            <RulesTab projectId={projectId} />
          ) : catalogActive ? (
            <>
              {/* The catalogue's own header: its filters sit with what they filter. */}
              <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                {catalogFilters}
              </div>
              <ConnectorBrowse
                state={catalog}
                connectedKeys={connectedKeys}
                hrefFor={catalogHref}
                install={catalogInstall}
                emptyTitle={tI18nComplete.raw('text3a63271cafc1')}
                emptyDescription={tI18nComplete.raw('textf652a621153e')}
              />
            </>
          ) : (
            <>
              <ConnectorMovesBanner projectId={projectId} />
              <CatalogGrid
                dense
                // `!settled`, not `connectorsQuery.isLoading`: the empty state's
                // wording depends on `projectQuery` too.
                isLoading={!settled}
                isError={isError}
                error={connectorsQuery.error ?? projectQuery.error}
                onRetry={retry}
                isEmpty={emptyKind !== null}
                empty={
                  emptyKind === 'no-match' ? (
                    <CatalogNoMatch query={query} />
                  ) : (
                    <EmptyState
                      icon={PlugIcon}
                      size="sm"
                      title={tI18nComplete.raw('text51ae0a7e3783')}
                      description={tPages('connectorsEmptyBody')}
                      action={
                        <Button size="sm" onClick={() => setScope('browse')}>
                          {tPages('browseApps')}
                        </Button>
                      }
                    />
                  )
                }
              >
                {filtered.map(ownConnectorCard)}
              </CatalogGrid>
            </>
          )}

          <AddMcpServerDialog
            key={mcpApp?.url ?? 'paste'}
            projectId={projectId}
            app={mcpApp}
            initial={mcpApp ? null : customMcp}
            open={panel === 'mcp'}
            onOpenChange={(open) => setPanel(open ? 'mcp' : null)}
            takenSlugs={connectors.map((connector) => connector.slug)}
            onAdded={invalidate}
          />

          {installRequest ? (
            <InstallDialog
              key={installRequest.target.appName}
              appName={installRequest.target.appName}
              way={installRequest.way}
              open
              pending={false}
              onOpenChange={(open) => !open && setInstallRequest(null)}
              onConfirm={confirmInstall}
            />
          ) : null}

          {/* Custom upload only. `CustomConnectorForm` prints no heading of its
          own, so unlike the `AddAppPanel` this replaced it gets a real visible
          `ModalHeader` rather than a `VisuallyHidden` title — the dialog needs
          an accessible name and the user needs to know what the form is for.
          That is why `@radix-ui/react-visually-hidden` is no longer imported
          on this page. */}
          <Modal open={panel === 'custom'} onOpenChange={(open) => !open && setPanel(null)}>
            <ModalContent className="lg:max-w-3xl">
              <ModalHeader>
                <ModalTitle>{tI18nComplete.raw('text90ccaee30bdc')}</ModalTitle>
                <ModalDescription>{tI18nComplete.raw('textd2f3be0047c4')}</ModalDescription>
              </ModalHeader>
              <ModalBody className="max-h-[75vh] overflow-y-auto">
                <CustomConnectorForm
                  projectId={projectId}
                  onAdded={(slug, { addAccount }) => {
                    invalidate();
                    setPanel(null);
                    router.push(connectorHref(projectId, slug, { addAccount }));
                  }}
                />
              </ModalBody>
            </ModalContent>
          </Modal>
        </CapabilityPageShell>
  );
}

/**
 * Mirrors the settled search into `?q=` with a shallow replace: no history
 * entry per keystroke, and no server round trip for a view already on screen.
 */
function useSearchInUrl(
  query: string,
  search: ReturnType<typeof useUiSearchParams>,
  pathname: string,
) {
  const shallowNavigate = useUiShallowNavigate();
  const { debouncedValue } = useDebounce(query.trim(), 300);
  useEffect(() => {
    if (connectorSearchFromParams(search) === debouncedValue) return;
    const params = withConnectorSearch(new URLSearchParams(search?.toString() ?? ''), debouncedValue);
    const suffix = params.toString();
    shallowNavigate(suffix ? `${pathname}?${suffix}` : pathname, { replace: true });
  }, [debouncedValue, search, pathname, shallowNavigate]);
}

function useConnectorNavigation(projectId: string) {
  const search = useUiSearchParams();
  const router = useUiRouter();
  const pathname = useUiPathname();

  // `?c=<slug>` named the open connector before connectors had pages, and an
  // OAuth grant started then returns to that URL. Forward it, result intact.
  const legacyHref = legacyDetailRedirect(projectId, search);
  useEffect(() => {
    if (legacyHref) router.replace(legacyHref);
  }, [legacyHref, router]);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(search?.toString() ?? '');
      mutate(params);
      const suffix = params.toString();
      router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  // The tab lives in `?scope=`, so every tab is linkable: the retired
  // `/projects/<id>/channels` route redirects to `?scope=channels`. The
  // landing tab writes no param, and a switch drops the old `?rules=1`.
  const setScope = useCallback(
    (next: ConnectorScope) =>
      replaceParams((params) => {
        params.delete('rules');
        params.delete('ways');
        if (next === 'connectors') params.delete('scope');
        else params.set('scope', next);
      }),
    [replaceParams],
  );

  return { search, router, pathname, setScope };
}

'use client';

import { NewEntityMenu } from '../shared/new-entity-menu';
import {
  newConfigPrompt,
  useConfigureThread,
} from '../use-configure-thread';
import { useTranslations as useI18nTranslations } from '../../i18n';
import { getProjectDetail, listConnectors, type AdminConnector } from '@kortix/sdk';
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
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PoliciesPanel } from '../../workspace/projects/policies-panel';
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
import {
  SplitSheet,
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
} from '../../primitives/split-sheet';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { EmptyState } from '../../primitives/empty-state';
import {
  connectorConnectionQueryKeys,
  connectorSetupStatus,
} from '../sections/connector-connection-form';

import { PROJECT_ACTIONS } from '../../internal/lib/project-actions';
import { useProjectCan } from '../../internal/lib/use-project-can';
import { ConnectorConnectedMark, ConnectorStatusBadge } from './connector-identity';
import { ConnectorLogo } from '../../internal/connector-logo/connector-logo';
import { installedConnectorLogoSource } from '../../internal/connector-logo/connector-logo-source';
import { providerLabel } from './provider-label';

import {
  connectedCatalogKeys,
  type CatalogEntry,
} from './catalog/catalog-entry';
import { ConnectorBrowse } from './catalog/connector-browse';
import { useCatalog } from './catalog/use-catalog';
import { type AgentGrant, GrantModeTabs, type ResourceScope } from '../shared/agent-resource-scope';
import { RequiredConnectorToggle } from '../sections/view/agent-editor-access-fields';
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
  filterConnectors,
  type ConnectorScope,
} from './connector-filter';
import { ConnectorMovesBanner } from './connector-moves-banner';
import {
  appHref,
  appRefFromEntry,
  connectorHref,
  connectorSearchFromParams,
  legacyDetailRedirect,
  withConnectorSearch,
} from './connector-routes';
import type { McpServerApp } from './install/mcp-first';
import { useInstall } from './install/use-install';

import { InstallDialog } from './install/install-dialog';
import { wayKindLabel } from './install/way-kind';
import type { DiscoverConnectorKind } from '@kortix/sdk';

/** The catalogue's type filter: every app, or the apps that
 *  connect one way. REST covers OpenAPI documents. */
const CATALOG_KIND_FILTERS = {
  all: [],
  mcp: ['mcp'],
  composio: ['composio'],
  openapi: ['openapi'],
  graphql: ['graphql'],
  kortix: ['kortix'],
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
 * Tab order is deliberate, and so is the landing tab: All leads and is always
 * what opens, for every project. The project's own list follows — reachable
 * in one click, but never in the way of adding something.
 *
 * There is no Discovery tab. It was the same catalogue cut into category
 * sections; the flat grid plus server-side search covers the same ground
 * without a second presentation of one list. There is no Available tab either:
 * it showed the catalogue minus what the project already had.
 *
 * Channels sits LAST and outside that reasoning, because it is not a narrower
 * view of the same list — it is the other direction of the same job (who can
 * reach the agent, rather than what the agent can reach).
 */
const SCOPES: readonly ConnectorScope[] = ['all', 'connected', 'channels'];

const SCOPE_LABEL: Record<ConnectorScope, string> = {
  all: 'All',
  connected: 'Connected',
  // The tab holds everything Kortix built (Slack, Teams, Email, Telegram and
  // the computer). People call those channels; the catalog type stays "Kortix".
  channels: 'Channels',
};

/**
 * The heading follows the scope. "Give agents access to outside tools and
 * data" is false on the Channels scope — nothing under it grants an agent
 * access to anything; it makes the agent reachable. One page can hold both,
 * but not under one sentence that describes only half of it.
 */
const SCOPE_DESCRIPTION: Record<ConnectorScope, string> = {
  all: 'Give agents access to outside tools and data.',
  connected: 'Give agents access to outside tools and data.',
  channels: 'Talk to your agents from the apps your team uses, and let them work on your computer.',
};

/** `?scope=` is user-editable text; anything that is not a scope is All. */
function parseScope(value: string | null): ConnectorScope | null {
  return SCOPES.find((scope) => scope === value) ?? null;
}

/** Which page-level modal is open, if any. Only one can be at a time. */
type Panel = 'custom' | 'mcp';

/**
 * /projects/[id]/connectors — the standalone Connectors catalogue.
 *
 * Reads the project's own connectors off `qk.project.connectors(projectId)`,
 * the same key `ConnectorsMasterDetail` uses, so the two surfaces cannot
 * disagree about what a project has.
 *
 * **Three tabs.** Two are one list each: All is the catalogue, flat; Connected
 * is the project's own connectors. There is no Needs-attention tab — see
 * `connector-filter.ts` for why it became a sort key instead — and no
 * Discovery or Available tab, see `SCOPES` below.
 *
 * The third is Channels, and it is a different kind of thing: the inbound
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
export function ConnectorsPage({
  projectId,
  surface = { kind: 'global' },
  grant,
  required,
  agentPanel,
}: {
  projectId: string;
  /** `global` (default) is the project catalogue; `agent` scopes the same page
   *  to one agent and turns each connector card into a grant control. */
  surface?: ResourceScope;
  /** Required in `agent` scope: the agent's `connectors` grant, driven by the
   *  page's draft. Ignored in `global` scope. */
  grant?: AgentGrant;
  /** Agent scope only: `connectors_required`, the connectors a session needs
   *  connected before it starts. Offered on a card the agent is granted by name
   *  (Specific), because under All or None no single connector is picked. */
  required?: {
    /** The stored list, shown as one note under All (a hand-written manifest). */
    list: readonly string[];
    isRequired: (slug: string) => boolean;
    toggle: (slug: string) => void;
  };
  /** Agent scope only: agent settings that belong with its connectors (the
   *  per-connector policy sets), shown above the catalogue. */
  agentPanel?: ReactNode;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const tAgentScope = useI18nTranslations('agentScope');
  const agentScoped = surface.kind === 'agent' && grant !== undefined;
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

  const { search, router, pathname, replaceParams, setScope, rulesOpen, setRulesOpen } =
    useConnectorNavigation(projectId);

  // The search lives in `?q=`: opening a connector unmounts this page, and
  // browser Back must bring the same results back (KRTX-3018).
  const [query, setQuery] = useState(() => connectorSearchFromParams(search));
  useSearchInUrl(query, search, pathname);
  const [panel, setPanel] = useState<Panel | null>(null);
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

  // All, always — never derived from what the project already has.
  // `defaultConnectorScope` used to open a project with connectors on its own
  // list, which put the least useful tab in front of the user most often: a
  // returning user opening this page is far more likely to be adding a
  // connector than reading the ones already there, and the ones already there
  // are one click away. It also made the landing tab depend on a query, so the
  // page could settle onto a different tab than it first rendered.
  const scope: ConnectorScope = parseScope(search?.get('scope') ?? null) ?? 'all';
  const catalogActive = scope === 'all';
  // Channels replaces the connector list rather than narrowing it, so the
  // controls that only make sense over that list come off with it: the search
  // box searches the connector catalogue, and Add opens a custom-CONNECTOR
  // form. Channels has its own primary action already — the Slack hero owns
  // it — so it needs neither, and leaving them on screen would offer to search
  // a list that is not there.
  // Channels is the inbound side (who can reach the agent), not a connector
  // the agent is granted — so it is not part of the agent-scoped view.
  const channelsActive = scope === 'channels' && !agentScoped;

  // Channels is a project-wide inbound surface, so an agent's page leaves it out.
  const visibleScopes = SCOPES.filter((s) => !agentScoped || s !== 'channels');

  // The machine list answers 503 on a deployment with computers disabled, so
  // the Computer card shows only where a computer can be connected.
  const computersEnabled = useTunnelConnections({ refetchInterval: false }).isSuccess;
  const catalog = useCatalog(projectId, query, {
    enabled: catalogActive,
    computers: computersEnabled,
    oneClick,
    kinds,
  });

  const filtered = useMemo(
    () => filterConnectors(connectors, { query, describe: describeConnector }),
    [connectors, query, describeConnector],
  );

  // The All tab shows the project's own connectors too (KRTX-2531): a
  // connector added minutes ago must be findable on the default tab — and
  // searchable by its exact slug — instead of living one tab away on
  // Connected. Computers stay out: the catalogue's native Computers card
  // already carries them (and a machineless one is not in `connectors`).
  const ownMatches = useMemo(
    () => filtered.filter((connector) => connector.provider !== 'computer'),
    [filtered],
  );

  const emptyKind = catalogEmptyKind(connectors.length, filtered.length);

  // One card shape for the project's own connectors: the Connected tab's grid
  // and the All tab's "Your connectors" section (KRTX-2531) render it alike.
  const ownConnectorCard = (connector: (typeof connectors)[number]) => {
    const connected = connectorSetupStatus(connector) === 'connected';
    const shared = {
      variant: 'plain' as const,
      leading: <ConnectorLogo source={installedConnectorLogoSource(connector)} size="lg" />,
      title: connectorDisplayName(connector),
      subtitle: (
        <span className="text-muted-foreground text-xs">{describeConnector(connector)}</span>
      ),
      badges: <ConnectorStatusBadge connector={connector} />,
      trailing: connected ? <ConnectorConnectedMark /> : undefined,
    };
    // In agent scope the checkbox grants this connector to the agent; the body
    // still opens the connector's detail. In global scope the whole card
    // navigates, prefetched, as before.
    if (agentScoped && grant) {
      return (
        <CatalogCard
          key={connector.slug}
          {...shared}
          onClick={() => router.push(connectorHref(projectId, connector.slug))}
          // The checkbox exists only under Specific. Under All or None the
          // grant sentence decides every card, and a checked box nobody can
          // uncheck read as a disabled control.
          select={
            grant.mode === 'specific'
              ? {
                  checked: grant.isGranted(connector.slug),
                  onCheckedChange: () => grant.toggle(connector.slug),
                  label: tI18nComplete('textd4170e74c3b0', { value0: connectorDisplayName(connector) }),
                }
              : undefined
          }
          // The connected mark stays; Required joins it on a card picked by name.
          trailing={
            required && grant.mode === 'specific' && grant.isGranted(connector.slug) ? (
              <span className="flex items-center gap-2">
                {shared.trailing}
                <RequiredConnectorToggle
                  active={required.isRequired(connector.slug)}
                  onToggle={() => required.toggle(connector.slug)}
                />
              </span>
            ) : (
              shared.trailing
            )
          }
        />
      );
    }
    return <CatalogCard key={connector.slug} {...shared} href={connectorHref(projectId, connector.slug)} />;
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
            {kindFilter === 'all'
              ? tPages('typeFilterAll')
              : kindFilter === 'kortix'
                ? tPages('typeFilterKortix')
                : wayKindLabel(kindFilter)}
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
                {value === 'all'
                  ? tPages('typeFilterAll')
                  : value === 'kortix'
                    ? tPages('typeFilterKortix')
                    : wayKindLabel(value)}
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
  const catalogHref = useCallback(
    (entry: CatalogEntry) => appHref(projectId, appRefFromEntry(entry)),
    [projectId],
  );

  // The search field is the page's main control: focused on arrival, and "/"
  // jumps back to it (`useSlashFocus`).
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef, !channelsActive && !rulesOpen);

  // The catalogue scope strip. Rendered immediately, not behind `settled`:
  // static labels over a scope read out of the URL have nothing to wait for.
  // Project scope shows it in the filter row; agent scope shows it on the
  // heading of the list it narrows, below the grant sentence.
  const scopeTabs =
    visibleScopes.length > 1 ? (
      <Tabs value={scope} onValueChange={(value) => setScope(value as ConnectorScope)}>
        <TabsList>
          {visibleScopes.map((value) => (
            <TabsTrigger key={value} value={value}>
              {SCOPE_LABEL[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    ) : null;

  return (
    // Global rules open in a SplitSheet: the page narrows to make room instead
    // of being covered. `PoliciesPanel` is a long CRUD list whose save bar
    // sticks to the body's bottom edge, so the body is the only scroller.
    <SplitSheet open={rulesOpen} onOpenChange={setRulesOpen} size="lg" className="flex-1">
      <SplitSheetMain>
        <CapabilityPageShell
          title={tI18nComplete.raw('textc3d2e79ebdd0')}
          description={
            agentScoped ? tAgentScope('connectorsDescription') : SCOPE_DESCRIPTION[scope]
          }
          search={
            channelsActive ? undefined : (
              <InputGroupSearch>
                <InputGroupSearchIcon>
                  <MagnifyingGlassIcon />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  ref={searchRef}
                  placeholder={tI18nComplete.raw('textc386cb852691')}
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
            canWrite && !channelsActive ? (
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
            agentScoped || visibleScopes.length > 1 ? (
              <>
                {/* Agent scope's primary control: All · Specific · None for what
                this agent may reach, on its own row. The catalogue scope strip
                (All | Connected) moves down to the list it narrows, so the
                row never shows two unrelated "All" controls. */}
                {agentScoped && grant ? (
                  <GrantModeTabs grant={grant} label={tAgentScope('connectorsAccess')} />
                ) : (
                  scopeTabs
                )}
                {/* Global rules — connector approval policy, so it belongs on this
                page and not on the shared capability bar, which also rides over
                Agents, Skills and Triggers.

                Text, not a chip. This row already carries the tab strip's
                filled control; a second bordered pill opposite it would read as
                a second selector rather than a way out to a settings surface.
                `variant="text"` is the codebase's muted-text affordance
                (`text-muted-foreground` → `text-primary` on hover); `px-0` drops
                the pill padding so the label sits flush with the container's
                right edge, mirroring the tab strip flush left. It keeps the
                full `h-8` of `size="sm"` as its hit area.

                `ml-auto` rather than leaning on the shell's `justify-between`:
                when the row wraps on a narrow viewport this lands alone on the
                second line, and `justify-between` would drop it to the LEFT
                there. `ml-auto` holds it right in both layouts.

                Not gated on `canWrite` — anyone who can open the page can read
                the project's approval policy. */}
                <Button
                  type="button"
                  variant="text"
                  size="sm"
                  onClick={() => setRulesOpen(true)}
                  className="ml-auto px-0 transition-colors"
                >
                  {tI18nComplete.raw('text1d59a5e09714')}
                </Button>
              </>
            ) : undefined
          }
        >
          {agentScoped && agentPanel ? <div className="mb-8">{agentPanel}</div> : null}
          {channelsActive ? (
            /* The whole of what used to be `/projects/<id>/channels`, minus the
           shell it used to bring — this page's `CapabilityPageShell` is the
           one column, the one heading and the one scroll container now. */
            <ChannelsSection projectId={projectId} />
          ) : catalogActive ? (
            <>
              {ownMatches.length > 0 ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <h2 className="text-sm font-medium">{tPages('yourConnectors')}</h2>
                    {agentScoped ? scopeTabs : null}
                  </div>
                  {/* Rendered only once the page has settled (ownMatches is
                  non-empty), so the grid needs no loading/error/empty state:
                  the page-level ones cover it. */}
                  <CatalogGrid
                    dense
                    isLoading={false}
                    isError={false}
                    onRetry={retry}
                    isEmpty={false}
                    empty={null}
                  >
                    {ownMatches.map(ownConnectorCard)}
                  </CatalogGrid>
                </div>
              ) : null}
              {/* The catalogue's own header: its filters sit with what they
                  filter, under the project's own connectors. */}
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h2 className="text-sm font-medium">{tPages('allApps')}</h2>
                <div className="flex flex-wrap items-center gap-4">
                  {catalogFilters}
                  {agentScoped && ownMatches.length === 0 ? scopeTabs : null}
                </div>
              </div>
              <ConnectorBrowse
                state={catalog}
                connectedKeys={connectedKeys}
                hrefFor={catalogHref}
                install={catalogInstall}
                emptyTitle={tI18nComplete.raw('text3a63271cafc1')}
                emptyDescription={tI18nComplete.raw('textf652a621153e')}
                // A slug search that only the project's own connector answers
                // must not ALSO read "No matches" under its card (KRTX-2531).
                suppressNoMatch={ownMatches.length > 0}
              />
            </>
          ) : (
            <>
              <ConnectorMovesBanner projectId={projectId} />
              {agentScoped ? (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <h2 className="text-sm font-medium">{tPages('yourConnectors')}</h2>
                  {scopeTabs}
                </div>
              ) : null}
              {/* A manifest can hold `connectors: all` beside a hand-written
                  required list. No card is picked under All to carry the
                  toggle, so the list is one muted line here instead. */}
              {agentScoped && grant?.mode === 'all' && required && required.list.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {tAgentScope('requiredUnderAll', { list: required.list.join(', ') })}
                </p>
              ) : null}
              <CatalogGrid
                dense
                // `!settled`, not `connectorsQuery.isLoading`: the empty state's
                // wording depends on `projectQuery` too. Same gate as the filter row.
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
                      description={tI18nComplete.raw('texta3487dfc2132')}
                      action={
                        <Button size="sm" variant="secondary" onClick={() => setScope('all')}>
                          {tI18nComplete.raw('text45bfe4f17af7')}
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
      </SplitSheetMain>
      <SplitSheetContent>
        <SplitSheetHeader>
          <SplitSheetTitle>{tI18nComplete.raw('text1d59a5e09714')}</SplitSheetTitle>
          <SplitSheetDescription>{tI18nComplete.raw('text014d10bd3c64')}</SplitSheetDescription>
        </SplitSheetHeader>
        <SplitSheetBody>
          <PoliciesPanel projectId={projectId} />
        </SplitSheetBody>
      </SplitSheetContent>
    </SplitSheet>
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

  // Which scope the strip is on, held in the URL rather than in state.
  //
  // It has to be addressable: `/projects/<id>/channels` was a real route until
  // Channels folded into this page, and every bookmark and every legacy nav id
  // pointing at it now redirects to `?scope=channels`. A tab that only local
  // state can reach is a tab nothing can link to.
  //
  // All is the landing scope and writes NO param — see the `SCOPES`
  // block for why it is constant rather than derived. Omitting it keeps the
  // bare URL bare, so the common case still shares as `…/connectors`.
  const setScope = useCallback(
    (next: ConnectorScope) =>
      replaceParams((params) =>
        next === 'all' ? params.delete('scope') : params.set('scope', next),
      ),
    [replaceParams],
  );

  // Global rules — project-wide connector approval policy. Held in `?rules=1`
  // rather than component state: this is the one deep-linkable surface on the
  // page (`proj-connectors-policies` in `menu-registry.ts` navigates straight
  // to it).
  const rulesOpen = search?.get('rules') === '1';
  const setRulesOpen = useCallback(
    (open: boolean) =>
      replaceParams((params) => (open ? params.set('rules', '1') : params.delete('rules'))),
    [replaceParams],
  );

  return { search, router, pathname, replaceParams, setScope, rulesOpen, setRulesOpen };
}

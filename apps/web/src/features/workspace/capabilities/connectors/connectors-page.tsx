'use client';

import { getProjectDetail, listConnectors, type AdminConnector } from '@kortix/sdk';
import { contract, qk, useFeatureFlag, useProjectAccountId } from '@kortix/sdk/react';
import { MagnifyingGlassIcon, PlugIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  connectorConnectionQueryKeys,
  connectorSetupStatus,
} from '@/features/workspace/customize/sections/connector-connection-form';

import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  ConnectorAppIcon,
  ConnectorConnectedMark,
  ConnectorStatusBadge,
} from './connector-identity';
import { providerLabel } from './provider-label';

import {
  connectedCatalogKeys,
  type CatalogEntry,
} from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import { ConnectorBrowse } from '@/features/workspace/capabilities/connectors/catalog/connector-browse';
import { ALL_CATEGORIES } from '@/features/workspace/capabilities/connectors/catalog/connector-categories';
import {
  useCatalog,
  useConnectProviderStatus,
} from '@/features/workspace/capabilities/connectors/catalog/use-catalog';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { catalogEmptyKind } from '@/features/workspace/capabilities/shared/catalog/catalog-empty';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import { CatalogGrid } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import {
  connectorDisplayName,
  connectorSummary,
  filterConnectors,
  type ConnectorScope,
} from './connector-filter';
import { catalogConnectorHref, connectedConnectorHref } from './connector-routes';

/**
 * The custom-connector form is split out of this route's initial chunk.
 *
 * Both reach `customize/sections/connectors-view.tsx` — 5,075 lines whose own
 * import list pulls `@pipedream/sdk/browser`, `HighlightedCode` (shiki),
 * `PoliciesPanel`, `DiscoverCatalogue` and `ConnectorConnectionModal`. An ES
 * module is all-or-nothing to the bundler, so two `import` lines put that
 * entire graph in front of a page that paints a grid of cards.
 * `connector-identity.tsx` was lifted out of that file for exactly this
 * reason; these were the two edges that put it straight back.
 *
 * `CustomConnectorForm` is the Add modal's body.
 *
 * Neither can render before a click, so neither needs to be parsed before
 * one. `ssr: false` keeps them out of the server bundle too — a closed modal
 * has no markup worth streaming.
 */
const CustomConnectorForm = dynamic(
  () =>
    import('@/features/workspace/customize/sections/connectors-view').then(
      (m) => m.CustomConnectorForm,
    ),
  { ssr: false, loading: () => <ModalFormFallback /> },
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
 * `dynamic` for the same reason the two above are, and more urgently: its
 * `EmailConnectForm` import reaches `customize/sections/connectors-view.tsx`,
 * the same 5,075-line module the Add modal's form lives in. A static import
 * would put that whole graph — `@pipedream/sdk/browser`, shiki, `PoliciesPanel`
 * — in front of the catalogue grid for every visitor, including the ones who
 * never open this tab. Discovery is the landing scope, so this is click-gated
 * in the common case; a deep link (`?scope=channels`) pays one chunk fetch and
 * gets `ChannelsFallback` while it lands.
 */
const ChannelsSection = dynamic(
  () =>
    import('@/features/workspace/customize/sections/view/channels-view').then(
      (m) => m.ChannelsSection,
    ),
  { ssr: false, loading: () => <ChannelsFallback /> },
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
 * Tab order is deliberate, and so is the landing tab: Discovery leads and is
 * always what opens, for every project. The project's own list sits last —
 * reachable in one click, but never in the way of adding something.
 *
 * There is no Available tab. It showed the catalogue minus what the project
 * already had, which is the same catalogue with a handful of cards deleted
 * from it — and the cards it deleted were exactly the ones already marked `✓`
 * on the other two tabs. Removing a card the user can already see is connected
 * is not a filter worth a tab; it just made "where did Slack go?" a question
 * the page could provoke.
 *
 * Channels sits LAST and outside that reasoning, because it is not a narrower
 * view of the same list — it is the other direction of the same job (who can
 * reach the agent, rather than what the agent can reach). Last is where a
 * reader stops expecting the strip to keep filtering one thing.
 *
 * Discovery and All are dropped entirely on a deployment with no catalogue —
 * see `catalogueAvailable`. They are two views of ONE catalogue, and without
 * `connectors_api_discover` that catalogue is Pipedream's, which answers `501`
 * on every request unless three env vars are set. They are removed rather
 * than disabled: a disabled tab still asserts that the feature exists and is
 * merely out of reach for now, which is not what "this deployment does not
 * have Pipedream" means. Connected and Channels stay either way — every
 * deployment has its own connectors and its own inbound channels, catalogue
 * or not.
 */
const SCOPES: readonly ConnectorScope[] = ['discover', 'all', 'connected', 'channels'];

const SCOPE_LABEL: Record<ConnectorScope, string> = {
  discover: 'Discovery',
  all: 'All',
  connected: 'Connected',
  channels: 'Channels',
};

/**
 * The heading follows the scope. "Give agents access to outside tools and
 * data" is false on the Channels scope — nothing under it grants an agent
 * access to anything; it makes the agent reachable. One page can hold both,
 * but not under one sentence that describes only half of it.
 */
const SCOPE_DESCRIPTION: Record<ConnectorScope, string> = {
  discover: 'Give agents access to outside tools and data.',
  all: 'Give agents access to outside tools and data.',
  connected: 'Give agents access to outside tools and data.',
  channels: 'Reach your agent from the tools your team already uses.',
};

/** `?scope=` is user-editable text; anything that is not a scope is Discovery. */
function parseScope(value: string | null): ConnectorScope | null {
  return SCOPES.find((scope) => scope === value) ?? null;
}

/** Which page-level modal is open, if any. Only one can be at a time. */
type Panel = 'custom';

/**
 * /projects/[id]/connectors — the standalone Connectors catalogue.
 *
 * Reads the project's own connectors off `qk.project.connectors(projectId)`,
 * the same key `ConnectorsMasterDetail` uses, so the two surfaces cannot
 * disagree about what a project has.
 *
 * **Four tabs.** Three are one list each: Discovery is the catalogue in
 * category sections, each expandable in place; All is the same catalogue flat;
 * Connected is the project's own connectors. There is no Needs-attention tab —
 * see `connector-filter.ts` for why it became a sort key instead — and no
 * Available tab, see `SCOPES` below.
 *
 * The fourth is Channels, and it is a different kind of thing: the inbound
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
 * instead of a page that lands on Discovery and hides what was asked for.
 *
 * **What Add opens.** Only the custom-connector form (OpenAPI / Postman /
 * GraphQL / MCP / HTTP). Everything the Add-connector modal used to hide
 * behind a four-tab strip now lives on the page: Easy Connect and Discover as
 * catalogue cards, Channels as catalogue entries alongside them. A modal is
 * the right home for a form; it was the wrong home for a catalogue.
 *
 * Connector cards open dedicated routes. Each route owns its OAuth return,
 * account management, tools, settings, documentation, and technical details.
 */
export function ConnectorsPage({ projectId }: { projectId: string }) {
  // `accountId` comes off the detail this page already loads. Without it
  // `useProjectCan` fetches the project a second time under its own key AND
  // holds the IAM probe disabled until that lands — so Add and every write
  // affordance appeared two sequential round-trips after paint.
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [panel, setPanel] = useState<Panel | null>(null);

  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

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
  // Discovery is the landing scope and writes NO param — see the `SCOPES`
  // block for why it is constant rather than derived. Omitting it keeps the
  // bare URL bare, so the common case still shares as `…/connectors`.
  const setScope = useCallback(
    (next: ConnectorScope) =>
      replaceParams((params) =>
        next === 'discover' ? params.delete('scope') : params.set('scope', next),
      ),
    [replaceParams],
  );

  // Global rules — project-wide connector approval policy. Held in `?rules=1`
  // rather than component state for the same reason `?c=` is: this is the one
  // deep-linkable surface on the page (`proj-connectors-policies` in
  // `menu-registry.ts` navigates straight to it), and a URL survives the full
  // page load an OAuth return puts the user through.
  const rulesOpen = search?.get('rules') === '1';
  const setRulesOpen = useCallback(
    (open: boolean) =>
      replaceParams((params) => (open ? params.set('rules', '1') : params.delete('rules'))),
    [replaceParams],
  );

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => listConnectors(projectId),
    ...contract('config'),
  });
  const projectQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
  });

  const connectors = useMemo(() => connectorsQuery.data?.connectors ?? [], [connectorsQuery.data]);
  const connectedKeys = useMemo(() => connectedCatalogKeys(connectors), [connectors]);

  // What the card actually shows, handed to the search so typing a word the
  // user can read on screen matches the card carrying it.
  const describeConnector = useCallback(
    (connector: AdminConnector) => connectorSummary(connector, providerLabel(connector.provider)),
    [],
  );

  // The one gating primitive. `useFeatureFlag` reads the SAME
  // `qk.project.detail(projectId)` entry `projectQuery` above holds, so this is
  // the same fetch and the same fail-closed semantics — `projectQuery` stays
  // only to surface a load FAILURE and drive Retry (see `isError`/`retry`).
  const discoverEnabled = useFeatureFlag(projectId, 'connectors_api_discover').enabled;
  const emailChannelEnabled = useFeatureFlag(projectId, 'agentmail_email').enabled;

  // Whether this deployment has a catalogue to browse at all.
  //
  // `useCatalog` falls back to Easy Connect (Pipedream) whenever
  // `connectors_api_discover` is off, which is the default — so with the flag
  // off and Pipedream unconfigured, Discovery and All have no backend and every
  // request they make answers `501`. The probe is read HERE rather than off
  // `catalog`, because it decides `enabled` for the very hook that would
  // otherwise report it.
  //
  // Only a confirmed `absent` closes the tabs. While the probe is in flight the
  // page renders exactly as it always has: the overwhelming majority of
  // deployments do have Pipedream, and removing two tabs for a beat on every
  // load to spare a minority one is the wrong trade.
  const connectStatus = useConnectProviderStatus(!discoverEnabled);
  const catalogueAvailable = discoverEnabled || connectStatus.state !== 'absent';

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
  // `projectQuery` is the SAME cache entry `useFeatureFlag` reads, and every
  // flag read off it FAILS CLOSED: a 500 leaves `discoverEnabled` and
  // `emailChannelEnabled` false.
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

  // Discovery, always — never derived from what the project already has.
  // `defaultConnectorScope` used to open a project with connectors on its own
  // list, which put the least useful tab in front of the user most often: a
  // returning user opening this page is far more likely to be adding a
  // connector than reading the ones already there, and the ones already there
  // are one click away. It also made the landing tab depend on a query, so the
  // page could settle onto a different tab than it first rendered.
  //
  // Unless the requested scope needs a catalogue that is not there: `?scope=`
  // outlives the answer it was read under, and `?c=` returns the user to this
  // page after an OAuth round trip with the same param still in the URL.
  // Reading it blindly would strand them on a tab the strip no longer renders.
  // Connected and Channels never need the catalogue, so they are honored
  // either way.
  const requestedScope: ConnectorScope = parseScope(search?.get('scope') ?? null) ?? 'discover';
  const scope: ConnectorScope =
    catalogueAvailable || requestedScope === 'connected' || requestedScope === 'channels'
      ? requestedScope
      : 'connected';
  const catalogActive = scope === 'discover' || scope === 'all';
  // Channels replaces the connector list rather than narrowing it, so the
  // controls that only make sense over that list come off with it: the search
  // box searches the connector catalogue, and Add opens a custom-CONNECTOR
  // form. Channels has its own primary action already — the Slack hero owns
  // it — so it needs neither, and leaving them on screen would offer to search
  // a list that is not there.
  const channelsActive = scope === 'channels';

  // The scopes the strip actually offers. Filters out Discovery/All when
  // there is no catalogue to browse — see `catalogueAvailable` above and this
  // component's header comment. Connected and Channels are never filtered:
  // every deployment has its own connectors and its own inbound channels.
  const visibleScopes = catalogueAvailable
    ? SCOPES
    : SCOPES.filter((s) => s !== 'discover' && s !== 'all');

  // The category the catalogue should FILTER by, server-side. `null` while
  // browsing everything and while a search runs — the search is server-side
  // across every category, so narrowing one would contradict the grid.
  //
  // Read off `query`, not `catalog.activeQuery`: this is an input to the hook
  // that produces `catalog`, so it cannot depend on its output. The 300ms
  // debounce difference only means the filter clears one tick earlier, which
  // is the right direction.
  const focusCategory =
    catalogActive && category !== ALL_CATEGORIES && query.trim().length === 0 ? category : null;

  const catalog = useCatalog(projectId, query, {
    enabled: catalogActive,
    discoverEnabled,
    focusCategory,
  });

  // A category is a key in ONE catalogue's vocabulary. When `discoverEnabled`
  // resolves and the source flips, every entry is replaced and the open
  // category is a token from a namespace that no longer exists — so
  // `focusCategory` above would filter the new source by a key it has never
  // published, and the grid would be empty with nothing on screen explaining
  // why.
  //
  // Adjusted during render, not in an effect. React re-runs this component
  // before committing, so the reset lands in the same paint and `useCatalog`'s
  // own effects never observe the stale value. The effect version was one
  // render late by construction — which is exactly long enough to schedule the
  // first wasted page — and cost a second commit to do it.
  const [categorySource, setCategorySource] = useState(catalog.source);
  if (categorySource !== catalog.source) {
    setCategorySource(catalog.source);
    setCategory(ALL_CATEGORIES);
  }

  // Typing clears the category. The `Select` hides while a search runs (a
  // catalogue search is server-side across every category, so showing
  // "Finance" over unfiltered results would be a lie), and a filter the user
  // cannot see is a filter they cannot undo — clearing the search used to snap
  // the grid back to a category picked minutes earlier with nothing on screen
  // explaining it. Done in the handler rather than an effect: starting a search
  // is an event, and an effect watching `query` would also fire on mount and
  // on every unrelated re-render.
  const onQueryChange = useCallback((next: string) => {
    setQuery(next);
    if (next.trim().length > 0) setCategory(ALL_CATEGORIES);
  }, []);

  const filtered = useMemo(
    () => filterConnectors(connectors, { query, describe: describeConnector }),
    [connectors, query, describeConnector],
  );

  const emptyKind = catalogEmptyKind(connectors.length, filtered.length);
  const getCatalogHref = useCallback(
    (entry: CatalogEntry) => catalogConnectorHref(projectId, entry),
    [projectId],
  );

  return (
    <CapabilityPageShell
      title="Connectors"
      description={SCOPE_DESCRIPTION[scope]}
      search={
        channelsActive ? undefined : (
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <MagnifyingGlassIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder="Search all connectors"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
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
          <Button
            variant="secondary"
            aria-label="Add a custom connector"
            onClick={() => setPanel('custom')}
            className="transition-transform duration-150 ease-out active:scale-[0.96]"
          >
            <PlusIcon className="size-4" />
            Add
          </Button>
        ) : undefined
      }
      filters={
        // A strip of one tab is not a choice, so it collapses to no strip at
        // all when only one scope is reachable — `CapabilityPageShell` drops
        // the whole row when this is `undefined`, which is why it must not be
        // a bare fragment. With Channels in the mix a catalogue-less
        // deployment still has two real destinations (Connected, Channels),
        // so the strip survives losing Discovery and All; it only disappears
        // entirely for the narrower case of neither existing.
        visibleScopes.length > 1 ? (
          <>
            {/* Rendered immediately, not behind `settled`. The strip used to
                wait for both queries because the landing tab was derived from
                one of them and Connected carried a count off the other; neither
                is true now, so waiting only meant an empty 28px slot on every
                load followed by the tabs popping in. Static labels over a
                scope read out of the URL have nothing to wait for. */}
            <Tabs value={scope} onValueChange={(value) => setScope(value as ConnectorScope)}>
              <TabsList>
                {visibleScopes.map((value) => (
                  <TabsTrigger key={value} value={value}>
                    {SCOPE_LABEL[value]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
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
              Global rules
            </Button>
            {/* The category filter is NOT here. It is a rail of chips rendered
                by `ConnectorBrowse` directly above the grid it filters — this
                row is too narrow for it, and the rail has to sit next to its
                content for the lit chip to read as "this is why you are seeing
                these". */}
          </>
        ) : undefined
      }
    >
      {channelsActive ? (
        /* The whole of what used to be `/projects/<id>/channels`, minus the
           shell it used to bring — this page's `CapabilityPageShell` is the
           one column, the one heading and the one scroll container now. */
        <ChannelsSection projectId={projectId} />
      ) : catalogActive ? (
        <ConnectorBrowse
          state={catalog}
          connectedKeys={connectedKeys}
          mode={scope === 'discover' ? 'sectioned' : 'flat'}
          category={category}
          onCategoryChange={setCategory}
          getHref={getCatalogHref}
          emptyTitle="Catalogue unavailable"
          emptyDescription="The connector catalogue returned nothing. Try again shortly."
        />
      ) : (
        <CatalogGrid
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
                title="No connectors yet"
                description="Connect an outside tool and your agents can use it in a session."
                // The CTA goes with the tab it opens. With no catalogue on this
                // deployment it would be a button to a tab that is not there;
                // `+` is the remaining way in, and it is already in the header.
                action={
                  catalogueAvailable ? (
                    <Button size="sm" variant="secondary" onClick={() => setScope('discover')}>
                      Browse the catalogue
                    </Button>
                  ) : undefined
                }
              />
            )
          }
        >
          {filtered.map((connector) => (
            <CatalogCard
              key={connector.slug}
              leading={<ConnectorAppIcon connector={connector} size="lg" />}
              title={connectorDisplayName(connector)}
              description={describeConnector(connector)}
              badges={<ConnectorStatusBadge connector={connector} />}
              trailing={
                connectorSetupStatus(connector) === 'connected' ? (
                  <ConnectorConnectedMark />
                ) : undefined
              }
              href={connectedConnectorHref(projectId, connector.slug)}
            />
          ))}
        </CatalogGrid>
      )}

      {/* Custom upload only. `CustomConnectorForm` prints no heading of its
          own, so unlike the `AddAppPanel` this replaced it gets a real visible
          `ModalHeader` rather than a `VisuallyHidden` title — the dialog needs
          an accessible name and the user needs to know what the form is for.
          That is why `@radix-ui/react-visually-hidden` is no longer imported
          on this page. */}
      <Modal open={panel === 'custom'} onOpenChange={(open) => !open && setPanel(null)}>
        <ModalContent className="lg:max-w-3xl">
          <ModalHeader>
            <ModalTitle>Add a custom connector</ModalTitle>
            <ModalDescription>
              Point Kortix at an OpenAPI, Postman, GraphQL, MCP or HTTP source and it becomes a
              connector your agents can call.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[75vh] overflow-y-auto">
            <CustomConnectorForm
              projectId={projectId}
              emailChannelEnabled={emailChannelEnabled}
              onAdded={(slug) => {
                invalidate();
                if (slug) {
                  setPanel(null);
                  router.push(connectedConnectorHref(projectId, slug));
                }
              }}
            />
          </ModalBody>
        </ModalContent>
      </Modal>

      {/* A Sheet, not a Modal: `PoliciesPanel` is a long CRUD list that wants a
          persistent side surface, and its save bar sticks to the body's bottom
          edge — so the body has to be the only scroller. */}
      <Sheet open={rulesOpen} onOpenChange={setRulesOpen}>
        <SheetContent
          side="right"
          className="flex w-full flex-col gap-0 p-0 sm:max-w-xl md:max-w-2xl"
        >
          {/* `pr-12` clears the sheet's own close button, which is absolutely
              positioned at `top-4 right-4`. */}
          <SheetHeader className="border-border shrink-0 space-y-1 border-b px-5 py-4 pr-12 text-left">
            <SheetTitle className="text-base font-medium">Global rules</SheetTitle>
            <SheetDescription className="text-xs text-pretty">
              Approval rules that apply to every connector in this project.
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="min-h-0 gap-0 px-5 py-5">
            <PoliciesPanel projectId={projectId} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </CapabilityPageShell>
  );
}

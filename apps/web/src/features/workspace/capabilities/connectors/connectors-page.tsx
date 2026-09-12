'use client';

import { NewEntityMenu } from '@/features/workspace/capabilities/shared/new-entity-menu';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { getProjectDetail, listConnectors, type AdminConnector } from '@kortix/sdk';
import { contract, qk, useFeatureFlag, useProjectAccountId } from '@kortix/sdk/react';
import { MagnifyingGlassIcon, PlugIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import {
  SplitSheet,
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
} from '@/components/ui/split-sheet';
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
import { connectorKindLabel, providerLabel } from './provider-label';

import { type CatalogEntry } from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import { ConnectorBrowse } from '@/features/workspace/capabilities/connectors/catalog/connector-browse';
import {
  useCatalog,
  useConnectProviderStatus,
} from '@/features/workspace/capabilities/connectors/catalog/use-catalog';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { catalogEmptyKind } from '@/features/workspace/capabilities/shared/catalog/catalog-empty';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import { CatalogGrid } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { DENSE_GRID_CLASSNAME } from '@/features/workspace/capabilities/shared/catalog/catalog-grid-tokens';
import { connectorDisplayName, filterConnectors, type ConnectorScope } from './connector-filter';
import { catalogConnectorHref, connectedConnectorHref } from './connector-routes';
import { connectorStatusLine } from './connector-status-line';

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
 * `CustomConnectorForm` is the Add sheet's body.
 *
 * Neither can render before a click, so neither needs to be parsed before
 * one. `ssr: false` keeps them out of the server bundle too — `SplitSheetContent`
 * renders nothing while closed, so there is no markup worth streaming.
 */
const CustomConnectorForm = dynamic(
  () =>
    import('@/features/workspace/customize/sections/connectors-view').then(
      (m) => m.CustomConnectorForm,
    ),
  { ssr: false, loading: () => <SheetFormFallback /> },
);

/** Holds the Add sheet's body open while its form chunk arrives. */
function SheetFormFallback() {
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
 * Tab order is deliberate, and so is the landing tab: All leads and is always
 * what opens, for every project. The project's own list sits last — reachable
 * in one click, but never in the way of adding something.
 *
 * There is no Discovery tab (removed 2026-09-13, Jay). It was the same
 * catalogue as All wearing curated category sections, and with the dense
 * grid, kind labels, search, and the Install dropdown on every card, the
 * curation layer only pushed search further down — two presentations of one
 * list made users ask what the difference was. There is no Available tab
 * either, for the same reason it always lacked one: the catalogue minus
 * already-added cards is not a filter worth a tab.
 *
 * Channels sits LAST and outside that reasoning, because it is not a narrower
 * view of the same list — it is the other direction of the same job (who can
 * reach the agent, rather than what the agent can reach). Last is where a
 * reader stops expecting the strip to keep filtering one thing.
 *
 * All is dropped entirely on a deployment with no catalogue — see
 * `catalogueAvailable`. Without `connectors_api_discover` that catalogue is
 * Pipedream's, which answers `501` on every request unless three env vars are
 * set. It is removed rather than disabled: a disabled tab still asserts that
 * the feature exists and is merely out of reach for now, which is not what
 * "this deployment does not have Pipedream" means. Connected and Channels
 * stay either way — every deployment has its own connectors and its own
 * inbound channels, catalogue or not.
 */
const SCOPES: readonly ConnectorScope[] = ['all', 'connected', 'channels'];

const SCOPE_LABEL: Record<ConnectorScope, string> = {
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
  all: 'Give agents access to outside tools and data.',
  connected: 'Give agents access to outside tools and data.',
  channels: 'Reach your agent from the tools your team already uses.',
};

/** `?scope=` is user-editable text; anything that is not a scope is Discovery. */
function parseScope(value: string | null): ConnectorScope | null {
  return SCOPES.find((scope) => scope === value) ?? null;
}

/**
 * Who has the sheet column, if anyone.
 *
 * Both surfaces that used to float above the grid — Global rules as an
 * overlay `Sheet`, Add as a `Modal` — are now the same split column. One
 * column means they are mutually exclusive by construction rather than by a
 * rule someone has to remember, and the page never dims. Add wins a tie: it
 * is the surface the user just asked for.
 */
type SheetOccupant = 'rules' | 'add';

/**
 * /projects/[id]/connectors — the standalone Connectors catalogue.
 *
 * Reads the project's own connectors off `qk.project.connectors(projectId)`,
 * the same key `ConnectorsMasterDetail` uses, so the two surfaces cannot
 * disagree about what a project has.
 *
 * **Three tabs.** Two are one list each: All is the catalogue as one flat
 * searchable grid; Connected is the project's own connectors. There is no
 * Needs-attention tab — see `connector-filter.ts` for why it became a sort
 * key instead — and no Discovery or Available tab, see `SCOPES` below.
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

  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);

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

  // Legacy `?c=<slug>` — the retired modal's selection param. It is still
  // arriving: bookmarks taken while the modal existed, and OAuth 2.0 returns
  // whose `success_redirect_uri` was minted before the detail became a route
  // (the grant round trip can outlive a deploy). Forward it to the
  // connector's page, carrying every OTHER param along so the `?oauth2=`
  // outcome still lands where the toast for it lives.
  const legacyDetailSlug = search?.get('c') ?? null;
  useEffect(() => {
    if (!legacyDetailSlug) return;
    const params = new URLSearchParams(search?.toString() ?? '');
    params.delete('c');
    params.delete('scope');
    const suffix = params.toString();
    router.replace(
      `${connectedConnectorHref(projectId, legacyDetailSlug)}${suffix ? `?${suffix}` : ''}`,
      { scroll: false },
    );
  }, [legacyDetailSlug, projectId, router, search]);

  // Which scope the strip is on, held in the URL rather than in state.
  //
  // It has to be addressable: `/projects/<id>/channels` was a real route until
  // Channels folded into this page, and every bookmark and every legacy nav id
  // pointing at it now redirects to `?scope=channels`. A tab that only local
  // state can reach is a tab nothing can link to.
  //
  // All is the landing scope and writes NO param — see the `SCOPES` block for
  // why it is constant rather than derived. Omitting it keeps the bare URL
  // bare, so the common case still shares as `…/connectors`.
  const setScope = useCallback(
    (next: ConnectorScope) =>
      replaceParams((params) =>
        next === 'all' ? params.delete('scope') : params.set('scope', next),
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

  const sheet: SheetOccupant | null = addOpen ? 'add' : rulesOpen ? 'rules' : null;

  // Add takes the column over from Global rules, and `?rules=1` has to go with
  // it — left in the URL, closing Add would hand the column back to a rules
  // panel the user never opened. The guard keeps the common click off the
  // router: `setRulesOpen(false)` is a `router.replace` even when there is no
  // param to delete.
  const openAdd = useCallback(() => {
    if (rulesOpen) setRulesOpen(false);
    setAddOpen(true);
  }, [rulesOpen, setRulesOpen]);

  const closeSheet = useCallback(() => {
    setAddOpen(false);
    if (rulesOpen) setRulesOpen(false);
  }, [rulesOpen, setRulesOpen]);

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

  // What the card actually shows, handed to the search so typing a word the
  // user can read on screen matches the card carrying it. The line LEADS with
  // the state in words ("Connected", "Needs setup — connect an account") —
  // the Connected grid's job is telling a non-technical reader what works and
  // what to do next, not which protocol a connector speaks; the tool count
  // and provider ride along as trailing meta.
  const describeConnector = useCallback(
    (connector: AdminConnector) =>
      connectorStatusLine(connector, providerLabel(connector.provider)),
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

  // All, always — never derived from what the project already has.
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
  const requestedScope: ConnectorScope = parseScope(search?.get('scope') ?? null) ?? 'all';
  const scope: ConnectorScope =
    catalogueAvailable || requestedScope === 'connected' || requestedScope === 'channels'
      ? requestedScope
      : 'connected';
  const catalogActive = scope === 'all';
  // Channels replaces the connector list rather than narrowing it, so the
  // controls that only make sense over that list come off with it: the search
  // box searches the connector catalogue, and Add opens a custom-CONNECTOR
  // form. Channels has its own primary action already — the Slack hero owns
  // it — so it needs neither, and leaving them on screen would offer to search
  // a list that is not there.
  const channelsActive = scope === 'channels';

  // The scopes the strip actually offers. Filters out All when there is no
  // catalogue to browse — see `catalogueAvailable` above and this component's
  // header comment. Connected and Channels are never filtered: every
  // deployment has its own connectors and its own inbound channels.
  const visibleScopes = catalogueAvailable ? SCOPES : SCOPES.filter((s) => s !== 'all');

  const catalog = useCatalog(projectId, query, {
    enabled: catalogActive,
    discoverEnabled,
  });

  const onQueryChange = useCallback((next: string) => setQuery(next), []);

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
    /* Global rules and Add both open as a SPLIT column beside the grid, never
       as an overlay — the list stays readable (and clickable) while either is
       used. `?rules=1` still owns the rules open state, so that surface stays
       deep-linkable; Add is a click, so it stays local state.

       The column sizes itself to its occupant: rules is a list of controls
       (`md`), Add is one narrow stack of fields (`sm`). */
    <SplitSheet
      open={sheet !== null}
      onOpenChange={(open) => {
        if (!open) closeSheet();
      }}
      size="md"
      className="min-h-0 flex-1"
    >
      <SplitSheetMain className="flex flex-col">
        <CapabilityPageShell
          title={tI18nComplete.raw('textc3d2e79ebdd0')}
          description={SCOPE_DESCRIPTION[scope]}
          search={
            channelsActive ? undefined : (
              <InputGroupSearch>
                <InputGroupSearchIcon>
                  <MagnifyingGlassIcon />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  placeholder={tI18nComplete.raw('textc386cb852691')}
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
              <NewEntityMenu
                label={tI18nComplete.raw('text18fdd549b2ed')}
                pending={configure.pending}
                onChat={() => configure.start(newConfigPrompt('connector'))}
                manual={{
                  label: tI18nComplete.raw('text90ccaee30bdc'),
                  description: tI18nComplete.raw('textb0fbe9dc1fcc'),
                  onSelect: () => openAdd(),
                }}
              />
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
                  {tI18nComplete.raw('text1d59a5e09714')}
                </Button>
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
              connectors={connectors}
              getHref={getCatalogHref}
              emptyTitle={tI18nComplete.raw('text3a63271cafc1')}
              emptyDescription={tI18nComplete.raw('textf652a621153e')}
            />
          ) : (
            <CatalogGrid
              gridClassName={DENSE_GRID_CLASSNAME}
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
                    // The CTA goes with the tab it opens. With no catalogue on this
                    // deployment it would be a button to a tab that is not there;
                    // `+` is the remaining way in, and it is already in the header.
                    action={
                      catalogueAvailable ? (
                        <Button size="sm" variant="secondary" onClick={() => setScope('all')}>
                          {tI18nComplete.raw('text45bfe4f17af7')}
                        </Button>
                      ) : undefined
                    }
                  />
                )
              }
            >
              {filtered.map((connector) => (
                // Minimal card: icon and title, no border, no meta line. The row
                // under the title carries only what needs acting on — the
                // emphasized MCP mark and any problem-state badge. The full
                // status line still feeds SEARCH via `describeConnector`, so
                // typing what a card used to say keeps matching it.
                <CatalogCard
                  key={connector.slug}
                  variant="plain"
                  leading={<ConnectorAppIcon connector={connector} size="lg" />}
                  title={connectorDisplayName(connector)}
                  subtitle={
                    <>
                      <span className="text-muted-foreground text-xs">
                        {connectorKindLabel(connector.provider)}
                      </span>
                      <ConnectorStatusBadge connector={connector} />
                    </>
                  }
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
        </CapabilityPageShell>
      </SplitSheetMain>

      {/* One column, one header, whichever surface has it. `CustomConnectorForm`
          prints no heading of its own, so — like the rules panel — it takes the
          sheet's real visible `SplitSheetHeader`: the column needs an accessible
          name and the user needs to know what the form is for. */}
      <SplitSheetContent>
        <SplitSheetHeader>
          <SplitSheetTitle>
            {sheet === 'add'
              ? tI18nComplete.raw('text90ccaee30bdc')
              : tI18nComplete.raw('text1d59a5e09714')}
          </SplitSheetTitle>
          <SplitSheetDescription>
            {sheet === 'add'
              ? tI18nComplete.raw('textd2f3be0047c4')
              : tI18nComplete.raw('text014d10bd3c64')}
          </SplitSheetDescription>
        </SplitSheetHeader>
        <SplitSheetBody>
          {sheet === 'add' ? (
            <CustomConnectorForm
              projectId={projectId}
              emailChannelEnabled={emailChannelEnabled}
              onAdded={(slug) => {
                invalidate();
                if (slug) {
                  setAddOpen(false);
                  // `?connect=1`: the connector page opens its connect dialog
                  // when a credential is still needed. A custom connector
                  // created with its credential in the same form arrives
                  // already connected, and the page ignores the param.
                  router.push(`${connectedConnectorHref(projectId, slug)}?connect=1`);
                }
              }}
            />
          ) : (
            <PoliciesPanel projectId={projectId} />
          )}
        </SplitSheetBody>
      </SplitSheetContent>
    </SplitSheet>
  );
}

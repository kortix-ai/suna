'use client';

import { NewEntityMenu } from '@/features/workspace/capabilities/shared/new-entity-menu';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { getProjectDetail, listConnectors, type AdminConnector } from '@kortix/sdk';
import { contract, FRESHNESS, qk, useFeatureFlag, useProjectAccountId } from '@kortix/sdk/react';
import { MagnifyingGlassIcon, PlugIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import { providerLabel } from './provider-label';

import { ComputerConnectModal } from '@/features/tunnel/computer-connect';
import {
  connectedCatalogKeys,
  type CatalogEntry,
} from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
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
import { useTunnelConnections } from '@/hooks/tunnel/use-tunnel';
import {
  connectorDisplayName,
  connectorSummary,
  filterConnectors,
  type ConnectorScope,
} from './connector-filter';
import { appHref, appRefFromEntry, connectorHref, legacyDetailRedirect } from './connector-routes';
import type { InstallAudience } from './install/install';
import { useInstall } from './install/use-install';

/**
 * The click-gated Add form, split out of this route's initial chunk.
 *
 * It lives in `customize/sections/connectors-view.tsx` — 5,075 lines whose own
 * import list pulls `@pipedream/sdk/browser`, `HighlightedCode` (shiki),
 * `PoliciesPanel`, `DiscoverCatalogue` and `ConnectorConnectionModal`. An ES
 * module is all-or-nothing to the bundler, so one `import` line puts that
 * entire graph in front of a page that paints a grid of cards.
 * `connector-identity.tsx` was lifted out of that file for exactly this
 * reason; a static import here is the edge that puts it straight back.
 *
 * `CustomConnectorForm` is the Add modal's body. It cannot render before a
 * click, so it need not be parsed before one. `ssr: false` keeps it out of the
 * server bundle too — a closed modal has no markup worth streaming.
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
 * `dynamic` for the same reason the form above is, and more urgently: its
 * `EmailConnectForm` import reaches `customize/sections/connectors-view.tsx`,
 * the same 5,075-line module the Add modal's form lives in. A static import
 * would put that whole graph — `@pipedream/sdk/browser`, shiki, `PoliciesPanel`
 * — in front of the catalogue grid for every visitor, including the ones who
 * never open this tab. All is the landing scope, so this is click-gated
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
 *
 * All is dropped entirely on a deployment with no catalogue — see
 * `catalogueAvailable`. Without `connectors_api_discover` the catalogue is the
 * managed provider's, which answers `501` on every request unless it is
 * configured. The tab is removed rather than disabled: a disabled tab still
 * asserts that the feature exists. Connected and Channels stay either way.
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

/** `?scope=` is user-editable text; anything that is not a scope is All. */
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
  const [panel, setPanel] = useState<Panel | null>(null);
  const [computerOpen, setComputerOpen] = useState(false);
  const tSharing = useI18nTranslations('accessSharing');

  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

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

  const canShare =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE, { accountId })
      .allowed === true;
  const { installEntry, pendingKey } = useInstall(projectId);
  const projectName = projectQuery.data?.project?.name ?? '';
  const everyoneLabel = projectName
    ? tSharing('everyone', { project: projectName })
    : tSharing('visibilityEveryone');
  const catalogInstall = useMemo(
    () => ({
      // `connectors` is `[]` until the list loads, and an install run against
      // that creates a second connector for an app the project already has.
      ready: connectorsQuery.isSuccess,
      canWrite,
      canShare,
      onlyYou: tSharing('onlyYou'),
      everyone: everyoneLabel,
      pendingKey,
      onInstall: (entry: CatalogEntry, audience: InstallAudience) =>
        installEntry(entry, audience, connectors),
    }),
    [
      canShare,
      canWrite,
      connectors,
      connectorsQuery.isSuccess,
      everyoneLabel,
      installEntry,
      pendingKey,
      tSharing,
    ],
  );

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

  // One catalogue: managed apps for browsing, plus API/MCP apps in search
  // (`useCatalog`). The probe is independent of the active scope so an absent
  // provider cannot oscillate the catalogue between enabled and disabled.
  const connectStatus = useConnectProviderStatus(true);
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
  // outlives the answer it was read under (a bookmark, a shared link).
  // Reading it blindly would strand the user on a tab the strip no longer
  // renders.
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

  // The scopes the strip actually offers. Filters out All when
  // there is no catalogue to browse — see `catalogueAvailable` above and this
  // component's header comment. Connected and Channels are never filtered:
  // every deployment has its own connectors and its own inbound channels.
  const visibleScopes = catalogueAvailable ? SCOPES : SCOPES.filter((s) => s !== 'all');

  // The machine list answers 503 on a deployment with computers disabled, so
  // the Computer card shows only where a computer can be connected.
  const computersEnabled = useTunnelConnections({ refetchInterval: false }).isSuccess;
  const catalog = useCatalog(projectId, query, {
    enabled: catalogActive,
    discoverEnabled,
    computers: computersEnabled,
  });

  const filtered = useMemo(
    () => filterConnectors(connectors, { query, describe: describeConnector }),
    [connectors, query, describeConnector],
  );

  const emptyKind = catalogEmptyKind(connectors.length, filtered.length);

  // The Computer card opens the existing computer connector once there is
  // one: adding a computer is adding an account to it.
  const computerConnector = connectors.find((connector) => connector.provider === 'computer');
  const catalogHref = useCallback(
    (entry: CatalogEntry) => {
      const app = appRefFromEntry(entry);
      if (app) return appHref(projectId, app);
      return computerConnector ? connectorHref(projectId, computerConnector.slug) : null;
    },
    [computerConnector, projectId],
  );
  // Stable, like `catalogHref`: the browse cards are `memo`'d, and an inline
  // arrow here would re-render every one of them on each page render.
  const openComputer = useCallback(() => setComputerOpen(true), []);

  // The search field is the page's main control: focused on arrival, and "/"
  // jumps back to it from anywhere on the page except another text field.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (channelsActive || rulesOpen || typeof window === 'undefined') return;
    // No autofocus on touch: it would open the on-screen keyboard on arrival.
    if (window.matchMedia?.('(pointer: fine)').matches) {
      searchRef.current?.focus({ preventScroll: true });
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      // A dialog or menu owns the keyboard while it is open.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [channelsActive, rulesOpen]);

  return (
    // Global rules open in a SplitSheet: the page narrows to make room instead
    // of being covered. `PoliciesPanel` is a long CRUD list whose save bar
    // sticks to the body's bottom edge, so the body is the only scroller.
    <SplitSheet open={rulesOpen} onOpenChange={setRulesOpen} size="lg" className="flex-1">
      <SplitSheetMain>
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
                manual={{
                  label: tI18nComplete.raw('text90ccaee30bdc'),
                  description: tI18nComplete.raw('textb0fbe9dc1fcc'),
                  onSelect: () => setPanel('custom'),
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
            // so the strip survives losing All; it only disappears
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
              connectedKeys={connectedKeys}
              hrefFor={catalogHref}
              onOpen={openComputer}
              install={catalogInstall}
              emptyTitle={tI18nComplete.raw('text3a63271cafc1')}
              emptyDescription={tI18nComplete.raw('textf652a621153e')}
            />
          ) : (
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
                <CatalogCard
                  key={connector.slug}
                  // The All tab's card: logo and title on the page, one quiet line.
                  variant="plain"
                  leading={<ConnectorAppIcon connector={connector} size="lg" />}
                  title={connectorDisplayName(connector)}
                  subtitle={
                    <span className="text-muted-foreground text-xs">
                      {describeConnector(connector)}
                    </span>
                  }
                  badges={<ConnectorStatusBadge connector={connector} />}
                  trailing={
                    connectorSetupStatus(connector) === 'connected' ? (
                      <ConnectorConnectedMark />
                    ) : undefined
                  }
                  href={connectorHref(projectId, connector.slug)}
                />
              ))}
            </CatalogGrid>
          )}

          {/* Computers are accounts, not profiles: the card pairs the caller's own
          machine. The `computer` connector is built into every project, so
          the card opens it when listed and pairs a machine otherwise. */}
          <ComputerConnectModal
            projectId={projectId}
            open={computerOpen}
            onOpenChange={setComputerOpen}
            onConnected={(connection) => {
              invalidate();
              router.push(connectorHref(projectId, connection.connector_alias));
            }}
          />

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
                  emailChannelEnabled={emailChannelEnabled}
                  onAdded={(slug) => {
                    invalidate();
                    if (slug) {
                      setPanel(null);
                      router.push(connectorHref(projectId, slug));
                    }
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

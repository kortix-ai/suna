'use client';

import { type AdminConnector } from '@kortix/sdk';
import { MagnifyingGlassIcon, PlugIcon, PlusIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  InputGroupSearch,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  connectorAuthorizationQueryKeys,
  connectorSetupStatus,
} from '@/features/workspace/customize/sections/connector-profile-form';

import {
  ConnectorAppIcon,
  ConnectorConnectedMark,
  ConnectorStatusBadge,
} from './connector-identity';
import { projectConnectorsQuery } from './project-connectors-query';
import { providerLabel } from './provider-label';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { CatalogCard } from '@/features/workspace/capabilities/shared/catalog/catalog-card';
import { catalogEmptyKind } from '@/features/workspace/capabilities/shared/catalog/catalog-empty';
import { CatalogGrid } from '@/features/workspace/capabilities/shared/catalog/catalog-grid';
import { CatalogNoMatch } from '@/features/workspace/capabilities/shared/catalog/catalog-empty-state';
import { detailSelection } from '@/features/workspace/capabilities/shared/detail-selection';
import {
  projectDetailQuery,
  useProjectAccountId,
} from '@/features/workspace/capabilities/shared/project-detail-query';
import { connectedCatalogKeys, type CatalogEntry } from '@/features/workspace/capabilities/connectors/catalog/catalog-entry';
import { CategorySelect, ConnectorBrowse } from '@/features/workspace/capabilities/connectors/catalog/connector-browse';
import { ALL_CATEGORIES, catalogCategoryKeys } from '@/features/workspace/capabilities/connectors/catalog/connector-categories';
import {
  connectorDisplayName,
  connectorSummary,
  filterConnectors,
  type ConnectorScope,
} from './connector-filter';
import { DiscoverAddFlow } from '@/features/workspace/capabilities/connectors/add/discover-add-flow';
import { EasyConnectAddFlow } from '@/features/workspace/capabilities/connectors/add/easy-connect-add-flow';
import { useCatalog } from '@/features/workspace/capabilities/connectors/catalog/use-catalog';

/**
 * The two click-gated surfaces, split out of this route's initial chunk.
 *
 * Both reach `customize/sections/connectors-view.tsx` — 5,075 lines whose own
 * import list pulls `@pipedream/sdk/browser`, `HighlightedCode` (shiki),
 * `PoliciesPanel`, `DiscoverCatalogue` and `ConnectorProfileModal`. An ES
 * module is all-or-nothing to the bundler, so two `import` lines put that
 * entire graph in front of a page that paints a grid of cards.
 * `connector-identity.tsx` was lifted out of that file for exactly this
 * reason; these were the two edges that put it straight back.
 *
 *   • `ConnectorModal` reaches it via `connector-accounts.tsx`
 *     (`ConnectionRoster`/`ConnectionSection`/…) and its own
 *     `SetCredentialModal`, and owns the only `usePipedreamConnect` call on
 *     the route.
 *   • `CustomConnectorForm` is the `+` modal's body.
 *
 * Neither can render before a click, so neither needs to be parsed before
 * one. `ssr: false` keeps them out of the server bundle too — a closed modal
 * has no markup worth streaming.
 */
const ConnectorModal = dynamic(
  () =>
    import('@/features/workspace/capabilities/connectors/detail/connector-modal').then(
      (m) => m.ConnectorModal,
    ),
  { ssr: false },
);

const CustomConnectorForm = dynamic(
  () =>
    import('@/features/workspace/customize/sections/connectors-view').then(
      (m) => m.CustomConnectorForm,
    ),
  { ssr: false, loading: () => <ModalFormFallback /> },
);

/** Holds the `+` modal's height while its form chunk arrives. */
function ModalFormFallback() {
  return (
    <div className="flex min-h-64 items-center justify-center">
      <Loading className="size-5 shrink-0" />
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
 */
const SCOPES: readonly ConnectorScope[] = ['discover', 'all', 'connected'];

const SCOPE_LABEL: Record<ConnectorScope, string> = {
  discover: 'Discovery',
  all: 'All',
  connected: 'Connected',
};

/** Which page-level modal is open, if any. Only one can be at a time. */
type Panel = 'custom';

/**
 * /projects/[id]/connectors — the standalone Connectors catalogue.
 *
 * Reads the project's own connectors off `qk.project.connectors(projectId)`,
 * the same key `ConnectorsMasterDetail` uses, so the two surfaces cannot
 * disagree about what a project has.
 *
 * **Three tabs, one list each.** Discovery is the catalogue in category
 * sections, each expandable in place; All is the same catalogue flat;
 * Connected is the project's own connectors. There is no Needs-attention tab —
 * see `connector-filter.ts` for why it became a sort key instead — and no
 * Available tab, see `SCOPES` below.
 *
 * **What `+` opens.** Only the custom-connector form (OpenAPI / Postman /
 * GraphQL / MCP / HTTP). Everything the Add-connector modal used to hide
 * behind a four-tab strip now lives on the page: Easy Connect and Discover as
 * catalogue cards, Channels as catalogue entries alongside them. A modal is
 * the right home for a form; it was the wrong home for a catalogue.
 *
 * `?c=<slug>` still owns which connector's detail is open, and that is
 * load-bearing rather than cosmetic. `SetCredentialModal` starts an OAuth 2.0
 * authorization-code grant by sending the browser to the provider with
 * `success_redirect_uri = window.location.href` minus the two `oauth2*`
 * params. The user comes back through a full page load, so any React state
 * saying "this connector's modal was open" is gone — but `?c=` survives,
 * because the redirect URL is built from the current one.
 */
export function ConnectorsPage({ projectId }: { projectId: string }) {
  // `accountId` comes off the detail this page already loads. Without it
  // `useProjectCan` fetches the project a second time under its own key AND
  // holds the IAM probe disabled until that lands — so `+` and every write
  // affordance appeared two sequential round-trips after paint.
  const accountId = useProjectAccountId(projectId);
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE, { accountId }).allowed ===
    true;
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [scopeChoice, setScopeChoice] = useState<ConnectorScope | null>(null);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [catalogTarget, setCatalogTarget] = useState<CatalogEntry | null>(null);

  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const detailSlug = search?.get('c') ?? null;

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(search?.toString() ?? '');
      mutate(params);
      const suffix = params.toString();
      router.replace(suffix ? `${pathname}?${suffix}` : pathname, { scroll: false });
    },
    [pathname, router, search],
  );

  const setDetailSlug = useCallback(
    (slug: string | null) =>
      replaceParams((params) => (slug ? params.set('c', slug) : params.delete('c'))),
    [replaceParams],
  );

  const connectorsQuery = useQuery(projectConnectorsQuery(projectId));
  const projectQuery = useQuery(projectDetailQuery(projectId));

  const connectors = useMemo(() => connectorsQuery.data?.connectors ?? [], [connectorsQuery.data]);
  const existingSlugs = useMemo(() => connectors.map((c) => c.slug), [connectors]);
  const connectedKeys = useMemo(() => connectedCatalogKeys(connectors), [connectors]);

  // What the card actually shows, handed to the search so typing a word the
  // user can read on screen matches the card carrying it.
  const describeConnector = useCallback(
    (connector: AdminConnector) => connectorSummary(connector, providerLabel(connector.provider)),
    [],
  );

  const experimental = projectQuery.data?.project?.experimental;
  const discoverEnabled = experimental?.connectors_api_discover === true;
  const emailChannelEnabled = experimental?.agentmail_email === true;

  const authorizationQueryKeys = useMemo(
    () => connectorAuthorizationQueryKeys(projectId),
    [projectId],
  );
  const invalidate = useCallback(() => {
    for (const key of authorizationQueryKeys) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  }, [authorizationQueryKeys, queryClient]);

  // The OAuth 2.0 return leg. The provider bounces the user back here with
  // `?oauth2=connected|error`. Confirm, refetch every authorization-derived
  // query, then strip only the two `oauth2*` params — `?c=` is deliberately
  // left in place, so the detail modal reopens on the connector just
  // authorized.
  const oauth2Result = search?.get('oauth2');
  const oauth2Error = search?.get('oauth2_error');
  useEffect(() => {
    if (oauth2Result !== 'connected' && oauth2Result !== 'error') return;
    if (oauth2Result === 'connected') successToast('OAuth 2.0 connection completed');
    else errorToast(oauth2Error || 'OAuth 2.0 connection failed');
    invalidate();
    replaceParams((params) => {
      params.delete('oauth2');
      params.delete('oauth2_error');
    });
  }, [invalidate, oauth2Error, oauth2Result, replaceParams]);

  // Both queries gate what this page can offer, so both have to be able to
  // report a failure and both have to be retried.
  //
  // `projectQuery` supplies `experimental`, and every flag read off it FAILS
  // CLOSED: a 500 leaves `discoverEnabled` and `emailChannelEnabled` false.
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
  const scope: ConnectorScope = scopeChoice ?? 'discover';
  const catalogActive = scope !== 'connected';

  const catalog = useCatalog(projectId, query, { enabled: catalogActive, discoverEnabled });

  // Derived ONCE, for both the `Select` and the grid. Deriving it twice is what
  // let the control and the content disagree about which categories exist.
  const availableCategories = useMemo(
    () => catalogCategoryKeys(catalog.entries, (entry) => entry.categories),
    [catalog.entries],
  );

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

  // Looked up against the unfiltered list, never `filtered` — searching or
  // switching scope while the modal is open must not yank it shut.
  //
  // `detailSelection` then keeps the modal's `open` on `?c=` alone. Deriving
  // it from this lookup is what made the modal animate itself open a beat
  // after an OAuth return (list still loading, so the lookup missed) and
  // vanish mid-edit whenever one of `invalidate()`'s four refetches failed.
  const detail = detailSelection({
    selection: detailSlug,
    record: connectors.find((c) => c.slug === detailSlug),
    isSuccess: connectorsQuery.isSuccess,
  });

  // The one honest auto-close: the list came back, and this connector is not
  // in it. That is a deletion — by this user in another tab, or by a teammate.
  useEffect(() => {
    if (detail.isMissing) setDetailSlug(null);
  }, [detail.isMissing, setDetailSlug]);

  // The detail chunk is lazy (see the `dynamic` block above), so it must not
  // mount until something is selected — otherwise every page load pays for it.
  // Once mounted it STAYS mounted: unmounting on close would cut Radix's exit
  // animation, and the chunk is already in memory by then anyway.
  // Seeded from the FIRST render, not an effect: `?c=<slug>` is already in the
  // URL on a deep link and on every OAuth return, and mounting a frame later
  // would put the modal on screen one paint after the page behind it.
  const [detailMounted, setDetailMounted] = useState(() => detailSlug !== null);
  useEffect(() => {
    if (detail.open) setDetailMounted(true);
  }, [detail.open]);

  const emptyKind = catalogEmptyKind(connectors.length, filtered.length);

  const onCatalogAdded = useCallback(
    (slug?: string) => {
      setCatalogTarget(null);
      invalidate();
      if (slug) {
        setScopeChoice('connected');
        setDetailSlug(slug);
      }
    },
    [invalidate, setDetailSlug],
  );

  return (
    <CapabilityPageShell
      title="Connectors"
      description="Give agents access to outside tools and data."
      search={
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
      }
      action={
        canWrite ? (
          <Button
            size="icon-md"
            variant="secondary"
            aria-label="Add a custom connector"
            onClick={() => setPanel('custom')}
            className="relative transition-transform duration-150 ease-out before:absolute before:-inset-1.5 before:content-[''] active:scale-[0.96]"
          >
            <PlusIcon className="size-4" />
          </Button>
        ) : undefined
      }
      filters={
        <>
          {/* Rendered immediately, not behind `settled`. The strip used to
              wait for both queries because the landing tab was derived from
              one of them and Connected carried a count off the other; neither
              is true now, so waiting only meant an empty 28px slot on every
              load followed by the tabs popping in. Three static labels over a
              constant `scope` have nothing to wait for. */}
          <Tabs value={scope} onValueChange={(value) => setScopeChoice(value as ConnectorScope)}>
            <TabsList>
              {SCOPES.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {SCOPE_LABEL[value]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {/* Hidden during a catalogue search: the search is server-side across
              every category, so the grid ignores the category while one is
              running. Leaving the control on screen showing "Design" over
              results that are not filtered to Design would be a lie. */}
          {catalogActive && catalog.activeQuery.length === 0 ? (
            <CategorySelect
              categories={availableCategories}
              value={category}
              onChange={setCategory}
            />
          ) : null}
        </>
      }
    >
      {catalogActive ? (
        <ConnectorBrowse
          state={catalog}
          connectedKeys={connectedKeys}
          mode={scope === 'discover' ? 'sectioned' : 'flat'}
          category={category}
          availableCategories={availableCategories}
          onSelect={setCatalogTarget}
          emptyTitle="Catalogue unavailable"
          emptyDescription="The integration catalogue returned nothing. Try again shortly."
        />
      ) : (
        <CatalogGrid
          // `!settled`, not `connectorsQuery.isLoading`: the empty state's
          // wording depends on `projectQuery` too. Same gate as the filter row.
          isLoading={!settled}
          isError={isError}
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
                action={
                  <Button size="sm" variant="secondary" onClick={() => setScopeChoice('discover')}>
                    Browse the catalogue
                  </Button>
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
              onClick={() => setDetailSlug(connector.slug)}
            />
          ))}
        </CatalogGrid>
      )}

      {/* One target, two add flows. `CatalogEntry` is a discriminated union, so
          the source that produced the card decides which flow opens — a
          Discover entry cannot be handed to Pipedream's profile modal, and
          vice versa. Each receives `null` unless the target is its own kind,
          which is also what keeps them closed. */}
      <DiscoverAddFlow
        projectId={projectId}
        integration={catalogTarget?.source === 'discover' ? catalogTarget.integration : null}
        existingSlugs={existingSlugs}
        canWrite={canWrite}
        onClose={() => setCatalogTarget(null)}
        onAdded={onCatalogAdded}
      />
      <EasyConnectAddFlow
        projectId={projectId}
        app={catalogTarget?.source === 'easy-connect' ? catalogTarget.app : null}
        existingSlugs={existingSlugs}
        canWrite={canWrite}
        onClose={() => setCatalogTarget(null)}
        onAdded={onCatalogAdded}
      />

      {/* Custom upload only. `CustomConnectorForm` prints no heading of its
          own, so unlike the `AddAppPanel` this replaced it gets a real visible
          `ModalHeader` rather than a `VisuallyHidden` title — the dialog needs
          an accessible name and the user needs to know what the form is for.
          That is why `@radix-ui/react-visually-hidden` is no longer imported
          on this page. Global rules live on `CapabilityTabs` as a Sheet. */}
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
                  setScopeChoice('connected');
                  setDetailSlug(slug);
                }
              }}
            />
          </ModalBody>
        </ModalContent>
      </Modal>

      {detailMounted ? (
        <ConnectorModal
          projectId={projectId}
          connector={detail.record}
          canWrite={canWrite}
          open={detail.open}
          isResolving={detail.isResolving}
          onOpenChange={(open) => !open && setDetailSlug(null)}
          onChanged={invalidate}
          onRemoved={() => {
            invalidate();
            setDetailSlug(null);
          }}
        />
      ) : null}
    </CapabilityPageShell>
  );
}

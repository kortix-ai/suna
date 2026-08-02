'use client';

import { getProjectDetail, listConnectors, type DiscoverIntegration } from '@kortix/sdk';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { MagnifyingGlassIcon, PlugIcon, PlusIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PoliciesPanel } from '@/components/projects/policies-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
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
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { connectorAuthorizationQueryKeys } from '@/features/workspace/customize/sections/connector-profile-form';
import {
  AddAppPanel,
  ConnectorAppIcon,
  ConnectorDetail,
  ConnectorStatusBadge,
  providerLabel,
} from '@/features/workspace/customize/sections/connectors-view';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';

import { CapabilityPageShell } from '../capability-page-shell';
import { CatalogCard } from '../catalog-card';
import { catalogEmptyKind } from '../catalog-empty';
import { CatalogGrid } from '../catalog-grid';
import {
  ALL_CATEGORIES,
  CategorySelect,
  ConnectorBrowse,
  useDiscoverBrowse,
} from './connector-browse';
import {
  connectorSummary,
  defaultConnectorScope,
  filterConnectors,
  type ConnectorScope,
} from './connector-filter';
import { DiscoverAddFlow } from './discover-add-flow';

const SCOPE_LABEL: Record<ConnectorScope, string> = {
  project: 'In project',
  browse: 'Browse',
  attention: 'Needs attention',
};

/** Which page-level panel is open, if any. Only one can be at a time. */
type Panel = 'add' | 'rules';

/**
 * Two of the three modals host a panel that already prints its own visible
 * heading, so their `ModalTitle` exists only to give Radix the accessible name
 * it requires. It is hidden with `VisuallyHidden asChild` rather than an
 * `sr-only` class, deliberately:
 *
 *  - `asChild` puts the hiding on the `<h2>` ITSELF, so `getComputedStyle` on
 *    the title reports `position: absolute` and `clip: rect(0,0,0,0)`. With
 *    `sr-only` on a wrapping `ModalHeader`, the title's own computed `clip` is
 *    `auto` even when it is correctly hidden, which makes the fix impossible
 *    to confirm by measuring the heading.
 *  - Radix applies those rules as an inline `style` object, so no utility
 *    class, cascade layer or `tailwind-merge` decision can undo them.
 *
 * The title sits inside `ModalBody` (which carries `space-y-0`) instead of a
 * `ModalHeader`: a header would contribute `px-5 pt-5` of padding above a
 * panel that supplies its own, and `ModalContent`'s `space-y-4` would put a
 * 16px gap under a 1px element.
 */

/**
 * /projects/[id]/connectors — the standalone Connectors catalog.
 *
 * Reads the project's own connectors off `['project-connectors', projectId]`,
 * the same key `ConnectorsMasterDetail` uses, so the two surfaces cannot
 * disagree about what a project has.
 *
 * This page is the ONLY entry point to the connector surface. Moving
 * Connectors out of the Customize overlay left `ConnectorsView` mounted
 * nowhere, so everything it used to host has to be reachable from here:
 *  - **Add connector** -> `AddAppPanel` (Easy Connect / Discover / Channels /
 *    Custom), unchanged, in a modal.
 *  - **Global rules** -> `PoliciesPanel`, unchanged, in a modal. These rules
 *    are project-scope, not per-connector, which is why they live on the page
 *    and not in a connector's own modal.
 *  - **A connector's detail** -> `ConnectorDetail`, unchanged, in a modal.
 *    Interim: a later task replaces the body with a purpose-built rung modal.
 *    Hosting the existing panel now means no capability is unreachable in the
 *    meantime.
 *
 * The three imported panels are used verbatim; the only change made to
 * `connectors-view.tsx` was adding `export` to five declarations.
 */
export function ConnectorsPage({ projectId }: { projectId: string }) {
  const canWrite =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_CONNECTOR_WRITE).allowed === true;
  const queryClient = useQueryClient();

  const [query, setQuery] = useState('');
  const [scopeChoice, setScopeChoice] = useState<ConnectorScope | null>(null);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [browseTarget, setBrowseTarget] = useState<DiscoverIntegration | null>(null);

  // Which connector's detail is open lives in `?c=<slug>`, not in component
  // state, and that is load-bearing rather than cosmetic. `SetCredentialModal`
  // (rendered by `ConnectorDetail`) starts an OAuth 2.0 authorization-code
  // grant by sending the browser to the provider with
  // `success_redirect_uri = window.location.href` minus the two `oauth2*`
  // params. The user comes back through a full page load, so any React state
  // saying "this connector's modal was open" is gone — but `?c=` survives,
  // because the redirect URL is built from the current one. URL-backed state
  // is therefore what reopens the right connector on return; it also makes a
  // connector's detail deep-linkable, which the master-detail it replaced
  // already was.
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

  const connectorsQuery = useQuery({
    queryKey: ['project-connectors', projectId],
    queryFn: () => listConnectors(projectId),
    staleTime: 10_000,
  });
  const projectQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 60_000,
  });

  const connectors = useMemo(
    () => connectorsQuery.data?.connectors ?? [],
    [connectorsQuery.data],
  );
  const existingSlugs = useMemo(() => connectors.map((c) => c.slug), [connectors]);

  const experimental = projectQuery.data?.project?.experimental;
  const browseEnabled = experimental?.connectors_api_discover === true;
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

  // The OAuth 2.0 return leg. `SetCredentialModal` sends the user off-site and
  // the provider bounces them back here with `?oauth2=connected|error`. The
  // effect that consumes those params used to live in `ConnectorsMasterDetail`,
  // which is no longer mounted anywhere — without this, a completed
  // authorization landed on a stale grid: no confirmation, no refetch, and the
  // params stuck in the URL.
  //
  // Confirm, refetch every authorization-derived query, then strip only the
  // two `oauth2*` params. `?c=` is deliberately left in place, so the detail
  // modal reopens on the connector the user just authorized.
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

  // Visibility uses the UNQUERIED attention count, so typing cannot make the
  // tab the user is standing on disappear; the badge uses the queried count,
  // which is what the rows below actually show.
  const attentionTotal = useMemo(
    () => filterConnectors(connectors, { scope: 'attention', query: '' }).length,
    [connectors],
  );

  // Browse exists only where `connectors_api_discover` is on; Needs attention
  // only while something is unhealthy — an always-visible zero-count filter is
  // noise.
  const visibleScopes: ConnectorScope[] = useMemo(
    () => [
      'project',
      ...(browseEnabled ? (['browse'] as const) : []),
      ...(attentionTotal > 0 ? (['attention'] as const) : []),
    ],
    [browseEnabled, attentionTotal],
  );

  // Both queries feed the default scope: the connector list decides
  // project-vs-browse, and the flag decides whether Browse exists at all.
  // Until both land, the filter row renders nothing (into a reserved 28px
  // slot) rather than showing a tab that is about to change under the user.
  const settled = !connectorsQuery.isLoading && !projectQuery.isLoading;
  const rawScope = scopeChoice ?? defaultConnectorScope(connectors, { browseEnabled });
  // A chosen scope can outlive the tab it belongs to: the flag can go off, and
  // fixing the last unhealthy connector removes Needs attention while the user
  // is standing on it. Unclamped, `Tabs` would show no active trigger and the
  // grid would tell a project full of healthy connectors that it has none.
  const scope: ConnectorScope = visibleScopes.includes(rawScope) ? rawScope : 'project';

  const filtered = useMemo(
    () => filterConnectors(connectors, { scope, query }),
    [connectors, scope, query],
  );
  const counts = useMemo(
    () => ({
      project: filterConnectors(connectors, { scope: 'project', query }).length,
      attention: filterConnectors(connectors, { scope: 'attention', query }).length,
    }),
    [connectors, query],
  );

  const browse = useDiscoverBrowse(projectId, query, browseEnabled && scope === 'browse');

  // Looked up against the unfiltered list, never `filtered` — searching or
  // switching scope while the modal is open must not yank it shut.
  const selectedConnector = useMemo(
    () => connectors.find((c) => c.slug === detailSlug) ?? null,
    [connectors, detailSlug],
  );

  // Per-scope total, so "nothing matched" is never reported as "you have
  // none". Browse runs its own equivalent inside `ConnectorBrowse`.
  //
  // Because the total is measured in the SAME scope with an empty query,
  // `'no-match'` can only arise from the search box — a scope with nothing in
  // it reports `'empty'`. The no-match copy below therefore always has a query
  // to echo.
  const scopeTotal = useMemo(
    () => filterConnectors(connectors, { scope, query: '' }).length,
    [connectors, scope],
  );
  const emptyKind = catalogEmptyKind(scopeTotal, filtered.length);

  return (
    <CapabilityPageShell
      title="Connectors"
      description="Give agents access to outside tools and data."
      action={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setPanel('rules')}>
            <ShieldCheckIcon className="size-4" />
            Global rules
          </Button>
          {canWrite ? (
            <Button size="sm" variant="secondary" onClick={() => setPanel('add')}>
              <PlusIcon className="size-4" />
              Add connector
            </Button>
          ) : null}
        </div>
      }
      search={
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search connectors"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            variant="popover"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
      }
      filters={
        <>
          {/* `min-h-7` matches `TabsListCompact`, so the row keeps its height
              while the two queries resolve and the tabs appear without
              nudging the grid below them. */}
          <div className="min-h-7">
            {settled ? (
              <Tabs
                value={scope}
                onValueChange={(value) => setScopeChoice(value as ConnectorScope)}
              >
                <TabsListCompact>
                  {visibleScopes.map((value) => (
                    <TabsTriggerCompact key={value} value={value}>
                      {SCOPE_LABEL[value]}
                      {/* No count on Browse: the catalog is paged, so any
                          number here would describe the pages loaded so far
                          rather than the catalog. */}
                      {value === 'browse' ? null : (
                        <Badge variant="secondary" size="sm">
                          {counts[value]}
                        </Badge>
                      )}
                    </TabsTriggerCompact>
                  ))}
                </TabsListCompact>
              </Tabs>
            ) : null}
          </div>
          {/* Hidden during a catalog search: the search is server-side across
              every category, so `ConnectorBrowse` ignores the category while
              one is running. Leaving the control on screen showing "Design"
              over results that are not filtered to Design would be a lie. */}
          {scope === 'browse' && browse.activeQuery.length === 0 ? (
            <CategorySelect groups={browse.groups} value={category} onChange={setCategory} />
          ) : null}
        </>
      }
    >
      {scope === 'browse' ? (
        <ConnectorBrowse
          state={browse}
          category={category}
          onCategoryChange={setCategory}
          onSelect={setBrowseTarget}
        />
      ) : (
        <CatalogGrid
          // `!settled`, not `connectorsQuery.isLoading`: the empty state's
          // wording and the scope it describes both depend on `projectQuery`
          // too. Gating on the connector list alone let a flagged project with
          // no connectors flash "No connectors yet" for one render before the
          // flag arrived and moved it to Browse. Same gate as the filter row.
          isLoading={!settled}
          isError={connectorsQuery.isError}
          onRetry={() => connectorsQuery.refetch()}
          isEmpty={emptyKind !== null}
          empty={
            emptyKind === 'no-match' ? (
              // The scope is deliberately not named here — "in In project"
              // does not read as English, and the per-scope counts on the tabs
              // above already show the user which scope does have a hit.
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                No matches for <span className="text-foreground font-mono">{query.trim()}</span>.
              </p>
            ) : (
              <EmptyState
                icon={PlugIcon}
                size="sm"
                title="No connectors yet"
                description="Connect an outside tool and your agents can use it in a session."
                action={
                  canWrite ? (
                    <Button size="sm" variant="secondary" onClick={() => setPanel('add')}>
                      <PlusIcon className="size-4" />
                      Add connector
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
              // `size="lg"` is `size-10 rounded-md`, where `CatalogCard`
              // documents its leading slot as a `size-9 rounded-sm` tile (what
              // Skills and Commands pass). Reusing the shipped
              // `ConnectorAppIcon` verbatim wins that trade: a connector's logo
              // then looks identical here, in its own modal, and everywhere
              // else in the product, and the component takes no other size
              // between `size-6` and this. Card height is unaffected — the text
              // column (55.68px) is what drives `CATALOG_CARD_HEIGHT_CLASSNAME`,
              // not a 36.8px tile.
              leading={<ConnectorAppIcon connector={connector} size="lg" />}
              title={connector.name?.trim() || connector.slug}
              description={connectorSummary(connector, providerLabel(connector.provider))}
              badges={<ConnectorStatusBadge connector={connector} />}
              onClick={() => setDetailSlug(connector.slug)}
            />
          ))}
        </CatalogGrid>
      )}

      <DiscoverAddFlow
        projectId={projectId}
        integration={browseTarget}
        existingSlugs={existingSlugs}
        canWrite={canWrite}
        onClose={() => setBrowseTarget(null)}
        onAdded={(slug) => {
          setBrowseTarget(null);
          invalidate();
          setScopeChoice('project');
          setDetailSlug(slug);
        }}
      />

      <Modal open={panel === 'rules'} onOpenChange={(open) => !open && setPanel(null)}>
        <ModalContent className="lg:max-w-3xl">
          <ModalHeader>
            <ModalTitle>Global rules</ModalTitle>
            <ModalDescription>
              Permissions that apply to every connector in this project.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="max-h-[70vh] overflow-y-auto">
            <PoliciesPanel projectId={projectId} />
          </ModalBody>
        </ModalContent>
      </Modal>

      <Modal open={panel === 'add'} onOpenChange={(open) => !open && setPanel(null)}>
        {/* `AddAppPanel` prints its own "Add a connector" heading, so the
            dialog's required accessible name is supplied out of view rather
            than as a second visible title. `aria-describedby={undefined}` is
            Radix's documented opt-out for a dialog with no description.
            See `hiddenTitle` above for why this is `VisuallyHidden asChild`
            and not an `sr-only` class. */}
        <ModalContent className="lg:max-w-4xl" aria-describedby={undefined}>
          <ModalBody className="max-h-[75vh] space-y-0 overflow-y-auto p-0">
            <VisuallyHidden asChild>
              <ModalTitle>Add a connector</ModalTitle>
            </VisuallyHidden>
            <AddAppPanel
              projectId={projectId}
              emailChannelEnabled={emailChannelEnabled}
              discoverEnabled={browseEnabled}
              existingSlugs={existingSlugs}
              canWrite={canWrite}
              onAdded={(slug) => {
                invalidate();
                if (slug) {
                  setPanel(null);
                  setScopeChoice('project');
                  setDetailSlug(slug);
                }
              }}
            />
          </ModalBody>
        </ModalContent>
      </Modal>

      <Modal
        open={selectedConnector !== null}
        onOpenChange={(open) => !open && setDetailSlug(null)}
      >
        {/* Same treatment as the Add modal: `ConnectorDetail` renders the
            connector's name as its own (editable) heading. */}
        <ModalContent className="lg:max-w-3xl" aria-describedby={undefined}>
          <ModalBody className="max-h-[75vh] space-y-0 overflow-y-auto p-0">
            <VisuallyHidden asChild>
              <ModalTitle>{selectedConnector?.name?.trim() || 'Connector'}</ModalTitle>
            </VisuallyHidden>
            {selectedConnector ? (
              <ConnectorDetail
                key={selectedConnector.slug}
                projectId={projectId}
                connector={selectedConnector}
                canWrite={canWrite}
                onChanged={invalidate}
                onRemoved={() => {
                  invalidate();
                  setDetailSlug(null);
                }}
              />
            ) : null}
          </ModalBody>
        </ModalContent>
      </Modal>
    </CapabilityPageShell>
  );
}

'use client';

import { PackageSearch, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { useAddMarketplaceSource, useFeaturedMarketplaces } from '@/hooks/marketplace';
import { AddMarketplaceModal } from './add-marketplace-modal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { MarketplaceAvatar } from '@/features/marketplace/marketplace-avatar';
import { displayCompanyLabel } from '@/features/marketplace/marketplace-company-filter';
import { MarketplaceExploreCard } from '@/features/marketplace/marketplace-explore-card';
import { MarketplacePagedGrid } from '@/features/marketplace/marketplace-paged-grid';
import { MarketplaceProjectsGrid } from '@/features/marketplace/marketplace-projects-grid';
import {
  defaultProjectMarketplaceItems,
  type MarketplaceItem,
  type MarketplaceSummary,
} from '@/lib/marketplace-client';
import { companyIdFromSlug, marketplaceSourceHref } from '@/lib/marketplace-slug';
import { cn } from '@/lib/utils';
import {
  MARKETPLACE_GRID_COLUMNS,
  resolveMarketplaceTypeSectionTotal,
  shouldOfferMarketplaceSeeAll,
  sumMarketplaceTypeCounts,
} from './marketplace-grid';
import { typeMeta } from './marketplace-meta';
import { MarketplaceShell, type MarketplaceCrumb } from './marketplace-shell';

// Only skills are browseable alongside Projects today (agents/commands/
// bundles are hidden from browse — see MARKETPLACE_VISIBLE_TYPES on the API).
const TYPE_ORDER = ['registry:skill'];

const FEATURED_ID = 'featured';
const PREVIEW_COUNT = 9;
const SEARCH_GRID_COLUMNS = 2;

const ALL_SOURCES = 'all';

function sectionId(type: string): string {
  return `type-${type.replace('registry:', '')}`;
}

function pluralize(label: string): string {
  return label.endsWith('s') ? label : `${label}s`;
}

function pickFeatured(items: MarketplaceItem[]): MarketplaceItem[] {
  const curated = defaultProjectMarketplaceItems(items);
  if (curated.length) return curated.slice(0, 8);
  const kortix = items.filter((i) => i.marketplaceId === 'kortix');
  return (kortix.length ? kortix : items).slice(0, 8);
}

function SectionHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-4 space-y-1">
      <h2 className="text-foreground text-xl font-medium tracking-tight text-balance">{title}</h2>
      {subtitle ? (
        <p className="text-muted-foreground text-sm leading-relaxed text-pretty">{subtitle}</p>
      ) : null}
    </div>
  );
}

/** One row in the left-rail source filter. */
function SourceRow({
  label,
  count,
  active,
  avatar,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  avatar?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-sm transition-colors',
        active
          ? 'bg-primary/[0.06] text-foreground font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
      )}
    >
      {avatar ? <span className="shrink-0">{avatar}</span> : null}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined ? (
        <span className="text-muted-foreground/60 shrink-0 text-xs tabular-nums">{count}</span>
      ) : null}
    </button>
  );
}

/** A not-yet-enabled source in the rail — one click activates it and its items
 *  join the catalog. */
function FeaturedSourceRow({
  label,
  avatar,
  busy,
  onEnable,
}: {
  label: string;
  avatar?: React.ReactNode;
  busy: boolean;
  onEnable: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onEnable}
      disabled={busy}
      className="group text-muted-foreground hover:text-foreground hover:bg-foreground/5 flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-sm transition-colors disabled:opacity-60"
    >
      {avatar ? <span className="shrink-0 opacity-70 grayscale group-hover:opacity-100 group-hover:grayscale-0">{avatar}</span> : null}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="text-muted-foreground/60 group-hover:text-foreground shrink-0">
        {busy ? <Loading className="size-3.5" /> : <Plus className="size-3.5" />}
      </span>
    </button>
  );
}

function ExploreSection({
  id,
  title,
  items,
  type,
  total,
  publicOnly,
  scrollContainerRef,
  initial = PREVIEW_COUNT,
}: {
  id: string;
  title: string;
  items: MarketplaceItem[];
  type?: string;
  total?: number;
  publicOnly: boolean;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  initial?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = items.slice(0, initial);
  const effectiveTotal = total ?? items.length;
  const canExpand = shouldOfferMarketplaceSeeAll({
    hasPagedView: !!type,
    renderedCount: visible.length,
    total: effectiveTotal,
  });

  return (
    <section id={id} className="scroll-mt-28">
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-foreground text-lg font-medium tracking-tight text-balance">{title}</h2>
        {canExpand ? (
          <Button
            variant="transparent"
            size="sm"
            className="shrink-0"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : `See all ${effectiveTotal}`}
          </Button>
        ) : null}
      </div>
      {expanded && type ? (
        <MarketplacePagedGrid
          type={type}
          publicOnly={publicOnly}
          scrollContainerRef={scrollContainerRef}
          columns={MARKETPLACE_GRID_COLUMNS}
          gridClassName="sm:grid-cols-3"
          emptyTitle="No matches"
          emptyDescription="No items match this type right now."
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          {visible.map((item) => (
            <MarketplaceExploreCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </section>
  );
}

export function MarketplaceExplore({
  items: catalogItems,
  marketplaces,
  projectItems,
  embedded = false,
  syncUrl = true,
  publicOnly = true,
  scrollContainerRef,
}: {
  /** SSR-bounded first page of the catalog (all sources) — feeds the
   *  "All sources" sectioned preview + Featured rail. */
  items: MarketplaceItem[];
  marketplaces: MarketplaceSummary[];
  /** Every `registry:project` item, server-rendered (not client-fetched) so
   *  the Projects showcase is fully indexed/static. */
  projectItems: MarketplaceItem[];
  /** Render inside a panel (Customize tab) — drops the marketing page chrome. */
  embedded?: boolean;
  /** Mirror the source filter to the URL (`?source=`). Off when embedded. */
  syncUrl?: boolean;
  /** Unauthenticated catalog reads (public). Off for the in-project view. */
  publicOnly?: boolean;
  /** Ancestor scroll element to virtualize the grids against (in-project). */
  scrollContainerRef?: RefObject<HTMLElement | null>;
}) {
  // Source filter lives in the left rail — one surface, filtered in place. On
  // the public page ('all') stays fully SSR'd and a deep-linked `?source=` is
  // picked up after hydration; embedded (Customize) keeps it purely local.
  const [source, setSource] = useState<string>(ALL_SOURCES);

  useEffect(() => {
    if (!syncUrl) return;
    const slug = new URLSearchParams(window.location.search).get('source');
    if (slug) setSource(companyIdFromSlug(slug));
  }, [syncUrl]);

  const selectSource = useCallback(
    (id: string) => {
      setSource(id);
      if (syncUrl) {
        window.history.replaceState(null, '', marketplaceSourceHref(id));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        scrollContainerRef?.current?.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [syncUrl, scrollContainerRef],
  );

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // "Other sources" you can activate — featured registries not yet enabled on
  // this account, plus a custom "Add a source" flow. Authenticated surface only
  // (the public marketing page stays browse-only).
  const canManageSources = !publicOnly;
  const featuredQuery = useFeaturedMarketplaces({ enabled: canManageSources });
  const addSource = useAddMarketplaceSource();
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [enabling, setEnabling] = useState<string | null>(null);
  const featuredSources = useMemo(() => {
    if (!canManageSources) return [];
    const seen = new Set<string>();
    return (featuredQuery.data ?? []).filter((f) => {
      if (f.added || seen.has(f.address)) return false;
      seen.add(f.address);
      return true;
    });
  }, [canManageSources, featuredQuery.data]);

  const onEnableSource = useCallback(
    (address: string, label: string) => {
      setEnabling(address);
      addSource
        .mutateAsync({ address, label })
        .then(
          () =>
            successToast(`Enabled ${label}`, {
              description: 'Its items now appear in the catalog.',
            }),
          (e) => errorToast('Could not enable', { description: (e as Error).message }),
        )
        .finally(() => setEnabling(null));
    },
    [addSource],
  );

  const searching = debounced.length > 0;
  const isAll = source === ALL_SOURCES;
  const showProjects = !searching && (isAll || source === 'kortix');
  const sourceLabel = isAll
    ? null
    : displayCompanyLabel(source, marketplaces.find((m) => m.id === source)?.label);

  const componentItems = useMemo(
    () => catalogItems.filter((it) => it.type !== 'registry:project'),
    [catalogItems],
  );
  const featured = useMemo(() => pickFeatured(componentItems), [componentItems]);
  const typeCounts = useMemo(() => sumMarketplaceTypeCounts(marketplaces), [marketplaces]);

  const groups = useMemo(() => {
    const byType = new Map<string, MarketplaceItem[]>();
    for (const it of componentItems) {
      const arr = byType.get(it.type) ?? [];
      arr.push(it);
      byType.set(it.type, arr);
    }
    return [...byType.keys()]
      .sort((a, b) => {
        const ia = TYPE_ORDER.indexOf(a);
        const ib = TYPE_ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
      })
      .map((type) => {
        const items = byType.get(type)!;
        return {
          type,
          label: pluralize(typeMeta(type).label),
          items,
          total: resolveMarketplaceTypeSectionTotal(type, typeCounts, items.length),
        };
      });
  }, [componentItems, typeCounts]);

  // Embedded: the fixed top bar already says "Marketplace", so the lone
  // "Marketplace" crumb on the all-sources view is redundant — drop it. A
  // selected source still gets a crumb for the back-to-all affordance.
  const crumbs: MarketplaceCrumb[] = isAll
    ? embedded
      ? []
      : [{ label: 'Marketplace' }]
    : [
        embedded
          ? { label: 'Marketplace', onClick: () => selectSource(ALL_SOURCES) }
          : { label: 'Marketplace', href: '/marketplace' },
        { label: sourceLabel ?? source },
      ];

  return (
    <MarketplaceShell
      embedded={embedded}
      scrollRef={scrollContainerRef}
      crumbs={crumbs}
      sidebar={
        <>
          <div className="space-y-2">
            <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
              Clone a project, or add a skill
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
              Start from a full, working Kortix project in one click — or add skills from every
              source into a project you already have.
            </p>
          </div>

          <InputGroupSearch>
            <InputGroupSearchIcon>
              <Search />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder="Search the marketplace"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              variant="popover"
            />
            <InputGroupSearchClear onClick={() => setQuery('')} />
          </InputGroupSearch>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 px-2.5 pb-1">
              <div className="text-muted-foreground/70 text-xs font-medium tracking-wide uppercase">
                Sources
              </div>
              {canManageSources ? (
                <button
                  type="button"
                  onClick={() => setAddSourceOpen(true)}
                  className="text-muted-foreground/70 hover:text-foreground -mr-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-medium transition-colors"
                >
                  <Plus className="size-3.5 shrink-0" />
                  Add
                </button>
              ) : null}
            </div>
            <SourceRow
              label="All sources"
              active={isAll}
              onClick={() => selectSource(ALL_SOURCES)}
            />
            {marketplaces.map((m) => (
              <SourceRow
                key={m.id}
                label={displayCompanyLabel(m.id, m.label)}
                count={m.count}
                active={source === m.id}
                avatar={
                  <MarketplaceAvatar
                    id={m.id}
                    owner={m.owner}
                    sourceUrl={m.sourceUrl}
                    label={m.label}
                    size="xs"
                  />
                }
                onClick={() => selectSource(m.id)}
              />
            ))}

            {canManageSources && featuredSources.length > 0 ? (
              <>
                <div className="text-muted-foreground/70 px-2.5 pt-3 pb-1 text-xs font-medium tracking-wide uppercase">
                  Add sources
                </div>
                {featuredSources.map((f) => (
                  <FeaturedSourceRow
                    key={f.address}
                    label={displayCompanyLabel(f.address, f.label)}
                    busy={enabling === f.address}
                    avatar={
                      <MarketplaceAvatar id={f.address} owner={f.owner} label={f.label} size="xs" />
                    }
                    onEnable={() => onEnableSource(f.address, f.label)}
                  />
                ))}
              </>
            ) : null}
          </div>

          {canManageSources ? (
            <AddMarketplaceModal open={addSourceOpen} onOpenChange={setAddSourceOpen} />
          ) : null}
        </>
      }
    >
      <div className="space-y-16">
        {showProjects ? (
          <section className="scroll-mt-28">
            <SectionHeading
              title="Clone a project"
              subtitle="A full, working Kortix project — cloned into your account, ready in one session."
            />
            <MarketplaceProjectsGrid items={projectItems} query={debounced} size="featured" />
          </section>
        ) : null}

        <div className="space-y-12">
          <SectionHeading
            title={sourceLabel ?? 'Skills'}
            subtitle="Add these into a project you already have."
          />

          {searching ? (
            <MarketplacePagedGrid
              query={debounced}
              source={isAll ? undefined : source}
              publicOnly={publicOnly}
              scrollContainerRef={scrollContainerRef}
              columns={SEARCH_GRID_COLUMNS}
              gridClassName="sm:grid-cols-2"
              showSource={isAll}
              emptyTitle="No matches"
              emptyDescription={`No items match "${debounced}".`}
              emptyAction={
                <Button variant="outline" size="sm" onClick={() => setQuery('')}>
                  Clear search
                </Button>
              }
              header={({ total }) => (
                <div className="text-muted-foreground text-sm">
                  <span className="tabular-nums">{total}</span> {total === 1 ? 'result' : 'results'}{' '}
                  for &ldquo;{debounced}&rdquo;
                </div>
              )}
            />
          ) : isAll ? (
            componentItems.length === 0 ? (
              <EmptyState
                icon={PackageSearch}
                title="Nothing here yet"
                description="The catalog is empty right now — check back soon."
              />
            ) : (
              <div className="space-y-12">
                <ExploreSection
                  id={FEATURED_ID}
                  title="Featured"
                  items={featured}
                  initial={8}
                  publicOnly={publicOnly}
                  scrollContainerRef={scrollContainerRef}
                />
                {groups.map((g) => (
                  <ExploreSection
                    key={g.type}
                    id={sectionId(g.type)}
                    title={g.label}
                    items={g.items}
                    type={g.type}
                    total={g.total}
                    publicOnly={publicOnly}
                    scrollContainerRef={scrollContainerRef}
                  />
                ))}
              </div>
            )
          ) : (
            <MarketplacePagedGrid
              source={source}
              publicOnly={publicOnly}
              scrollContainerRef={scrollContainerRef}
              columns={SEARCH_GRID_COLUMNS}
              gridClassName="sm:grid-cols-2"
              showSource={false}
              emptyTitle="Nothing here yet"
              emptyDescription="This source has no browseable items right now."
              emptyAction={
                <Button variant="outline" size="sm" onClick={() => selectSource(ALL_SOURCES)}>
                  Browse all sources
                </Button>
              }
            />
          )}
        </div>
      </div>
    </MarketplaceShell>
  );
}

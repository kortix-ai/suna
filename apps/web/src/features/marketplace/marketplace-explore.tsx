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
import { AddMarketplaceModal } from './add-marketplace-modal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { MarketplaceAvatar } from '@/features/marketplace/marketplace-avatar';
import { displayCompanyLabel } from '@/features/marketplace/marketplace-company-filter';
import { MarketplacePagedGrid } from '@/features/marketplace/marketplace-paged-grid';
import { MarketplaceProjectsGrid } from '@/features/marketplace/marketplace-projects-grid';
import { type MarketplaceItem, type MarketplaceSummary } from '@/lib/marketplace-client';
import { companyIdFromSlug, marketplaceSourceHref } from '@/lib/marketplace-slug';
import { cn } from '@/lib/utils';
import {
  MARKETPLACE_GRID_COLUMNS,
  resolveMarketplaceTypeSectionTotal,
  sumMarketplaceTypeCounts,
} from './marketplace-grid';
import { typeMeta } from './marketplace-meta';
import { MarketplaceShell, type MarketplaceCrumb } from './marketplace-shell';

// Only skills are browseable alongside Projects today (agents/commands/
// bundles are hidden from browse — see MARKETPLACE_VISIBLE_TYPES on the API).
const TYPE_ORDER = ['registry:skill'];

const ALL_SOURCES = 'all';

function sectionId(type: string): string {
  return `type-${type.replace('registry:', '')}`;
}

function pluralize(label: string): string {
  return label.endsWith('s') ? label : `${label}s`;
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

  // Adding/activating sources is an authenticated action — the public marketing
  // page stays browse-only. The featured list + custom git URL live in the
  // "Add a source" modal so the rail stays short (just enabled sources).
  const canManageSources = !publicOnly;
  const [addSourceOpen, setAddSourceOpen] = useState(false);

  const searching = debounced.length > 0;
  const isAll = source === ALL_SOURCES;
  const showProjects = !searching && (isAll || source === 'kortix');
  const sourceLabel = isAll
    ? null
    : displayCompanyLabel(source, marketplaces.find((m) => m.id === source)?.label);

  // Hide items that ship inside a project (e.g. the Kortix Starter skills) from
  // the main grid — the project represents them here. They stay fully browseable
  // by id and addable individually (project detail, add-to-project), just not as
  // their own tiles on the landing grid.
  const componentItems = useMemo(
    () => catalogItems.filter((it) => it.type !== 'registry:project' && !it.partOfProject),
    [catalogItems],
  );
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
              Install a project, or add a skill
            </h1>
            <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
              Install a full, working Kortix project in one click — or add skills from every source
              into a project you already have.
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
              title="Install a project"
              subtitle="A full, working Kortix project — spun up as its own project and set up for you in one session."
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
              columns={MARKETPLACE_GRID_COLUMNS}
              gridClassName="sm:grid-cols-3"
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
              // Show the whole catalog at once — one virtualized, scrollable grid
              // per type. Single type (skills) → no redundant per-type heading
              // (the "Skills" section heading above already names it).
              <div className="space-y-12">
                {groups.map((g) => (
                  <section key={g.type} id={sectionId(g.type)} className="scroll-mt-28">
                    {groups.length > 1 ? (
                      <h2 className="text-foreground mb-3 text-lg font-medium tracking-tight text-balance">
                        {g.label}
                      </h2>
                    ) : null}
                    <MarketplacePagedGrid
                      type={g.type}
                      publicOnly={publicOnly}
                      scrollContainerRef={scrollContainerRef}
                      columns={MARKETPLACE_GRID_COLUMNS}
                      gridClassName="sm:grid-cols-3"
                      emptyTitle="Nothing here yet"
                      emptyDescription="The catalog is empty right now — check back soon."
                    />
                  </section>
                ))}
              </div>
            )
          ) : (
            <MarketplacePagedGrid
              source={source}
              publicOnly={publicOnly}
              scrollContainerRef={scrollContainerRef}
              columns={MARKETPLACE_GRID_COLUMNS}
              gridClassName="sm:grid-cols-3"
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

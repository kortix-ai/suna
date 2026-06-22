'use client';

import { ExternalLink, Loader2, PackageSearch, Plus, Search, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import {
  useMarketplaceItems,
  useMarketplaces,
  useMarketplaceSources,
  useRemoveMarketplaceSource,
} from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { AddMarketplaceDialog } from './add-marketplace-dialog';
import { MarketplaceAvatar } from './marketplace-avatar';
import { MarketplaceItemCard } from './marketplace-item-card';
import { TYPE_FILTERS, TYPE_SECTIONS } from './marketplace-meta';

/** Search + adaptive type filters + a source switcher + a card grid (grouped by
 *  type when browsing everything). Selecting a card opens its detail as a full
 *  in-place page (not a slide-out). Shared by the top-level /marketplace page
 *  and the in-project surface. Type filters/sections are adaptive — only types
 *  that actually have items show up, so a skills-only catalog stays clean. */
export function MarketplaceBrowser({
  onAdd,
  installedNames,
  source: sourceProp,
  onSourceChange,
}: {
  onAdd: (item: MarketplaceItem) => void;
  installedNames?: Set<string>;
  /** Controlled source filter (defaults to internal state). */
  source?: string;
  onSourceChange?: (source: string) => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState('all');
  const [sourceInternal, setSourceInternal] = useState('all');
  const source = sourceProp ?? sourceInternal;
  const setSource = onSourceChange ?? setSourceInternal;
  const [addOpen, setAddOpen] = useState(false);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);

  const marketplacesQuery = useMarketplaces();
  const marketplaces = useMemo(
    () => marketplacesQuery.data?.marketplaces ?? [],
    [marketplacesQuery.data],
  );
  // Sources still resolving (cold load) that aren't yet a ready facet — shown as
  // spinner pills next to the real source pills.
  const pendingSources = useMemo(() => {
    const readyIds = new Set(marketplaces.map((m) => m.id));
    return (marketplacesQuery.data?.sources ?? []).filter((s) => !readyIds.has(s.id));
  }, [marketplacesQuery.data, marketplaces]);
  const total = marketplaces.reduce((s, m) => s + m.count, 0);

  const sources = useMarketplaceSources().data ?? [];
  const removeSource = useRemoveMarketplaceSource();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Adaptive type tabs — derive the per-type counts from the source facets so we
  // only ever show filters that resolve to real items (in the current source).
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const list = source === 'all' ? marketplaces : marketplaces.filter((m) => m.id === source);
    for (const m of list)
      for (const [k, v] of Object.entries(m.types ?? {})) counts[k] = (counts[k] ?? 0) + v;
    return counts;
  }, [marketplaces, source]);

  const typeTabs = useMemo(
    () => TYPE_FILTERS.filter((f) => f.value === 'all' || (typeCounts[f.value] ?? 0) > 0),
    [typeCounts],
  );
  const effectiveType = typeTabs.some((t) => t.value === type) ? type : 'all';
  const showTypeTabs = typeTabs.length > 1;

  const itemsQuery = useMarketplaceItems({ query: debounced, type: effectiveType, source });
  const items = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);
  const grouped = effectiveType === 'all' && !debounced;
  // Catalog still streaming external sources in (cold first load).
  const streaming = !!(itemsQuery.data?.loading || marketplacesQuery.data?.loading);

  const sections = useMemo(() => {
    const byLabel = new Map<string, MarketplaceItem[]>();
    for (const it of items) {
      const label = TYPE_SECTIONS.find((s) => s.type === it.type)?.label ?? 'Other';
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push(it);
    }
    // Preserve the canonical section order from TYPE_SECTIONS, then any extras.
    const order = [...new Set(TYPE_SECTIONS.map((s) => s.label)), 'Other'];
    return [...byLabel.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([label, list]) => ({ label, items: list }));
  }, [items]);

  const selected = source === 'all' ? null : marketplaces.find((m) => m.id === source);
  const ghUrl = selected?.sourceUrl;
  // Exact match on the source id the API hands us — ref/subdir/name-proof.
  const removableId =
    selected?.sourceId && sources.some((s) => s.id === selected.sourceId)
      ? selected.sourceId
      : null;

  const onRemoveSource = () => {
    if (!removableId) return;
    removeSource
      .mutateAsync(removableId)
      .then(() => setSource('all'))
      .catch((e) => errorToast('Could not remove', { description: (e as Error).message }));
  };

  const renderCard = (item: MarketplaceItem) => (
    <MarketplaceItemCard
      key={item.id}
      item={item}
      installed={installedNames?.has(item.name)}
      showSource={source === 'all'}
      onOpen={(it) => openItem(it.id)}
      onAdd={onAdd}
    />
  );

  const pills = [
    { id: 'all', label: 'All sources', count: total, types: {}, external: false },
    ...marketplaces,
  ];

  return (
    <div className="space-y-4">
      {/* Search + type filters + add */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrPlaceholderSearchTheMarketplace188bc1ee',
            )}
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2">
          {showTypeTabs && (
            <FilterBar className="overflow-x-auto">
              {typeTabs.map((f) => (
                <FilterBarItem
                  key={f.value}
                  data-state={effectiveType === f.value ? 'active' : 'inactive'}
                  onClick={() => setType(f.value)}
                >
                  {f.label}
                  {f.value !== 'all' && (
                    <span className="text-muted-foreground/50 ml-1 tabular-nums">
                      {typeCounts[f.value]}
                    </span>
                  )}
                </FilterBarItem>
              ))}
            </FilterBar>
          )}
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxTextAddSource8387392e',
            )}
          </Button>
        </div>
      </div>

      {/* Source switcher — browse by source */}
      <div className="-mx-0.5 flex items-center gap-1.5 overflow-x-auto px-0.5 pb-1">
        {pills.map((m) => (
          <button
            key={m.id}
            type="button"
            aria-pressed={source === m.id}
            onClick={() => setSource(m.id)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
              source === m.id
                ? 'border-foreground/20 bg-foreground/[0.06] text-foreground font-medium'
                : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-foreground/20',
            )}
          >
            {m.id !== 'all' && (
              <MarketplaceAvatar
                id={m.id}
                owner={m.owner}
                sourceUrl={m.sourceUrl}
                label={m.label}
                size="xs"
              />
            )}
            {m.label}
            <span className="text-muted-foreground/50 tabular-nums">{m.count}</span>
          </button>
        ))}
        {/* Sources still resolving on a cold load — a spinner pill each, until it
            lands and flips into a real (clickable, counted) source pill above. */}
        {pendingSources.map((s) => (
          <span
            key={`pending-${s.id}`}
            title={`Loading ${s.label}…`}
            className="border-border/60 text-muted-foreground/70 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dashed px-3 py-1.5 text-xs"
          >
            <MarketplaceAvatar
              id={s.id}
              owner={s.owner}
              sourceUrl={s.sourceUrl}
              label={s.label}
              size="xs"
            />
            {s.label}
            <Loader2 className="size-3 animate-spin" />
          </span>
        ))}
      </div>

      {/* Selected external source — provenance + remove */}
      {selected?.external && (
        <div className="border-border/60 bg-muted/20 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <MarketplaceAvatar
              id={selected.id}
              owner={selected.owner}
              sourceUrl={selected.sourceUrl}
              label={selected.label}
              size="sm"
              className="shrink-0"
            />
            <span className="text-foreground truncate font-medium">{selected.label}</span>
            <span className="text-muted-foreground/60 shrink-0 text-xs">
              {selected.count} items
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {ghUrl && (
              <a
                href={ghUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors"
              >
                GitHub
                <ExternalLink className="size-3" />
              </a>
            )}
            {removableId && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                disabled={removeSource.isPending}
                onClick={onRemoveSource}
              >
                <Trash2 className="size-3.5" />
                Remove
              </Button>
            )}
          </div>
        </div>
      )}

      {itemsQuery.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-2xl" />
          ))}
        </div>
      ) : itemsQuery.isError ? (
        <EmptyState
          icon={PackageSearch}
          title={tI18nHardcoded.raw(
            'autoComponentsMarketplaceMarketplaceBrowserJsxAttrTitleCouldnTLoad660e12ab',
          )}
          description={(itemsQuery.error as Error)?.message ?? 'Something went wrong.'}
          action={
            <Button variant="outline" size="sm" onClick={() => itemsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : items.length === 0 ? (
        streaming ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-2xl" />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={PackageSearch}
            title={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrTitleNothingMatches64177fc9',
            )}
            description={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrDescriptionTryADifferentdd8061ac',
            )}
          />
        )
      ) : grouped && sections.length > 1 ? (
        <div className="space-y-6">
          {sections.map((section) => (
            <div key={section.label}>
              <h2 className="text-foreground mb-2.5 text-sm font-semibold">
                {section.label}{' '}
                <span className="text-muted-foreground/60 font-normal">{section.items.length}</span>
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">{section.items.map(renderCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">{items.map(renderCard)}</div>
      )}

      {streaming && items.length > 0 && (
        <div className="text-muted-foreground/70 flex items-center justify-center gap-2 py-1 text-xs">
          <Loader2 className="size-3.5 animate-spin" />
          {tI18nHardcoded.raw(
            'autoComponentsMarketplaceMarketplaceBrowserJsxTextLoadingMoreSourcese06aa650',
          )}
        </div>
      )}

      <AddMarketplaceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

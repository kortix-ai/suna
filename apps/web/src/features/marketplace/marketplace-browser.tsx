'use client';

import { ExternalLink, PackageSearch, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InlineMeta } from '@/components/ui/inline-meta';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  useMarketplaceItems,
  useMarketplaces,
  useMarketplaceSources,
  useRemoveMarketplaceSource,
} from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { Search, TrashSolid } from '@mynaui/icons-react';
import Link from 'next/link';
import { Label } from '../../components/ui/label';
import Loading from '../../components/ui/loading';
import { AddMarketplaceModal } from './add-marketplace-modal';
import { MarketplaceAvatar } from './marketplace-avatar';
import { MarketplaceItemCard } from './marketplace-item-card';
import { TYPE_FILTERS, TYPE_SECTIONS } from './marketplace-meta';

const TYPE_ORDER = ['skill', 'agent', 'command', 'tool'];
function typeBreakdown(types: Record<string, number>): string {
  return TYPE_ORDER.filter((t) => types[t])
    .map((t) => `${types[t]} ${types[t] === 1 ? t : `${t}s`}`)
    .join(' · ');
}

export function MarketplaceBrowser({
  onAdd,
  installedNames,
  source: sourceProp,
  onSourceChange,
}: {
  onAdd: (item: MarketplaceItem) => void;
  installedNames?: Set<string>;
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
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);

  const marketplacesQuery = useMarketplaces();
  const marketplaces = useMemo(
    () => marketplacesQuery.data?.marketplaces ?? [],
    [marketplacesQuery.data],
  );

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
      .then(() => {
        setRemoveConfirmOpen(false);
        setSource('all');
      })
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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InputGroupSearch className="w-full sm:max-w-xs">
          <InputGroupSearchIcon>
            <Search />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrPlaceholderSearchTheMarketplace188bc1ee',
            )}
            variant="popover"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
        <div className="flex items-center gap-2">
          {showTypeTabs && (
            <Tabs value={effectiveType} onValueChange={setType} className="gap-0">
              <TabsListCompact className="max-w-full overflow-x-auto">
                {typeTabs.map((f) => (
                  <TabsTriggerCompact key={f.value} value={f.value}>
                    {f.label}
                  </TabsTriggerCompact>
                ))}
              </TabsListCompact>
            </Tabs>
          )}
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxTextAddSource8387392e',
            )}
          </Button>
        </div>
      </div>

      <Tabs value={source} onValueChange={setSource} className="gap-0">
        <div className="flex items-center gap-2">
          <TabsListCompact className="w-fit shrink-0">
            {pills.map((m) => (
              <TabsTriggerCompact key={m.id} value={m.id}>
                {/* {m.id !== 'all' && (
                  <MarketplaceAvatar
                    id={m.id}
                    owner={m.owner}
                    sourceUrl={m.sourceUrl}
                    label={m.label}
                    size="xs"
                  />
                )} */}

                {m.label}
              </TabsTriggerCompact>
            ))}
          </TabsListCompact>

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
              <Loading className="size-3 animate-spin" />
            </span>
          ))}
        </div>
      </Tabs>

      {selected?.external && (
        <>
          <div className="border-border bg-primary/5 flex flex-col gap-3 rounded-md border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <MarketplaceAvatar
                id={selected.id}
                owner={selected.owner}
                sourceUrl={selected.sourceUrl}
                label={selected.label}
                size="md"
                className="shrink-0"
              />
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-medium">{selected.label}</p>
                <InlineMeta>
                  {selected.owner && <span>{selected.owner}</span>}
                  <span className="tabular-nums">
                    {selected.count} {selected.count === 1 ? 'item' : 'items'}
                  </span>
                  {typeBreakdown(selected.types) && <span>{typeBreakdown(selected.types)}</span>}
                </InlineMeta>
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-1.5">
              {ghUrl && (
                <Button asChild variant="outline" size="sm">
                  <Link href={ghUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-3.5" />
                    GitHub
                  </Link>
                </Button>
              )}
              {removableId && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removeSource.isPending}
                  onClick={() => setRemoveConfirmOpen(true)}
                >
                  <TrashSolid className="size-3.5" />
                  Remove
                </Button>
              )}
            </div>
          </div>
          {removableId && (
            <ConfirmDialog
              open={removeConfirmOpen}
              onOpenChange={setRemoveConfirmOpen}
              title={`Remove ${selected.label}?`}
              description="Items from this source will no longer appear in the catalog."
              confirmLabel="Remove"
              confirmVariant="destructive"
              onConfirm={onRemoveSource}
              isPending={removeSource.isPending}
            />
          )}
        </>
      )}

      {itemsQuery.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-md" />
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
              <Skeleton key={i} className="h-[92px] rounded-md" />
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
            <div key={section.label} className="space-y-3">
              <div className="flex w-fit items-center justify-between gap-2 px-1">
                <Label className="text-foreground/90 flex items-center gap-2 text-sm font-medium">
                  {section.label}
                </Label>
                <span className="text-muted-foreground text-[12px] tabular-nums">
                  {section.items.length}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">{section.items.map(renderCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">{items.map(renderCard)}</div>
      )}

      {streaming && items.length > 0 && (
        <div className="text-muted-foreground/70 flex items-center justify-center gap-2 py-1 text-xs">
          <Loading className="size-3.5 animate-spin" />
          {tI18nHardcoded.raw(
            'autoComponentsMarketplaceMarketplaceBrowserJsxTextLoadingMoreSourcese06aa650',
          )}
        </div>
      )}

      <AddMarketplaceModal open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

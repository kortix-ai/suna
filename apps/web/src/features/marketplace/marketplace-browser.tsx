'use client';

import { ChevronDown, PackageSearch } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useMarketplaceItems, useMarketplaces } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { Check, Search } from '@mynaui/icons-react';
import Loading from '../../components/ui/loading';
import { Icon } from '../icon/icon';
import { AddMarketplaceModal } from './add-marketplace-modal';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { TYPE_FILTERS, TYPE_SECTIONS } from './marketplace-meta';

export function MarketplaceBrowser({
  onAdd,
  installedNames,
  sourceFilter,
}: {
  onAdd: (item: MarketplaceItem) => void;
  installedNames?: Set<string>;
  sourceFilter?: string;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);

  const marketplacesQuery = useMarketplaces();
  const marketplaces = useMemo(
    () => marketplacesQuery.data?.marketplaces ?? [],
    [marketplacesQuery.data],
  );

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of marketplaces)
      for (const [k, v] of Object.entries(m.types ?? {})) counts[k] = (counts[k] ?? 0) + v;
    return counts;
  }, [marketplaces]);

  const typeOptions = useMemo(
    () => TYPE_FILTERS.filter((f) => f.value === 'all' || (typeCounts[f.value] ?? 0) > 0),
    [typeCounts],
  );
  const effectiveType = typeOptions.some((t) => t.value === type) ? type : 'all';

  const itemsQuery = useMarketplaceItems({
    query: debounced,
    type: effectiveType,
    source: sourceFilter ?? 'all',
  });
  const items = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);
  const grouped = effectiveType === 'all' && !debounced && !sourceFilter;
  const streaming = !!(itemsQuery.data?.loading || marketplacesQuery.data?.loading);

  const sections = useMemo(() => {
    const byLabel = new Map<string, MarketplaceItem[]>();
    for (const it of items) {
      const label = TYPE_SECTIONS.find((s) => s.type === it.type)?.label ?? 'Other';
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label)!.push(it);
    }
    const order = [...new Set(TYPE_SECTIONS.map((s) => s.label)), 'Other'];
    return [...byLabel.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([label, list]) => ({ label, items: list }));
  }, [items]);

  const renderItemGrid = (list: MarketplaceItem[]) => (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      {list.map((item) => (
        <div key={item.id} className="border-border overflow-hidden rounded-md border">
          <MarketplaceItemRow
            item={item}
            installed={installedNames?.has(item.name)}
            onAdd={onAdd}
            onOpen={() => openItem(item.id)}
          />
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <InputGroup className="peer flex-1">
          <InputGroupAddon align="inline-start" className="pl-3">
            <Search className="text-muted-foreground size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceBrowserJsxAttrPlaceholderSearchTheMarketplace188bc1ee',
            )}
            className="peer pl-1"
          />
          {query ? (
            <InputGroupAddon align="inline-end" className="pr-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 rounded-sm opacity-0 peer-focus:opacity-100"
                onClick={() => setQuery('')}
              >
                <Icon.Close className="text-muted-foreground size-4" />
              </Button>
            </InputGroupAddon>
          ) : null}
          <InputGroupAddon align="inline-end" className="pr-2 pl-2">
            <Select value={effectiveType} onValueChange={setType}>
              <SelectTrigger variant="transparent" size="sm" arrow className="mx-0.5 h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {typeOptions.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InputGroupAddon>
        </InputGroup>
        <Button size="sm" className="shrink-0" onClick={() => setAddOpen(true)}>
          Manage
        </Button>
      </div>

      {itemsQuery.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-md" />
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
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-md" />
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
      ) : grouped && sections.length > 0 ? (
        <div className="space-y-5">
          {sections.map((section) => (
            <Disclosure
              key={section.label}
              open
              className="group/section"
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            >
              <DisclosureTrigger>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 py-1"
                >
                  <h3 className="text-foreground text-sm font-medium">{section.label}</h3>
                  <div className="text-muted-foreground flex items-center gap-1.5">
                    <span className="text-[12px] tabular-nums">{section.items.length}</span>
                    <ChevronDown className="size-3.5 shrink-0 transition-transform duration-150 ease-out group-data-[state=open]/section:rotate-180" />
                  </div>
                </button>
              </DisclosureTrigger>
              <DisclosureContent contentClassName="pt-2">
                {renderItemGrid(section.items)}
              </DisclosureContent>
            </Disclosure>
          ))}
        </div>
      ) : (
        renderItemGrid(items)
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

function MarketplaceItemRow({
  item,
  installed,
  onAdd,
  onOpen,
}: {
  item: MarketplaceItem;
  installed?: boolean;
  onAdd: (item: MarketplaceItem) => void;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors',
        'hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none',
      )}
    >
      <div className="shrink-0">
        <MarketplaceItemAvatar item={item} size="sm" showSource={false} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {installed ? (
            <Badge variant="success" size="sm">
              Installed
            </Badge>
          ) : null}
        </div>
        {item.description ? (
          <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs text-pretty">
            {item.description}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant={installed ? 'outline' : 'secondary'}
          size="sm"
          className="transition-transform active:scale-[0.96]"
          onClick={(e) => {
            e.stopPropagation();
            onAdd(item);
          }}
        >
          {installed ? (
            <>
              <Check className="size-3.5" />
              Added
            </>
          ) : (
            'Add'
          )}
        </Button>
      </div>
    </div>
  );
}

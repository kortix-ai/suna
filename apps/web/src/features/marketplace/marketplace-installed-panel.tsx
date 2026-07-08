'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { InlineMeta } from '@/components/ui/inline-meta';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  buildCatalogByName,
  deriveInstalledItemStatus,
  describeRemoveConsequence,
  filterInstalledItems,
} from '@/features/marketplace/installed-client';
import {
  useInstalledItems,
  useMarketplaceItems,
  useRegistryUpdates,
  useUninstallMarketplaceItem,
  useUpdateAllMarketplaceItems,
  useUpdateMarketplaceItem,
} from '@/hooks/marketplace';
import type { InstalledItem, MarketplaceItem, RegistryItemStatus } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { formatRelative } from '@kortix/shared';
import { Search, TrashSolid } from '@mynaui/icons-react';
import { ExternalLink, KeyRound, PackageOpen, Plug, RefreshCw, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { MarketplaceAvatar } from './marketplace-avatar';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { TypeTile, typeMeta } from './marketplace-meta';

// Stable keys for the initial-load skeleton rows (fixed count, never reordered).
const SKELETON_ROW_IDS = ['s1', 's2', 's3', 's4', 's5', 's6'];

export function MarketplaceInstalledPanel({
  projectId,
  onBrowse,
}: {
  projectId: string;
  onBrowse: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [query, setQuery] = useState('');
  const installed = useInstalledItems(projectId);
  const updates = useRegistryUpdates(projectId);
  const catalog = useMarketplaceItems({});
  const updateMut = useUpdateMarketplaceItem();
  const updateAllMut = useUpdateAllMarketplaceItems();
  const uninstallMut = useUninstallMarketplaceItem();

  const items = installed.data ?? [];
  const statusByName = new Map<string, RegistryItemStatus>(
    (updates.data?.updates ?? []).map((u) => [u.name, u.status]),
  );
  const catalogByName = buildCatalogByName(catalog.data?.items ?? []);
  const updateCount = updates.data?.update_available.length ?? 0;
  const busy = updateMut.isPending || updateAllMut.isPending || uninstallMut.isPending;

  const filteredItems = filterInstalledItems(items, query, (it) => ({
    catalogTitle: catalogByName.get(it.name)?.title,
    typeLabel: typeMeta(it.type).label,
  }));

  const onUpdate = async (it: InstalledItem) => {
    try {
      const res = await updateMut.mutateAsync({ projectId, name: it.name });
      successToast(`Updated ${it.name}`, {
        description: `Re-committed ${res.file_count} file${res.file_count === 1 ? '' : 's'} — live next session.`,
      });
    } catch (e) {
      errorToast('Update failed', { description: (e as Error).message });
    }
  };

  const onUpdateAll = async () => {
    try {
      const res = await updateAllMut.mutateAsync({ projectId });
      const count = res.updated.length;
      successToast(count === 1 ? `Updated ${res.updated[0]}` : `Updated ${count} items`, {
        description:
          count > 0
            ? `Re-committed ${res.file_count} file${res.file_count === 1 ? '' : 's'} — live next session.`
            : 'Nothing needed an update.',
      });
    } catch (e) {
      errorToast('Update all failed', { description: (e as Error).message });
    }
  };

  const onRemove = async (it: InstalledItem) => {
    try {
      const res = await uninstallMut.mutateAsync({ projectId, name: it.name });
      successToast(`Removed ${it.name}`, {
        description: `Removed ${res.file_count} file${res.file_count === 1 ? '' : 's'} from the repo.`,
      });
    } catch (e) {
      errorToast('Remove failed', { description: (e as Error).message });
    }
  };

  if (installed.isLoading) {
    return (
      <div className="columns-1 gap-2 md:columns-2">
        {SKELETON_ROW_IDS.map((id) => (
          <Skeleton key={id} className="mb-2 h-14 break-inside-avoid rounded-md" />
        ))}
      </div>
    );
  }

  if (installed.isError) {
    return (
      <ErrorState
        size="sm"
        title="Failed to load installed items"
        description={(installed.error as Error)?.message}
        action={
          <Button variant="outline" size="sm" onClick={() => installed.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={PackageOpen}
        title={tI18nHardcoded.raw(
          'autoComponentsMarketplaceMarketplaceInstalledPanelJsxAttrTitleNothingInstalled853f4b1c',
        )}
        description={tI18nHardcoded.raw(
          'autoComponentsMarketplaceMarketplaceInstalledPanelJsxAttrDescriptionAddSkills237df761',
        )}
        action={
          <Button onClick={onBrowse}>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceInstalledPanelJsxTextBrowseExplore6a8c54d5',
            )}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <InlineMeta className="text-sm">
          <span className="tabular-nums">{items.length} installed</span>
          {updateCount > 0 && (
            <span className="text-foreground font-medium tabular-nums">
              {updateCount} update{updateCount === 1 ? '' : 's'} available
            </span>
          )}
          {updates.isLoading &&
            tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceInstalledPanelJsxTextCheckingForUpdatese5306763',
            )}
        </InlineMeta>
        {updateCount > 1 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            className="shrink-0 gap-1.5 transition-transform active:scale-[0.96]"
            onClick={onUpdateAll}
          >
            {updateAllMut.isPending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <RefreshCw className="size-3.5 shrink-0" />
            )}
            Update all
          </Button>
        )}
      </div>

      {items.length > 5 && (
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <Search />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder="Search installed"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            variant="popover"
          />
          <InputGroupSearchClear onClick={() => setQuery('')} />
        </InputGroupSearch>
      )}

      {filteredItems.length === 0 ? (
        <p className="text-muted-foreground px-1 py-6 text-center text-xs">
          No installed items match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="columns-1 gap-2 md:columns-2">
          {filteredItems.map((it) => (
            <div key={it.name} className="mb-2 break-inside-avoid">
              <InstalledItemCard
                item={it}
                catalogItem={catalogByName.get(it.name)}
                // Only assert a status once the updates check has resolved —
                // before that (loading/failed) the map is empty and every item
                // would false-claim "Up to date".
                status={
                  updates.isSuccess ? deriveInstalledItemStatus(it.name, statusByName) : undefined
                }
                busy={busy}
                onUpdate={() => onUpdate(it)}
                onRemove={() => onRemove(it)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InstalledItemCard({
  item,
  catalogItem,
  status,
  busy,
  onUpdate,
  onRemove,
}: {
  item: InstalledItem;
  catalogItem?: MarketplaceItem;
  /** Absent while the registry-updates check is loading or failed — render no
   *  freshness claim rather than a false "Up to date". */
  status: RegistryItemStatus | undefined;
  busy: boolean;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const meta = typeMeta(item.type);
  const TypeIcon = meta.Icon;

  return (
    <>
      <Disclosure
        variant="outline"
        open={open}
        onOpenChange={setOpen}
        className="group/card overflow-hidden"
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
      >
        <DisclosureTrigger variant="outline">
          <div
            className={cn(
              'hover:bg-muted/40 flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors',
              'focus-visible:bg-muted/40 focus-visible:outline-none',
            )}
          >
            <div className="shrink-0">
              {catalogItem ? (
                <MarketplaceItemAvatar item={catalogItem} size="sm" showSource={false} />
              ) : (
                <TypeTile type={item.type} size="sm" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-foreground truncate text-sm font-medium">
                  {catalogItem?.title ?? item.name}
                </span>
                {status === 'update-available' && (
                  <Badge variant="update" size="sm">
                    {tI18nHardcoded.raw(
                      'autoComponentsMarketplaceMarketplaceInstalledPanelJsxTextUpdateAvailable9830d327',
                    )}
                  </Badge>
                )}
                {status === 'orphaned' && (
                  <Badge variant="muted" size="sm">
                    {tI18nHardcoded.raw(
                      'autoComponentsMarketplaceMarketplaceInstalledPanelJsxTextSourceRemoved1896940e',
                    )}
                  </Badge>
                )}
                {status === 'up-to-date' && (
                  <Badge variant="success" size="sm">
                    Up to date
                  </Badge>
                )}
              </div>
              <div className="mt-0.5">
                <InlineMeta>
                  {meta.label}
                  {catalogItem?.marketplaceLabel ?? item.source}
                  <span className="tabular-nums">
                    {item.file_count} file{item.file_count === 1 ? '' : 's'}
                  </span>
                </InlineMeta>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {status === 'update-available' && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  className="transition-transform active:scale-[0.96]"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUpdate();
                  }}
                >
                  <RefreshCw className="size-3.5" />
                  Update
                </Button>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${item.name}`}
                className={cn(
                  'text-muted-foreground/40 hover:text-foreground transition-opacity transition-transform active:scale-[0.96]',
                  'opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100',
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmOpen(true);
                }}
              >
                <TrashSolid className="size-3.5" />
              </Button>
            </div>
          </div>
        </DisclosureTrigger>
        <DisclosureContent variant="outline" contentClassName="border-border border-t">
          <div className="space-y-4 px-4 py-4">
            {catalogItem?.description ? (
              <p className="text-muted-foreground text-sm leading-relaxed text-pretty">
                {catalogItem.description}
              </p>
            ) : null}

            <div className="space-y-2">
              <p className="text-muted-foreground text-xs font-medium">Install</p>
              <InlineMeta className="text-xs">
                <span className="inline-flex items-center gap-1">
                  <TypeIcon className="size-3 shrink-0" />
                  {meta.label}
                </span>
                {item.installed_at ? `added ${formatRelative(item.installed_at) ?? ''}` : null}
                <span className="font-mono tabular-nums">{item.name}</span>
                <span className="tabular-nums">
                  {item.file_count} file{item.file_count === 1 ? '' : 's'} in repo
                </span>
              </InlineMeta>
            </div>

            {catalogItem ? (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium">Source</p>
                <div className="flex min-w-0 items-center gap-2">
                  <MarketplaceAvatar
                    id={catalogItem.marketplaceId}
                    owner={catalogItem.owner}
                    sourceUrl={catalogItem.sourceUrl}
                    label={catalogItem.marketplaceLabel}
                    size="xs"
                  />
                  {catalogItem.sourceUrl ? (
                    <a
                      href={catalogItem.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-foreground hover:text-foreground/80 inline-flex min-w-0 items-center gap-1 text-sm transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className="truncate">{catalogItem.marketplaceLabel}</span>
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-foreground truncate text-sm">
                      {catalogItem.marketplaceLabel}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium">Source</p>
                <p className="text-foreground truncate font-mono text-sm">{item.source}</p>
              </div>
            )}

            {catalogItem && catalogItem.categories.length > 0 ? (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium">Categories</p>
                <div className="flex flex-wrap gap-1">
                  {catalogItem.categories.map((cat) => (
                    <Badge key={cat} variant="muted" size="sm">
                      {cat}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {catalogItem && hasCapabilities(catalogItem) ? (
              <div className="space-y-2">
                <p className="text-muted-foreground text-xs font-medium">Permissions</p>
                <div className="flex flex-wrap gap-1">
                  {catalogItem.capabilities.secrets.map((s) => (
                    <Badge key={s} variant="muted" size="xs" className="font-mono">
                      <KeyRound />
                      {s}
                    </Badge>
                  ))}
                  {catalogItem.capabilities.tools.map((tool) => (
                    <Badge key={tool} variant="muted" size="xs">
                      <Wrench />
                      {tool}
                    </Badge>
                  ))}
                  {catalogItem.capabilities.connectors.map((cn) => (
                    <Badge key={cn} variant="muted" size="xs">
                      <Plug />
                      {cn}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {catalogItem && catalogItem.dependencies.length > 0 ? (
              <InlineMeta className="text-xs">
                <span className="tabular-nums">
                  {catalogItem.dependencies.length} dependenc
                  {catalogItem.dependencies.length === 1 ? 'y' : 'ies'}
                </span>
              </InlineMeta>
            ) : null}
          </div>
        </DisclosureContent>
      </Disclosure>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Remove ${catalogItem?.title ?? item.name}?`}
        description={describeRemoveConsequence(item, catalogItem?.title)}
        confirmLabel="Remove"
        confirmVariant="destructive"
        isPending={busy}
        onConfirm={() => {
          onRemove();
          setConfirmOpen(false);
        }}
      />
    </>
  );
}

function hasCapabilities(item: MarketplaceItem): boolean {
  const caps = item.capabilities;
  return caps.secrets.length + caps.connectors.length + caps.tools.length > 0;
}

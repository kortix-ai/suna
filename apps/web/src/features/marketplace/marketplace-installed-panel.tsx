'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import {
  useInstalledItems,
  useMarketplaceItems,
  useRegistryUpdates,
  useUninstallMarketplaceItem,
  useUpdateMarketplaceItem,
} from '@/hooks/marketplace';
import type { InstalledItem, MarketplaceItem } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { formatRelative } from '@kortix/shared';
import { TrashSolid } from '@mynaui/icons-react';
import { ExternalLink, KeyRound, PackageOpen, Plug, RefreshCw, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { MarketplaceAvatar } from './marketplace-avatar';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { TypeTile, typeMeta } from './marketplace-meta';

export function MarketplaceInstalledPanel({
  projectId,
  onBrowse,
}: {
  projectId: string;
  onBrowse: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const installed = useInstalledItems(projectId);
  const updates = useRegistryUpdates(projectId);
  const catalog = useMarketplaceItems({});
  const updateMut = useUpdateMarketplaceItem();
  const uninstallMut = useUninstallMarketplaceItem();

  const items = installed.data ?? [];
  const statusByName = new Map((updates.data?.updates ?? []).map((u) => [u.name, u.status]));
  const catalogByName = new Map((catalog.data?.items ?? []).map((i) => [i.name, i]));
  const updateCount = updates.data?.update_available.length ?? 0;
  const busy = updateMut.isPending || uninstallMut.isPending;

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
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="mb-2 h-14 break-inside-avoid rounded-md" />
        ))}
      </div>
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
    <div className="space-y-5">
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

      <div className="columns-1 gap-2 md:columns-2">
        {items.map((it) => (
          <div key={it.name} className="mb-2 break-inside-avoid">
            <InstalledItemCard
              item={it}
              catalogItem={catalogByName.get(it.name)}
              status={statusByName.get(it.name)}
              busy={busy}
              onUpdate={() => onUpdate(it)}
              onRemove={() => onRemove(it)}
            />
          </div>
        ))}
      </div>
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
  status?: string;
  busy: boolean;
  onUpdate: () => void;
  onRemove: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const meta = typeMeta(item.type);
  const TypeIcon = meta.Icon;

  return (
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
                onRemove();
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
  );
}

function hasCapabilities(item: MarketplaceItem): boolean {
  const caps = item.capabilities;
  return caps.secrets.length + caps.connectors.length + caps.tools.length > 0;
}

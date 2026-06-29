'use client';

import { Check, KeyRound, Plus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { MarketplaceItemAvatar } from './marketplace-item-avatar';
import { typeMeta } from './marketplace-meta';

export function MarketplaceItemCard({
  item,
  installed,
  showSource,
  onOpen,
  onAdd,
}: {
  item: MarketplaceItem;
  installed?: boolean;
  showSource?: boolean;
  onOpen: (item: MarketplaceItem) => void;
  onAdd?: (item: MarketplaceItem) => void;
}) {
  const { label } = typeMeta(item.type);
  const secretCount = item.capabilities?.secrets?.length ?? 0;
  const count = item.type === 'registry:bundle' ? item.dependencies.length : item.fileCount;
  const countLabel = item.type === 'registry:bundle' ? 'items' : 'files';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(item);
        }
      }}
      className={cn(
        'group bg-popover flex cursor-pointer items-start gap-3 rounded-md hover:bg-muted/80 border p-3.5 transition-colors',
      )}
    >
      <MarketplaceItemAvatar item={item} size="md" showSource={showSource} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">{item.title}</span>
          {installed && (
            <Badge variant="new" size="sm" className="shrink-0 gap-0.5">
              <Check className="size-3" />
              Installed
            </Badge>
          )}
        </div>
        {item.description && (
          <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">{item.description}</p>
        )}
        <div className="text-muted-foreground/70 mt-1.5 flex items-center gap-1.5 text-xs">
          <span>{label}</span>
          <span aria-hidden>·</span>
          <span>
            {count} {countLabel}
          </span>
          {secretCount > 0 && (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-0.5">
                <KeyRound className="size-3" />
                {secretCount}
              </span>
            </>
          )}
          {showSource && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{item.marketplaceLabel}</span>
            </>
          )}
        </div>
      </div>
      {onAdd && !installed && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onAdd(item);
          }}
          aria-label="Add"
        >
          <Plus className="size-4" />
        </Button>
      )}
    </div>
  );
}

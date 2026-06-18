'use client';

/**
 * Installed view — the "WordPress for AI" plugins screen. Reads the project's
 * `registry-lock.json` (what's installed), cross-references the catalog for
 * titles + capabilities, and overlays the update-check (re-resolve source,
 * re-hash, compare). Each row: one-button Update when outdated, Remove always.
 */

import { KeyRound, PackageOpen, Plug, RefreshCw, Trash2, Wrench } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useInstalledItems,
  useMarketplaceItems,
  useRegistryUpdates,
  useUninstallMarketplaceItem,
  useUpdateMarketplaceItem,
} from '@/hooks/marketplace';
import type { InstalledItem } from '@/lib/marketplace-client';
import { TypeTile, typeMeta } from './marketplace-meta';

function relativeDate(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function MarketplaceInstalledPanel({
  projectId,
  onBrowse,
}: {
  projectId: string;
  onBrowse: () => void;
}) {
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
      <div className="space-y-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-2xl" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={PackageOpen}
        title="Nothing installed yet"
        description="Add skills from Explore — they commit into this project's repo, live in the next session."
        action={<Button onClick={onBrowse}>Browse Explore</Button>}
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        {items.length} installed
        {updateCount > 0 && (
          <>
            {' · '}
            <span className="text-foreground font-medium">
              {updateCount} update{updateCount === 1 ? '' : 's'} available
            </span>
          </>
        )}
        {updates.isLoading && <span className="text-muted-foreground/60"> · checking for updates…</span>}
      </p>

      <div className="space-y-2.5">
        {items.map((it) => {
          const status = statusByName.get(it.name);
          const meta = typeMeta(it.type);
          const cat = catalogByName.get(it.name);
          const caps = cat?.capabilities;
          const capCount = caps ? caps.secrets.length + caps.connectors.length + caps.tools.length : 0;
          return (
            <div
              key={it.name}
              className="border-border/60 bg-card flex items-center gap-3 rounded-2xl border p-3"
            >
              <TypeTile type={it.type} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground truncate text-sm font-medium">{cat?.title ?? it.name}</span>
                  {status === 'update-available' && (
                    <Badge variant="update" size="sm">
                      Update available
                    </Badge>
                  )}
                  {status === 'orphaned' && (
                    <Badge variant="muted" size="sm">
                      Source removed
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground mt-0.5 truncate text-xs">
                  {meta.label} · {it.source} · {it.file_count} file{it.file_count === 1 ? '' : 's'}
                  {it.installed_at ? ` · added ${relativeDate(it.installed_at)}` : ''}
                </div>
                {capCount > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {caps!.secrets.map((s) => (
                      <span
                        key={s}
                        className="bg-muted/60 text-muted-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px]"
                      >
                        <KeyRound className="size-2.5" />
                        {s}
                      </span>
                    ))}
                    {caps!.tools.map((t) => (
                      <span
                        key={t}
                        className="bg-muted/60 text-muted-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]"
                      >
                        <Wrench className="size-2.5" />
                        {t}
                      </span>
                    ))}
                    {caps!.connectors.map((cn) => (
                      <span
                        key={cn}
                        className="bg-muted/60 text-muted-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px]"
                      >
                        <Plug className="size-2.5" />
                        {cn}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {status === 'update-available' && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onUpdate(it)}>
                    <RefreshCw className="size-3.5" />
                    Update
                  </Button>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Remove ${it.name}`}
                  onClick={() => onRemove(it)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

'use client';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useAddMarketplaceSource,
  useFeaturedMarketplaces,
  useMarketplaces,
  useRemoveMarketplaceSource,
} from '@/hooks/marketplace';
import type { MarketplaceSummary } from '@/lib/marketplace-client';
import { cn } from '@/lib/utils';
import { TrashSolid } from '@mynaui/icons-react';
import { Plus, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '../icon/icon';
import { AddMarketplaceModal } from './add-marketplace-modal';
import { MarketplaceAvatar } from './marketplace-avatar';

const TYPE_ORDER = ['skill', 'agent', 'command', 'tool'];
function typeBreakdown(types: Record<string, number>): string {
  return TYPE_ORDER.filter((t) => types[t])
    .map((t) => `${types[t]} ${types[t] === 1 ? t : `${t}s`}`)
    .join(' · ');
}

function ghUrlFor(id: string): string | undefined {
  return id.includes('/') && !id.includes('://') ? `https://github.com/${id}` : undefined;
}

function dedupeBy<T>(arr: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return arr.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function SourceCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="hover:bg-muted/40 flex items-start gap-3 rounded-md border px-4 py-3 transition-colors">
      {children}
    </div>
  );
}

export function MarketplaceDiscover({ onBrowse }: { onBrowse: (id: string) => void }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const mineQ = useMarketplaces();
  const featuredQ = useFeaturedMarketplaces();
  const add = useAddMarketplaceSource();
  const removeSource = useRemoveMarketplaceSource();
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const mine = dedupeBy(mineQ.data?.marketplaces ?? [], (m) => m.id);
  const featuredAll = dedupeBy(
    (featuredQ.data ?? []).filter((f) => !f.added),
    (f) => f.address,
  );
  const q = search.trim().toLowerCase();
  const featured = q
    ? featuredAll.filter((f) =>
        `${f.label} ${f.owner} ${f.description} ${f.address}`.toLowerCase().includes(q),
      )
    : featuredAll;

  const onEnable = (address: string, label: string) => {
    setPending(address);
    add
      .mutateAsync({ address, label })
      .then(
        () =>
          successToast(`Enabled ${label}`, {
            description: 'Its skills now appear in the catalog.',
          }),
        (e) => errorToast('Could not enable', { description: (e as Error).message }),
      )
      .finally(() => setPending(null));
  };

  const onRemove = (m: MarketplaceSummary) => {
    if (!m.sourceId) return;
    removeSource.mutateAsync(m.sourceId).then(
      () => successToast(`Removed ${m.label}`),
      (e) => errorToast('Could not remove', { description: (e as Error).message }),
    );
  };

  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label>
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceDiscoverJsxTextYourSourcesca5e4602',
            )}
          </Label>
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            {tI18nHardcoded.raw(
              'autoComponentsMarketplaceMarketplaceDiscoverJsxTextAddSource6a944c63',
            )}
          </Button>
        </div>
        {mineQ.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-[84px] rounded-md" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {mine.map((m) => {
              const removable = !!m.sourceId;
              const gh = m.sourceUrl ?? ghUrlFor(m.id);
              return (
                <SourceCard key={m.id}>
                  <span className="relative inline-flex shrink-0">
                    <MarketplaceAvatar
                      id={m.id}
                      owner={m.owner}
                      sourceUrl={m.sourceUrl}
                      label={m.label}
                      size="md"
                    />
                    {!m.external && (
                      <span className="absolute -right-1 -bottom-1 inline-flex rounded-full">
                        <Icon.Verified className="size-5" />
                      </span>
                    )}
                  </span>
                  <div className="flex min-w-0 flex-1 items-center justify-between">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        {gh ? (
                          <Link
                            href={gh}
                            target="_blank"
                            rel="noreferrer"
                            className="text-foreground hover:text-foreground/80 min-w-0 truncate text-sm font-medium transition-colors hover:underline"
                          >
                            {m.label}
                          </Link>
                        ) : (
                          <span className="text-foreground truncate text-sm font-medium">
                            {m.label}
                          </span>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 truncate text-xs">
                        {m.count} items
                        {typeBreakdown(m.types) ? ` · ${typeBreakdown(m.types)}` : ''}
                      </div>
                    </div>
                    <ButtonGroup className="mt-2">
                      <Button size="xs" variant="outline" onClick={() => onBrowse(m.id)}>
                        Browse
                      </Button>
                      {removable && (
                        <Button
                          size="xs"
                          variant="outline"
                          aria-label={`Remove ${m.label}`}
                          className="text-muted-foreground hover:text-foreground ml-auto"
                          disabled={removeSource.isPending}
                          onClick={() => onRemove(m)}
                        >
                          <TrashSolid className="size-3.5" />
                        </Button>
                      )}
                    </ButtonGroup>
                  </div>
                </SourceCard>
              );
            })}
          </div>
        )}
      </section>

      <Separator />

      {/* Featured / discover */}
      {(featuredAll.length > 0 || featuredQ.isLoading) && (
        <section className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Label>
              {tI18nHardcoded.raw(
                'autoComponentsMarketplaceMarketplaceDiscoverJsxTextFeaturedSources185c12c5',
              )}
            </Label>
            <div className="relative w-full sm:max-w-[220px]">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tI18nHardcoded.raw(
                  'autoComponentsMarketplaceMarketplaceDiscoverJsxAttrPlaceholderSearchSources18e70a1b',
                )}
                className="h-9 pl-9 text-sm"
              />
            </div>
          </div>

          {featured.length === 0 ? (
            <p className="text-muted-foreground/70 py-6 text-center text-sm">
              {tI18nHardcoded.raw(
                'autoComponentsMarketplaceMarketplaceDiscoverJsxTextNoSourcesMatch0432edd6',
              )}
              {search}”.
            </p>
          ) : (
            <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">
              {featured.map((f) => {
                const gh = ghUrlFor(f.address);
                const busy = pending === f.address;
                return (
                  <SourceCard key={f.address}>
                    <span className="relative inline-flex shrink-0">
                      <MarketplaceAvatar id={f.address} owner={f.owner} label={f.label} size="md" />
                    </span>
                    <div className="flex min-w-0 flex-1 items-center justify-between">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          {gh ? (
                            <Link
                              href={gh}
                              target="_blank"
                              rel="noreferrer"
                              className="text-foreground hover:text-foreground/80 min-w-0 truncate text-sm font-medium transition-colors hover:underline"
                            >
                              {f.label}
                            </Link>
                          ) : (
                            <span className="text-foreground truncate text-sm font-medium">
                              {f.label}
                            </span>
                          )}
                          {/* {f.license && (
                            <Badge variant="kortix" size="sm" className="shrink-0">
                              {f.license}
                            </Badge>
                          )} */}
                        </div>
                        <div className="text-muted-foreground mt-0.5 truncate text-xs">
                          {f.description || f.address}
                        </div>
                      </div>
                      <div className="mb-auto flex shrink-0 items-center gap-1">
                        <Button
                          size="xs"
                          variant="secondary"
                          className={cn(busy && 'opacity-70')}
                          disabled={busy}
                          onClick={() => onEnable(f.address, f.label)}
                        >
                          {busy ? 'Enabling…' : 'Enable'}
                        </Button>
                      </div>
                    </div>
                  </SourceCard>
                );
              })}
            </div>
          )}
        </section>
      )}

      <AddMarketplaceModal open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

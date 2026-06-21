'use client';

import { useTranslations } from 'next-intl';
/**
 * The sources tab — manage *sources* (not items). "Your sources" (Kortix +
 * everything you've enabled, with live counts) and "Featured" (curated,
 * permissively-licensed repos you can enable in one click). Enable → its skills
 * flow into the catalog; Browse → jumps to Explore filtered to that source.
 */

import { Check, ExternalLink, Plus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { AddMarketplaceDialog } from './add-marketplace-dialog';
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

/** Drop repeats by their render key — guards against duplicate React keys (and
 * duplicate cards) if a source ever appears twice in the payload. */
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
    <div className="border-border/60 bg-card hover:border-foreground/15 flex items-start gap-3 rounded-2xl border p-3.5 transition-colors">
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
      {/* Your sources */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h3 className="text-foreground text-sm font-semibold">
              {tI18nHardcoded.raw(
                'autoComponentsMarketplaceMarketplaceDiscoverJsxTextYourSourcesca5e4602',
              )}
            </h3>
            {mine.length > 0 && (
              <span className="text-muted-foreground/60 text-xs tabular-nums">{mine.length}</span>
            )}
          </div>
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
              <Skeleton key={i} className="h-[84px] rounded-2xl" />
            ))}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {mine.map((m) => {
              const removable = !!m.sourceId;
              const gh = m.sourceUrl ?? ghUrlFor(m.id);
              return (
                <SourceCard key={m.id}>
                  <MarketplaceAvatar
                    id={m.id}
                    owner={m.owner}
                    sourceUrl={m.sourceUrl}
                    label={m.label}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {m.label}
                      </span>
                      {!m.external && (
                        <Badge variant="muted" size="sm" className="shrink-0">
                          Official
                        </Badge>
                      )}
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-xs">
                      {m.count} items{typeBreakdown(m.types) ? ` · ${typeBreakdown(m.types)}` : ''}
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                      <Button size="xs" variant="outline" onClick={() => onBrowse(m.id)}>
                        Browse
                      </Button>
                      {gh && (
                        <a
                          href={gh}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={tI18nHardcoded.raw(
                            'autoComponentsMarketplaceMarketplaceDiscoverJsxAttrAriaLabelViewOn35edbd8c',
                          )}
                          className="text-muted-foreground hover:text-foreground inline-flex size-7 items-center justify-center rounded-lg transition-colors"
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                      {removable && (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Remove ${m.label}`}
                          className="text-muted-foreground hover:text-foreground ml-auto"
                          disabled={removeSource.isPending}
                          onClick={() => onRemove(m)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </SourceCard>
              );
            })}
          </div>
        )}
      </section>

      {/* Featured / discover */}
      {(featuredAll.length > 0 || featuredQ.isLoading) && (
        <section className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-foreground text-sm font-semibold">
                  {tI18nHardcoded.raw(
                    'autoComponentsMarketplaceMarketplaceDiscoverJsxTextFeaturedSources185c12c5',
                  )}
                </h3>
                <span className="text-muted-foreground/60 text-xs tabular-nums">
                  {featuredAll.length}
                </span>
              </div>
              <p className="text-muted-foreground text-xs">
                {tI18nHardcoded.raw(
                  'autoComponentsMarketplaceMarketplaceDiscoverJsxTextCuratedPermissivelyLicensedReposadbe2517',
                )}
              </p>
            </div>
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
            <div className="grid gap-3 sm:grid-cols-2">
              {featured.map((f) => {
                const gh = ghUrlFor(f.address);
                const busy = pending === f.address;
                return (
                  <SourceCard key={f.address}>
                    <MarketplaceAvatar id={f.address} owner={f.owner} label={f.label} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          {f.label}
                        </span>
                        {f.license && (
                          <Badge variant="muted" size="sm" className="shrink-0">
                            {f.license}
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                        {f.description}
                      </div>
                      <div className="text-muted-foreground/60 mt-0.5 truncate font-mono text-[10px]">
                        {f.address}
                      </div>
                      <div className="mt-2 flex items-center gap-1">
                        <Button
                          size="xs"
                          className={cn(busy && 'opacity-70')}
                          disabled={busy}
                          onClick={() => onEnable(f.address, f.label)}
                        >
                          {busy ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
                          {busy ? 'Enabling…' : 'Enable'}
                        </Button>
                        {gh && (
                          <a
                            href={gh}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs transition-colors"
                          >
                            GitHub
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </SourceCard>
                );
              })}
            </div>
          )}
        </section>
      )}

      <AddMarketplaceDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

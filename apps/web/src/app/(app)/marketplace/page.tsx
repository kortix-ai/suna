'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AddToProjectDialog } from '@/components/marketplace/add-to-project-dialog';
import { MarketplaceBrowser } from '@/components/marketplace/marketplace-browser';
import { MarketplaceDiscover } from '@/components/marketplace/marketplace-discover';
import { MarketplaceItemDetail } from '@/components/marketplace/marketplace-item-detail';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { AppHeader } from '@/features/layout/app-header';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';

export default function MarketplacePage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { user, isLoading: authLoading } = useAuth();
  const [addItem, setAddItem] = useState<MarketplaceItem | null>(null);
  const [tab, setTab] = useState<'explore' | 'marketplaces'>('explore');
  const [source, setSource] = useState('all');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const closeSheet = useMarketplaceDetailStore((s) => s.close);

  // Leave the detail when the page unmounts so a stale detail never reopens.
  useEffect(() => () => closeSheet(), [closeSheet]);

  if (authLoading) return <div className="bg-background min-h-screen" />;

  if (!user) {
    return (
      <div className="bg-background min-h-screen">
        <header className="border-border/60 bg-background/90 sticky top-0 z-10 border-b backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="text-foreground text-sm font-semibold">
              Kortix
            </Link>
            <Link
              href="/auth?redirect=/marketplace"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Sign in
            </Link>
          </div>
        </header>
        <main className="px-4 py-8 sm:px-6 sm:py-10">
          <div className="mx-auto w-full max-w-5xl space-y-6">
            <div>
              <h1 className="text-foreground text-lg font-semibold">Marketplace</h1>
              <p className="text-muted-foreground text-sm">
                Browse public marketplace items. Sign in to add them to a project.
              </p>
            </div>
            <MarketplaceBrowser
              source={source}
              onSourceChange={setSource}
              publicOnly
              readOnly
              onAdd={() => undefined}
            />
          </div>
        </main>
      </div>
    );
  }

  if (openId) {
    return (
      <div className="bg-foreground/5 flex h-screen flex-col">
        <AppHeader user={user} breadcrumb="Marketplace" />
        <main className="ring-input bg-background min-h-0 flex-1 overflow-hidden rounded-t-3xl ring-1">
          <MarketplaceItemDetail onBack={closeSheet} onAdd={(it) => setAddItem(it)} />
        </main>
        <AddToProjectDialog
          item={addItem}
          open={!!addItem}
          onOpenChange={(o) => {
            if (!o) setAddItem(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="bg-foreground/5 flex min-h-screen flex-col">
      <AppHeader user={user} breadcrumb="Marketplace" />
      <main className="ring-input bg-background flex-1 rounded-t-3xl px-4 py-8 ring-1 sm:px-6 sm:py-10">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-foreground text-lg font-semibold">Marketplace</h1>
              <p className="text-muted-foreground text-sm">
                {tI18nHardcoded.raw(
                  'autoAppAppMarketplacePageJsxTextBrowseSkillsAcrossEvery14a9148d',
                )}
              </p>
            </div>
            <FilterBar className="shrink-0">
              <FilterBarItem
                data-state={tab === 'explore' ? 'active' : 'inactive'}
                onClick={() => setTab('explore')}
              >
                Explore
              </FilterBarItem>
              <FilterBarItem
                data-state={tab === 'marketplaces' ? 'active' : 'inactive'}
                onClick={() => setTab('marketplaces')}
              >
                Sources
              </FilterBarItem>
            </FilterBar>
          </div>

          {tab === 'explore' ? (
            <MarketplaceBrowser
              source={source}
              onSourceChange={setSource}
              onAdd={(it) => {
                closeSheet();
                setAddItem(it);
              }}
            />
          ) : (
            <MarketplaceDiscover
              onBrowse={(id) => {
                setSource(id);
                setTab('explore');
              }}
            />
          )}
        </div>
      </main>

      <AddToProjectDialog
        item={addItem}
        open={!!addItem}
        onOpenChange={(o) => {
          if (!o) setAddItem(null);
        }}
      />
    </div>
  );
}

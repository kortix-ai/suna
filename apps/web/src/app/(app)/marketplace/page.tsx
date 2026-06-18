'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AddToProjectDialog } from '@/components/marketplace/add-to-project-dialog';
import { MarketplaceBrowser } from '@/components/marketplace/marketplace-browser';
import { MarketplaceDiscover } from '@/components/marketplace/marketplace-discover';
import { MarketplaceItemDetail } from '@/components/marketplace/marketplace-item-detail';
import { useAuth } from '@/features/providers/auth-provider';
import { AppHeader } from '@/features/layout/app-header';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';

export default function MarketplacePage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const [addItem, setAddItem] = useState<MarketplaceItem | null>(null);
  const [tab, setTab] = useState<'explore' | 'marketplaces'>('explore');
  const [source, setSource] = useState('all');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const closeSheet = useMarketplaceDetailStore((s) => s.close);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);
  // Leave the detail when the page unmounts so a stale detail never reopens.
  useEffect(() => () => closeSheet(), [closeSheet]);

  if (authLoading || !user) return <div className="bg-background min-h-screen" />;

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
              <h1 className="text-lg font-semibold text-foreground">Marketplace</h1>
              <p className="text-sm text-muted-foreground">
                Browse skills across every source — one click adds them to a project&rsquo;s repo, live in
                its next session.
              </p>
            </div>
            <FilterBar className="shrink-0">
              <FilterBarItem data-state={tab === 'explore' ? 'active' : 'inactive'} onClick={() => setTab('explore')}>
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

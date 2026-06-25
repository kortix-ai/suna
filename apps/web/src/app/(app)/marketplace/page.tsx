'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AppHeader } from '@/features/layout/app-header';
import { AddToProjectModal } from '@/features/marketplace/add-to-project-modal';
import { MarketplaceBrowser } from '@/features/marketplace/marketplace-browser';
import { MarketplaceItemDetail } from '@/features/marketplace/marketplace-item-detail';
import { useAuth } from '@/features/providers/auth-provider';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';

export default function MarketplacePage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const [addItem, setAddItem] = useState<MarketplaceItem | null>(null);
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const closeSheet = useMarketplaceDetailStore((s) => s.close);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);
  useEffect(() => () => closeSheet(), [closeSheet]);

  if (authLoading || !user) return <div className="bg-background min-h-screen" />;

  if (openId) {
    return (
      <div className="bg-foreground/5 flex h-screen flex-col">
        <AppHeader user={user} breadcrumb="Marketplace" />
        <main className="ring-input bg-background min-h-0 flex-1 overflow-hidden rounded-t-3xl ring-1">
          <MarketplaceItemDetail onBack={closeSheet} onAdd={(it) => setAddItem(it)} />
        </main>
        <AddToProjectModal
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
      <main className="ring-input bg-background flex-1 rounded-t-3xl ring-1">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-10 pb-20 lg:py-20">
          <header className="space-y-1">
            <h1 className="text-foreground text-xl font-medium text-balance">Marketplace</h1>
            <p className="text-muted-foreground text-sm text-pretty">
              {tI18nHardcoded.raw(
                'autoAppAppMarketplacePageJsxTextBrowseSkillsAcrossEvery14a9148d',
              )}
            </p>
          </header>

          <MarketplaceBrowser
            onAdd={(it) => {
              closeSheet();
              setAddItem(it);
            }}
          />
        </div>
      </main>

      <AddToProjectModal
        item={addItem}
        open={!!addItem}
        onOpenChange={(o) => {
          if (!o) setAddItem(null);
        }}
      />
    </div>
  );
}

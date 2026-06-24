'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { AddToProjectModal } from '@/features/marketplace/add-to-project-modal';
import { MarketplaceBrowser } from '@/features/marketplace/marketplace-browser';
import { MarketplaceDiscover } from '@/features/marketplace/marketplace-discover';
import { MarketplaceInstalledPanel } from '@/features/marketplace/marketplace-installed-panel';
import { MarketplaceItemDetail } from '@/features/marketplace/marketplace-item-detail';
import {
  useInstalledItems,
  useRegistryUpdates,
  useUninstallMarketplaceItem,
} from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { getProjectDetail } from '@/lib/projects-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';

type Tab = 'explore' | 'marketplaces' | 'installed';

export function MarketplaceView({ projectId }: { projectId: string }) {
  const t = useTranslations('hardcodedUi');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const closeDetail = useMarketplaceDetailStore((s) => s.close);

  const [tab, setTab] = useState<Tab>('explore');
  const [source, setSource] = useState('all');
  const [addItem, setAddItem] = useState<MarketplaceItem | null>(null);

  useEffect(() => () => closeDetail(), [closeDetail]);

  const detail = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const projectName = detail.data?.project?.name ?? 'project';

  const installed = useInstalledItems(projectId);
  const installedNames = new Set((installed.data ?? []).map((i) => i.name));
  const installedCount = installed.data?.length ?? 0;

  const updates = useRegistryUpdates(projectId);
  const updateCount = updates.data?.update_available.length ?? 0;

  const uninstall = useUninstallMarketplaceItem();
  const onRemove = async (item: MarketplaceItem) => {
    try {
      const res = await uninstall.mutateAsync({ projectId, name: item.name });
      successToast(`Removed ${item.name}`, {
        description: `Removed ${res.file_count} file${res.file_count === 1 ? '' : 's'} from the repo.`,
      });
    } catch (e) {
      errorToast('Remove failed', { description: (e as Error).message });
    }
  };

  const addDialog = (
    <AddToProjectModal
      item={addItem}
      open={!!addItem}
      onOpenChange={(open) => !open && setAddItem(null)}
      fixedProjectId={projectId}
      fixedProjectName={projectName}
    />
  );

  if (openId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MarketplaceItemDetail
          onBack={closeDetail}
          onAdd={setAddItem}
          onRemove={onRemove}
          addLabel={t.raw(
            'autoComponentsMarketplaceMarketplaceViewJsxAttrAddLabelAddToThisc1246454',
          )}
          installedNames={installedNames}
        />
        {addDialog}
      </div>
    );
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as Tab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <header className="flex flex-col gap-2 space-y-2 border-b p-4 sm:flex-row sm:items-center sm:justify-between md:space-y-0">
        <h2 className="text-foreground text-xl font-medium text-balance">Marketplace</h2>
        <div className="shrink-0">
          <TabsList>
            <TabsTrigger value="explore">Explore</TabsTrigger>
            <TabsTrigger value="marketplaces">Sources</TabsTrigger>
            <TabsTrigger value="installed">Installed</TabsTrigger>
          </TabsList>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <TabsContent value="explore" className="mt-0">
          <MarketplaceBrowser
            installedNames={installedNames}
            source={source}
            onSourceChange={setSource}
            onAdd={setAddItem}
          />
        </TabsContent>
        <TabsContent value="marketplaces" className="mt-0">
          <MarketplaceDiscover
            onBrowse={(id) => {
              setSource(id);
              setTab('explore');
            }}
          />
        </TabsContent>
        <TabsContent value="installed" className="mt-0">
          <MarketplaceInstalledPanel projectId={projectId} onBrowse={() => setTab('explore')} />
        </TabsContent>
      </div>

      {addDialog}
    </Tabs>
  );
}

'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { Tabs, TabsContent, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { AddToProjectModal } from '@/features/marketplace/add-to-project-modal';
import { MarketplaceBrowser } from '@/features/marketplace/marketplace-browser';
import { MarketplaceDiscover } from '@/features/marketplace/marketplace-discover';
import { MarketplaceInstalledPanel } from '@/features/marketplace/marketplace-installed-panel';
import { MarketplaceItemDetail } from '@/features/marketplace/marketplace-item-detail';
import { useInstalledItems, useUninstallMarketplaceItem } from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { getProjectDetail } from '@kortix/sdk/projects-client';
import CustomizeSectionWrapper from '../workspace/customize/sections/component/section-wrapper';

export function MarketplaceView({ projectId }: { projectId: string }) {
  const t = useTranslations('hardcodedUi');
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const closeDetail = useMarketplaceDetailStore((s) => s.close);

  const [addItem, setAddItem] = useState<MarketplaceItem | null>(null);
  const [tab, setTab] = useState<'browse' | 'discover' | 'installed'>('browse');
  const [sourceFilter, setSourceFilter] = useState<string | undefined>();
  const browseScrollContainerRef = useRef<HTMLDivElement>(null);

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
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as 'browse' | 'discover' | 'installed')}
        className="flex h-full min-h-0 flex-col"
      >
        <CustomizeSectionWrapper
          title="Marketplace"
          className="max-w-5xl p-4 px-4 py-2  lg:py-2"
          scrollContainerRef={browseScrollContainerRef}
          action={
            <TabsListCompact>
              <TabsTriggerCompact value="browse">Browse</TabsTriggerCompact>
              <TabsTriggerCompact value="installed">Installed</TabsTriggerCompact>
              <TabsTriggerCompact value="discover">Discover</TabsTriggerCompact>
            </TabsListCompact>
          }
        >
          <TabsContent value="browse" className="mt-0">
            <MarketplaceBrowser
              installedNames={installedNames}
              onAdd={setAddItem}
              sourceFilter={sourceFilter}
              scrollContainerRef={browseScrollContainerRef}
            />
          </TabsContent>
          <TabsContent value="installed" className="mt-0">
            <MarketplaceInstalledPanel projectId={projectId} onBrowse={() => setTab('browse')} />
          </TabsContent>
          <TabsContent value="discover" className="mt-0">
            <MarketplaceDiscover
              onBrowse={(id) => {
                setSourceFilter(id);
                setTab('browse');
              }}
            />
          </TabsContent>
        </CustomizeSectionWrapper>
      </Tabs>

      {addDialog}
    </div>
  );
}

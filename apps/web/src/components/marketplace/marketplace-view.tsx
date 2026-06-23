'use client';

import { useQuery } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { AddToProjectDialog } from '@/components/marketplace/add-to-project-dialog';
import { MarketplaceBrowser } from '@/components/marketplace/marketplace-browser';
import { MarketplaceDiscover } from '@/components/marketplace/marketplace-discover';
import { MarketplaceInstalledPanel } from '@/components/marketplace/marketplace-installed-panel';
import { MarketplaceItemDetail } from '@/components/marketplace/marketplace-item-detail';
import { Badge } from '@/components/ui/badge';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { CustomizeSectionHeader } from '@/features/workspace/customize/customize-section-header';
import {
  useInstalledItems,
  useRegistryUpdates,
  useUninstallMarketplaceItem,
} from '@/hooks/marketplace';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { getProjectDetail } from '@/lib/projects-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';

type Tab = 'explore' | 'marketplaces' | 'installed';

/** Inline Marketplace — browse the registry and install skills into this project. */
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
    <AddToProjectDialog
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
      <CustomizeSectionHeader
        icon={Store}
        title="Marketplace"
        actions={
          <FilterBar>
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
            <FilterBarItem
              data-state={tab === 'installed' ? 'active' : 'inactive'}
              onClick={() => setTab('installed')}
            >
              Installed
              {installedCount > 0 && (
                <span className="text-muted-foreground/60 ml-1 tabular-nums">{installedCount}</span>
              )}
              {updateCount > 0 && (
                <Badge variant="warning" size="sm" className="ml-1.5 min-w-4 px-1">
                  {updateCount}
                </Badge>
              )}
            </FilterBarItem>
          </FilterBar>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {tab === 'explore' ? (
          <MarketplaceBrowser
            installedNames={installedNames}
            source={source}
            onSourceChange={setSource}
            onAdd={setAddItem}
          />
        ) : tab === 'marketplaces' ? (
          <MarketplaceDiscover
            onBrowse={(id) => {
              setSource(id);
              setTab('explore');
            }}
          />
        ) : (
          <MarketplaceInstalledPanel projectId={projectId} onBrowse={() => setTab('explore')} />
        )}
      </div>

      {addDialog}
    </div>
  );
}

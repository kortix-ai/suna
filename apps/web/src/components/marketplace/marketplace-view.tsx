'use client';

/**
 * Inline Marketplace surface — rendered as a Customize section, sitting right
 * next to Skills / Agents / Commands (not a floating overlay). Browse the
 * registry and 1-click install skills straight into THIS project's repo, live
 * in the next session. Skills-only for now.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Store } from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useInstalledItems,
  useRegistryUpdates,
  useUninstallMarketplaceItem,
} from '@/hooks/marketplace';
import { getProjectDetail } from '@/lib/projects-client';
import type { MarketplaceItem } from '@/lib/marketplace-client';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { AddToProjectDialog } from './add-to-project-dialog';
import { MarketplaceBrowser } from './marketplace-browser';
import { MarketplaceDiscover } from './marketplace-discover';
import { MarketplaceInstalledPanel } from './marketplace-installed-panel';
import { MarketplaceItemDetail } from './marketplace-item-detail';

export function MarketplaceView({ projectId }: { projectId: string }) {
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const closeDetail = useMarketplaceDetailStore((s) => s.close);
  const [addItem, setAddItem] = useState<MarketplaceItem | null>(null);

  // Leave the detail when this surface unmounts so reopening starts on the
  // gallery, never on a stale detail page.
  useEffect(() => () => closeDetail(), [closeDetail]);
  const [tab, setTab] = useState<'explore' | 'marketplaces' | 'installed'>('explore');
  const [source, setSource] = useState('all');

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

  const onAdd = (it: MarketplaceItem) => setAddItem(it);

  // A selected item takes over the whole surface as a full-bleed detail page
  // (its own back button + top bar), so the section header is hidden here.
  if (openId) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MarketplaceItemDetail
          onBack={closeDetail}
          onAdd={onAdd}
          onRemove={onRemove}
          addLabel="Add to this project"
          installedNames={installedNames}
        />
        <AddToProjectDialog
          item={addItem}
          open={!!addItem}
          onOpenChange={(o) => !o && setAddItem(null)}
          fixedProjectId={projectId}
          fixedProjectName={projectName}
        />
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
              {installedCount > 0 && <span className="text-muted-foreground/60 ml-1">{installedCount}</span>}
              {updateCount > 0 && (
                <span className="ml-1.5 inline-flex min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
                  {updateCount}
                </span>
              )}
            </FilterBarItem>
          </FilterBar>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {tab === 'explore' ? (
          <>
            <p className="text-muted-foreground mb-4 text-sm">
              One click adds a skill into this project — live in the next session.
            </p>
            <MarketplaceBrowser
              installedNames={installedNames}
              source={source}
              onSourceChange={setSource}
              onAdd={onAdd}
            />
          </>
        ) : tab === 'marketplaces' ? (
          <>
            <p className="text-muted-foreground mb-4 text-sm">
              Enable sources to pull their skills into your catalog — any public GitHub repo of SKILL.md files works out of the box.
            </p>
            <MarketplaceDiscover
              onBrowse={(id) => {
                setSource(id);
                setTab('explore');
              }}
            />
          </>
        ) : (
          <MarketplaceInstalledPanel projectId={projectId} onBrowse={() => setTab('explore')} />
        )}
      </div>

      <AddToProjectDialog
        item={addItem}
        open={!!addItem}
        onOpenChange={(o) => !o && setAddItem(null)}
        fixedProjectId={projectId}
        fixedProjectName={projectName}
      />
    </div>
  );
}

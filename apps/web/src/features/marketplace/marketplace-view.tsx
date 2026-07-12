'use client';

import { useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { useInstalledItems, useMarketplaceItem, useMarketplaces, useMarketplaceItems } from '@/hooks/marketplace';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { MarketplaceDetail } from './marketplace-detail';
import { MarketplaceExplore } from './marketplace-explore';
import { MarketplaceInstalledPanel } from './marketplace-installed-panel';
import { MarketplaceSurfaceProvider, type MarketplaceSurface } from './marketplace-surface';

/** In-project marketplace (Customize → Marketplace). The Explore tab renders
 *  the exact same `MarketplaceExplore` as the public `/marketplace` page —
 *  same source rail, projects showcase, featured + sectioned skills, cards,
 *  and detail — just embedded in the panel and driven through the "project"
 *  surface (installs commit into THIS project, in-panel overlay navigation).
 *  The Installed tab is the one project-only surface. */
export function MarketplaceView({ projectId }: { projectId: string }) {
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);
  const closeDetail = useMarketplaceDetailStore((s) => s.close);

  const [tab, setTab] = useState<'explore' | 'installed'>('explore');
  const browseScrollContainerRef = useRef<HTMLDivElement>(null);

  const installed = useInstalledItems(projectId);
  const installedNames = useMemo(
    () => new Set((installed.data ?? []).map((i) => i.name)),
    [installed.data],
  );

  const surface = useMemo<MarketplaceSurface>(
    () => ({ variant: 'project', projectId, installedNames, openItem }),
    [projectId, installedNames, openItem],
  );

  return (
    <MarketplaceSurfaceProvider surface={surface}>
      {openId ? (
        <div className="h-full min-h-0 px-4 py-4">
          <MarketplaceDetailOverlay onBack={closeDetail} />
        </div>
      ) : (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as 'explore' | 'installed')}
          className="flex h-full min-h-0 flex-col"
        >
          {/* Fixed top bar — the tabs stay put; the tab panels below scroll. */}
          <div className="border-border/60 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
            <h2 className="text-foreground text-sm font-medium">Marketplace</h2>
            <TabsListCompact>
              <TabsTriggerCompact value="explore">Explore</TabsTriggerCompact>
              <TabsTriggerCompact value="installed">Installed</TabsTriggerCompact>
            </TabsListCompact>
          </div>

          <TabsContent value="explore" className="mt-0 min-h-0 flex-1 outline-none">
            <div className="h-full px-4 py-4">
              <MarketplaceExploreTab scrollContainerRef={browseScrollContainerRef} />
            </div>
          </TabsContent>
          <TabsContent value="installed" className="mt-0 min-h-0 flex-1 overflow-y-auto outline-none">
            <div className="mx-auto max-w-3xl px-4 py-4">
              <MarketplaceInstalledPanel projectId={projectId} onBrowse={() => setTab('explore')} />
            </div>
          </TabsContent>
        </Tabs>
      )}
    </MarketplaceSurfaceProvider>
  );
}

/** Fetches the catalog client-side (no SSR in-project) and renders the shared
 *  explore, embedded + scoped to authenticated reads. */
function MarketplaceExploreTab({
  scrollContainerRef,
}: {
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const marketplacesQuery = useMarketplaces({ publicOnly: false });
  const itemsQuery = useMarketplaceItems({ publicOnly: false });

  const marketplaces = marketplacesQuery.data?.marketplaces ?? [];
  const allItems = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);
  const projectItems = useMemo(
    () => allItems.filter((i) => i.type === 'registry:project'),
    [allItems],
  );

  if (itemsQuery.isLoading || marketplacesQuery.isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <MarketplaceExplore
      items={allItems}
      marketplaces={marketplaces}
      projectItems={projectItems}
      embedded
      syncUrl={false}
      publicOnly={false}
      scrollContainerRef={scrollContainerRef}
    />
  );
}

/** Fetches the open item by id and renders the shared detail as an in-panel
 *  overlay (the project surface makes its actions install into this project). */
function MarketplaceDetailOverlay({ onBack }: { onBack: () => void }) {
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const query = useMarketplaceItem(openId);

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex h-40 items-center justify-center">
        <Loading />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back
        </Button>
        <p className="text-muted-foreground text-sm">Couldn&apos;t load this item.</p>
      </div>
    );
  }
  return <MarketplaceDetail data={query.data} onBack={onBack} />;
}

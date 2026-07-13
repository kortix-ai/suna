'use client';

import { useMemo, useRef } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { useMarketplaceItem, useMarketplaces, useMarketplaceItems } from '@/hooks/marketplace';
import { useMarketplaceDetailStore } from '@/stores/marketplace-detail-store';
import { MarketplaceDetail, useDetailNav } from './marketplace-detail';
import { MarketplaceExplore } from './marketplace-explore';
import { MarketplaceSurfaceProvider, type MarketplaceSurface } from './marketplace-surface';

/** Stable empty set — installing is agent-driven now (no registry-lock to
 *  read), so there's no "installed" state to track here; kept as an empty
 *  `Set` purely so `MarketplaceSurface` consumers still compile. */
const NO_INSTALLED_NAMES = new Set<string>();

/** In-project marketplace (Customize → Marketplace). Renders the exact same
 *  `MarketplaceExplore` as the public `/marketplace` page — same source rail,
 *  projects showcase, featured + sectioned skills, cards, and detail — just
 *  embedded in the panel and driven through the "project" surface (adds
 *  start an agent-import session in THIS project, in-panel overlay
 *  navigation). */
export function MarketplaceView({ projectId }: { projectId: string }) {
  const openId = useMarketplaceDetailStore((s) => s.openId);
  const openItem = useMarketplaceDetailStore((s) => s.openItem);
  const closeDetail = useMarketplaceDetailStore((s) => s.close);

  const browseScrollContainerRef = useRef<HTMLDivElement>(null);

  const surface = useMemo<MarketplaceSurface>(
    () => ({ variant: 'project', projectId, installedNames: NO_INSTALLED_NAMES, openItem }),
    [projectId, openItem],
  );

  return (
    <MarketplaceSurfaceProvider surface={surface}>
      {openId ? (
        <div className="h-full min-h-0 px-4 py-4">
          <MarketplaceDetailOverlay onBack={closeDetail} />
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          {/* Fixed top bar — stays put; the content below scrolls. */}
          <div className="border-border/60 flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
            <h2 className="text-foreground text-sm font-medium">Marketplace</h2>
          </div>

          <div className="h-full min-h-0 flex-1 px-4 py-4">
            <MarketplaceExploreTab scrollContainerRef={browseScrollContainerRef} />
          </div>
        </div>
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
  const openItem = useMarketplaceDetailStore((s) => s.openItem);
  const query = useMarketplaceItem(openId);

  // Sibling order for ← / → browsing — the same catalog list the explore grid
  // renders. Clamped at the ends.
  const itemsQuery = useMarketplaceItems({ publicOnly: false });
  const ids = useMemo(() => (itemsQuery.data?.items ?? []).map((i) => i.id), [itemsQuery.data]);
  const nav = useDetailNav(ids, openId ?? undefined, openItem);

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
  return <MarketplaceDetail data={query.data} onBack={onBack} nav={nav} />;
}

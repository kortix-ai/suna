'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';

import { useMarketplaceItems } from '@/hooks/marketplace';
import type {
  MarketplaceItem,
  MarketplaceItemDetail,
  MarketplaceSummary,
} from '@/lib/marketplace-client';
import { marketplaceItemHref } from '@/lib/marketplace-slug';
import { MarketplaceDetail, useDetailNav } from './marketplace-detail';

/**
 * Public detail page wrapper — the SSR page can't hand `MarketplaceDetail`
 * function props, so this client shim computes the ← / → siblings from the
 * public catalog and routes between item pages. (The in-project overlay wires
 * the same nav through the detail store instead.)
 */
export function MarketplaceDetailPublic({
  data,
  company,
  otherProjects,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
  otherProjects?: MarketplaceItem[];
}) {
  const router = useRouter();
  const itemsQuery = useMarketplaceItems({ publicOnly: true });
  const ids = useMemo(() => (itemsQuery.data?.items ?? []).map((i) => i.id), [itemsQuery.data]);
  // nav-contract: prefetch-only — `DetailNav` carries opaque `onPrev`/`onNext`
  // callbacks that the shared pager also drives from ← / → keystrokes, so the
  // arrows cannot be anchors. Warm both neighbours instead.
  const nav = useDetailNav(ids, data.id, (id) => router.push(marketplaceItemHref(id)));

  const idx = ids.indexOf(data.id);
  useEffect(() => {
    if (idx < 0) return;
    for (const id of [ids[idx - 1], ids[idx + 1]]) {
      if (id) router.prefetch(marketplaceItemHref(id));
    }
  }, [ids, idx, router]);

  return (
    <MarketplaceDetail data={data} company={company} otherProjects={otherProjects} nav={nav} />
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';

import { useMarketplaceItems } from '@/hooks/marketplace';
import type {
  MarketplaceItem,
  MarketplaceItemDetail,
  MarketplaceSummary,
} from '@/lib/marketplace-client';
import { marketplaceItemHref } from '@/lib/marketplace-slug';
import { MarketplaceDetail } from './marketplace-detail';

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
  const idx = ids.indexOf(data.id);
  const prevId = idx > 0 ? ids[idx - 1] : undefined;
  const nextId = idx >= 0 && idx < ids.length - 1 ? ids[idx + 1] : undefined;

  return (
    <MarketplaceDetail
      data={data}
      company={company}
      otherProjects={otherProjects}
      nav={
        ids.length && idx >= 0
          ? {
              index: idx + 1,
              total: ids.length,
              onPrev: prevId ? () => router.push(marketplaceItemHref(prevId)) : undefined,
              onNext: nextId ? () => router.push(marketplaceItemHref(nextId)) : undefined,
            }
          : undefined
      }
    />
  );
}

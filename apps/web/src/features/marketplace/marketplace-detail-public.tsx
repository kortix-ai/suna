'use client';

import type {
  MarketplaceItem,
  MarketplaceItemDetail,
  MarketplaceSummary,
} from '@/lib/marketplace-client';
import { MarketplaceDetail } from './marketplace-detail';

/**
 * Public detail page wrapper — the SSR page renders this client boundary so
 * `MarketplaceDetail` can use client hooks. Navigation is plain links (Back,
 * breadcrumbs, the Related cards); the floating pager belongs to the in-project
 * overlay only.
 */
export function MarketplaceDetailPublic({
  data,
  company,
  related,
}: {
  data: MarketplaceItemDetail;
  company?: MarketplaceSummary;
  related?: MarketplaceItem[];
}) {
  return <MarketplaceDetail data={data} company={company} related={related} />;
}

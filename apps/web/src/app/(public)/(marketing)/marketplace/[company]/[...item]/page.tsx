import type { Metadata } from 'next';

import { MarketplacePublicDetail } from '@/features/marketplace/marketplace-public-detail';
import { getPublicMarketplaceItem } from '@/lib/marketplace-public';
import { pathPartsToItemId } from '@/lib/marketplace-slug';

interface PageParams {
  company: string;
  item: string[];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { company, item } = await params;
  const id = pathPartsToItemId(company, item);
  try {
    const detail = await getPublicMarketplaceItem(id);
    const description = detail.description ?? `${detail.title} on the Kortix Marketplace.`;
    return {
      title: `${detail.title} — Kortix Marketplace`,
      description,
      openGraph: { title: `${detail.title} — Kortix Marketplace`, description },
    };
  } catch {
    return { title: 'Marketplace — Kortix' };
  }
}

export default async function MarketplaceItemPage({ params }: { params: Promise<PageParams> }) {
  const { company, item } = await params;
  const id = pathPartsToItemId(company, item);
  return <MarketplacePublicDetail id={id} />;
}

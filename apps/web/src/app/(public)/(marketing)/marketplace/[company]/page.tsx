import type { Metadata } from 'next';

import { MarketplaceCompanyExplore } from '@/features/marketplace/marketplace-company-explore';
import { loadMarketplaceCompanyData, listPublicMarketplaces } from '@/lib/marketplace-public';
import { companyIdFromSlug, companySlugFromId } from '@/lib/marketplace-slug';

export const revalidate = 3600;

interface PageParams {
  company: string;
}

export async function generateStaticParams() {
  try {
    const { marketplaces } = await listPublicMarketplaces();
    return marketplaces.map((m) => ({ company: companySlugFromId(m.id) }));
  } catch {
    return [];
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { company } = await params;
  const marketplaceId = companyIdFromSlug(company);
  try {
    const { marketplaces } = await listPublicMarketplaces();
    const match = marketplaces.find((m) => m.id === marketplaceId);
    const label = match?.label ?? marketplaceId;
    return {
      title: `${label} — Kortix Marketplace`,
      description: `Browse skills, agents, and commands from ${label}.`,
      openGraph: {
        title: `${label} — Kortix Marketplace`,
        description: `Browse skills, agents, and commands from ${label}.`,
      },
    };
  } catch {
    return { title: 'Marketplace — Kortix' };
  }
}

export default async function MarketplaceCompanyPage({ params }: { params: Promise<PageParams> }) {
  const { company } = await params;
  const marketplaceId = companyIdFromSlug(company);

  const { itemsPage, marketplacesPage } = await loadMarketplaceCompanyData(marketplaceId);

  return (
    <MarketplaceCompanyExplore
      marketplaceId={marketplaceId}
      initialItemsPage={itemsPage}
      marketplaces={marketplacesPage.marketplaces}
    />
  );
}

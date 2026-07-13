import type { Metadata } from 'next';

import { MarketplaceExplore } from '@/features/marketplace/marketplace-explore';
import { loadMarketplaceExploreData } from '@/lib/marketplace-public';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Marketplace — Extend the agent',
  description:
    'Browse skills, agents, and commands from every source. Add them to a Kortix project in one click.',
  openGraph: {
    title: 'Kortix Marketplace — Extend the agent',
    description:
      'Browse skills, agents, and commands from every source. Add them to a Kortix project in one click.',
    url: `${CANONICAL_ORIGIN}/marketplace`,
  },
  alternates: { canonical: `${CANONICAL_ORIGIN}/marketplace` },
};

export default async function MarketplacePage() {
  const { itemsPage, marketplacesPage } = await loadMarketplaceExploreData();

  return (
    <MarketplaceExplore items={itemsPage.items} marketplaces={marketplacesPage.marketplaces} />
  );
}

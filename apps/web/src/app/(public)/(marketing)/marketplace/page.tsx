import type { Metadata } from 'next';

import { MarketplaceExplore } from '@/features/marketplace/marketplace-explore';
import { PublicMarketplaceProvider } from '@/features/marketplace/marketplace-public-surface';
import { loadMarketplaceExploreData } from '@/lib/marketplace-public';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Marketplace — Clone a ready-made Kortix project',
  description:
    'Clone a full, working Kortix project in one click, or add skills from every source into your own.',
  openGraph: {
    title: 'Kortix Marketplace — Clone a ready-made Kortix project',
    description:
      'Clone a full, working Kortix project in one click, or add skills from every source into your own.',
  },
};

export default async function MarketplacePage() {
  const { itemsPage, marketplacesPage, projectItems } = await loadMarketplaceExploreData();

  return (
    <PublicMarketplaceProvider>
      <MarketplaceExplore
        items={itemsPage.items}
        marketplaces={marketplacesPage.marketplaces}
        projectItems={projectItems}
      />
    </PublicMarketplaceProvider>
  );
}

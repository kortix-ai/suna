import type { Metadata } from 'next';

import { MarketplaceExplore } from '@/features/marketplace/marketplace-explore';
import { PublicMarketplaceProvider } from '@/features/marketplace/marketplace-public-surface';
import { loadMarketplaceExploreData } from '@/lib/marketplace-public';
import { socialMetadata } from '@/lib/seo/metadata';
import { CANONICAL_ORIGIN } from '@/lib/site-metadata';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Marketplace — Clone a ready-made dosco project',
  description:
    'Clone a full, working dosco project in one click, or add skills from every source into your own.',
  alternates: { canonical: `${CANONICAL_ORIGIN}/marketplace` },
  ...socialMetadata(
    'dosco Marketplace — Clone a ready-made dosco project',
    'Clone a full, working dosco project in one click, or add skills from every source into your own.',
    `${CANONICAL_ORIGIN}/marketplace`,
  ),
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

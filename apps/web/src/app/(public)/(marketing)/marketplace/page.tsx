import type { Metadata } from 'next';

import { MarketplaceExplore } from '@/features/marketplace/marketplace-explore';
import {
  listPublicMarketplaceItems,
  listPublicMarketplaces,
} from '@/lib/marketplace-public';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Marketplace — Extend the agent',
  description:
    'Browse skills, agents, and commands from every source. Add them to a Kortix project in one click.',
  openGraph: {
    title: 'Kortix Marketplace — Extend the agent',
    description:
      'Browse skills, agents, and commands from every source. Add them to a Kortix project in one click.',
  },
};

export default async function MarketplacePage() {
  const [itemsPage, marketplacesPage] = await Promise.all([
    listPublicMarketplaceItems(),
    listPublicMarketplaces(),
  ]);

  return (
    <MarketplaceExplore
      items={itemsPage.items}
      marketplaces={marketplacesPage.marketplaces}
    />
  );
}

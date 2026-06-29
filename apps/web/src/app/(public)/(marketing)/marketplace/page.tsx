import type { Metadata } from 'next';

import { MarketplaceExplore } from '@/features/marketplace/marketplace-explore';

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

export default function MarketplacePage() {
  return <MarketplaceExplore />;
}

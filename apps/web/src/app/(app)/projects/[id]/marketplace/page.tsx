'use client';

import { useParams } from 'next/navigation';

import { MarketplaceView } from '@/features/marketplace/marketplace-view';

/** Installing agents and skills is an acquisition flow, not a setting. */
export default function ProjectMarketplacePage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? '';
  if (!projectId) return null;
  return <MarketplaceView projectId={projectId} />;
}

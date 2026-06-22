'use client';

import { useMarketplaceEnabled } from '@/components/projects/marketplace/marketplace-nav';
import { Button } from '@/components/ui/button';
import { useCustomizeStore } from '@/stores/customize-store';
import { Store } from 'lucide-react';

export function MarketplaceSectionButton({ projectId }: { projectId: string }) {
  const enabled = useMarketplaceEnabled(projectId);
  const setSection = useCustomizeStore((s) => s.setSection);

  if (!enabled) return null;

  return (
    <Button size="sm" variant="secondary" onClick={() => setSection('marketplace')}>
      <Store className="size-3 shrink-0" />
      Marketplace
    </Button>
  );
}

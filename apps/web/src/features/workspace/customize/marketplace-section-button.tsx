'use client';

import { useMarketplaceEnabled } from '@/components/workspaces/marketplace/marketplace-nav';
import { Button } from '@/components/ui/button';
import { useCustomizeStore } from '@/stores/customize-store';
import { StorefrontIcon as Store } from '@phosphor-icons/react';

export function MarketplaceSectionButton({ workspaceId }: { workspaceId: string }) {
  const enabled = useMarketplaceEnabled(workspaceId);
  const setSection = useCustomizeStore((s) => s.setSection);

  if (!enabled) return null;

  return (
    <Button size="sm" variant="secondary" onClick={() => setSection('marketplace')}>
      <Store className="shrink-0" />
      Marketplace
    </Button>
  );
}

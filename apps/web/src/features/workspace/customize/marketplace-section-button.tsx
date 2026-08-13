'use client';

import { useMarketplaceEnabled } from '@/components/projects/marketplace/marketplace-nav';
import { Button } from '@/components/ui/button';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { StorefrontIcon as Store } from '@phosphor-icons/react';

export function MarketplaceSectionButton({ projectId }: { projectId: string }) {
  const enabled = useMarketplaceEnabled(projectId);
  const { navigate } = useSettingsNav();

  if (!enabled) return null;

  return (
    <Button size="sm" variant="secondary" onClick={() => navigate('marketplace')}>
      <Store className="shrink-0" />
      Marketplace
    </Button>
  );
}

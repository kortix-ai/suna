'use client';

/**
 * "Marketplace" action for a Customize section header (Skills / Agents /
 * Commands) — a shortcut that jumps to the Marketplace section of the same
 * Customize surface. Hidden unless the experimental `marketplace` feature is
 * enabled for this project, so the whole surface lives behind one flag while
 * it's WIP.
 */

import { Store } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useMarketplaceEnabled } from '@/components/projects/marketplace/marketplace-nav';
import { useCustomizeStore } from '@/stores/customize-store';

export function MarketplaceSectionButton({ projectId }: { projectId: string }) {
  const enabled = useMarketplaceEnabled(projectId);
  const setSection = useCustomizeStore((s) => s.setSection);

  if (!enabled) return null;

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 gap-1 px-2 text-xs"
      onClick={() => setSection('marketplace')}
    >
      <Store className="h-3 w-3" />
      Marketplace
    </Button>
  );
}

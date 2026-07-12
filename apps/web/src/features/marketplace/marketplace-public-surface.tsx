'use client';

import { useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';

import { marketplaceItemHref } from '@/lib/marketplace-slug';
import { MarketplaceSurfaceProvider, type MarketplaceSurface } from './marketplace-surface';

const NO_INSTALLED = new Set<string>();

/** Provides the public marketplace surface (route-based navigation, no project
 *  binding, no installed state) to the shared cards/detail. Wrap the public
 *  `/marketplace` explore + item detail in this. */
export function PublicMarketplaceProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const surface = useMemo<MarketplaceSurface>(
    () => ({
      variant: 'public',
      installedNames: NO_INSTALLED,
      itemHref: marketplaceItemHref,
      openItem: (id) => router.push(marketplaceItemHref(id)),
    }),
    [router],
  );
  return <MarketplaceSurfaceProvider surface={surface}>{children}</MarketplaceSurfaceProvider>;
}

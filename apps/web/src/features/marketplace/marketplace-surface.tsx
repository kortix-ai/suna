'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { marketplaceItemHref } from '@/lib/marketplace-slug';

/**
 * The two surfaces the marketplace UI renders on share one set of components
 * (grid, card, detail) but differ in a few behaviours — navigation, install
 * target, and installed-state awareness. Rather than fork the components, they
 * read those differences from this context. A discriminated union on
 * `variant` lets consumers narrow to the fields that only make sense on one
 * surface (`projectId`/`installedNames` on project, `itemHref` on public)
 * without non-null assertions.
 *
 * - **public** (`/marketplace`): route-based navigation (`itemHref` → real
 *   `<Link>`), no project bound, no installed state.
 * - **project** (Customize → Marketplace): in-panel overlay navigation
 *   (`openItem` drives the detail store, no `itemHref`), installs commit into
 *   `projectId`, and `installedNames` drives "Installed" badges + Re-install /
 *   Remove affordances.
 */
export type MarketplaceSurface =
  | {
      variant: 'public';
      /** Cards/links render a real `<Link href>` (public, crawlable). */
      itemHref: (id: string) => string;
      /** Route push to the item's detail page. */
      openItem: (id: string) => void;
    }
  | {
      variant: 'project';
      /** The fixed install/commit target. */
      projectId: string;
      /** Names present in this project's registry-lock — drives "Installed"
       *  badges + Re-install / Remove affordances. */
      installedNames: Set<string>;
      /** Opens the detail store overlay (no route to push to). */
      openItem: (id: string) => void;
    };

const PUBLIC_DEFAULT: MarketplaceSurface = {
  variant: 'public',
  itemHref: marketplaceItemHref,
  openItem: () => {},
};

const MarketplaceSurfaceContext = createContext<MarketplaceSurface>(PUBLIC_DEFAULT);

export function MarketplaceSurfaceProvider({
  surface,
  children,
}: {
  surface: MarketplaceSurface;
  children: ReactNode;
}) {
  return (
    <MarketplaceSurfaceContext.Provider value={surface}>
      {children}
    </MarketplaceSurfaceContext.Provider>
  );
}

export function useMarketplaceSurface(): MarketplaceSurface {
  return useContext(MarketplaceSurfaceContext);
}

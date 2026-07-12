'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The two surfaces the marketplace UI renders on share one set of components
 * (grid, card, detail) but differ in a few behaviours — navigation, install
 * target, and installed-state awareness. Rather than fork the components, they
 * read those differences from this context.
 *
 * - **public** (`/marketplace`): route-based navigation (`itemHref` → real
 *   `<Link>`), no project bound, no installed state.
 * - **project** (Customize → Marketplace): in-panel overlay navigation
 *   (`openItem` drives the detail store, no `itemHref`), installs commit into
 *   `projectId`, and `installedNames` drives "Installed" badges + Re-install /
 *   Remove affordances.
 */
export interface MarketplaceSurface {
  variant: 'public' | 'project';
  /** Set on the project variant — the fixed install/commit target. */
  projectId?: string;
  /** Names present in this project's registry-lock — empty for public. */
  installedNames: Set<string>;
  /** Open an item's detail (route push for public, detail store for project). */
  openItem: (id: string) => void;
  /** When present, cards/links render a real `<Link href>` (public, crawlable);
   *  when absent, they render a `<button onClick={openItem}>` (project overlay). */
  itemHref?: (id: string) => string;
}

const PUBLIC_DEFAULT: MarketplaceSurface = {
  variant: 'public',
  installedNames: new Set(),
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

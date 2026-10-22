'use client';

import { useEffect, useState } from 'react';

/**
 * The marketplace list URL the person last saw (`?source=`, `?q=`), so Back
 * from an item lands on the same filtered search instead of a bare list.
 * Per tab; storage can throw (private window), so every access is guarded.
 */
const KEY = 'marketplace:list-href';

export function rememberMarketplaceListHref(href: string): void {
  try {
    sessionStorage.setItem(KEY, href);
  } catch {
    // Back falls back to the bare list.
  }
}

/** `/marketplace` until mounted, then the remembered list URL. */
export function useMarketplaceListHref(): string {
  const [href, setHref] = useState('/marketplace');
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(KEY);
      if (stored?.startsWith('/')) setHref(stored);
    } catch {
      // Keep the bare list.
    }
  }, []);
  return href;
}

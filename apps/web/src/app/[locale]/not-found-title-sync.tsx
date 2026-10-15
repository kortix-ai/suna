'use client';

import { useEffect } from 'react';

import { siteMetadata } from '@/lib/site-metadata';

/**
 * The client-side guard for the 404 tab title.
 *
 * A client-side navigation whose flight head never mounts — the not-found
 * render replaces a layout that itself aborted, e.g. /blog matching
 * [locale]='blog' — carries no <title>, and the tree's own metadata commit
 * re-asserts the previous default over any one-shot write (the race
 * features/session/session-tab-title-sync.tsx measured at 306ms → 324ms).
 * No server-side metadata export can reach that render: the metadata outlet
 * lives inside the aborted layout.
 *
 * So the sync keeps watch for as long as the boundary is mounted: it writes
 * the 404 title once, and re-writes it whenever something clobbers the tab
 * title while the 404 page is on screen. It never fights a correct title —
 * any title that already contains the 404 heading (the boundary's own
 * metadata, composed by the [locale] layout's `title.template`, or the
 * hard-load's) is left exactly as it is — and it disconnects on unmount so
 * the next page's metadata owns the tab again.
 */
export function NotFoundTitleSync({ heading }: { heading: string }) {
  useEffect(() => {
    // The composed form the [locale] layout's `title.template` gives every
    // other page, so a sync write reads like a metadata write.
    const full = `${heading} | ${siteMetadata.name}`;
    const ensureTitle = () => {
      if (!document.title.includes(heading)) document.title = full;
    };
    ensureTitle();
    const observer = new MutationObserver(ensureTitle);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [heading]);

  return null;
}

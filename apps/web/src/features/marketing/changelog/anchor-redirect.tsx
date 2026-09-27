'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { changelogPageHref } from './paging';

/**
 * Keeps old release deep links working after pagination. `/changelog#v0.12.1`
 * was shared when every release lived on one page; that release now renders on
 * a later page. When the hash names a release that is not on this page, move
 * to the page that renders it, keeping the hash so the browser scrolls to it.
 */
export function ChangelogAnchorRedirect({
  page,
  tagPages,
}: {
  page: number;
  tagPages: Record<string, number>;
}) {
  const router = useRouter();
  useEffect(() => {
    const tag = decodeURIComponent(window.location.hash.slice(1));
    if (!tag || document.getElementById(tag)) return;
    const target = tagPages[tag];
    if (target && target !== page) router.replace(`${changelogPageHref(target)}#${tag}`);
  }, [page, tagPages, router]);
  return null;
}

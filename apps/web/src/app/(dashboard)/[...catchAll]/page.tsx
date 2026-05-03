'use client';

import { use, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTabStore } from '@/stores/tab-store';
import { resolveTabFromPathname } from '@/lib/tab-route-resolver';

interface CatchAllPageProps {
  params: Promise<{ catchAll: string[] }>;
}

/**
 * Dashboard catch-all page — handles any URL that:
 *   1. Falls under the (dashboard) route group
 *   2. Does NOT have its own dedicated page.tsx
 *
 * This prevents the global not-found.tsx from showing when a user hard-reloads
 * a tab-based URL (e.g. /browser, /desktop, /memory, /sessions/:id, etc.).
 *
 * On mount it resolves the current pathname to a Tab descriptor via
 * `resolveTabFromPathname`, then opens/activates the tab so the
 * SessionTabsContainer makes the right content visible.
 *
 * If the pathname is completely unknown it redirects to /dashboard rather
 * than showing a 404, because the dashboard is always a safe landing point.
 *
 * Renders nothing — the tab container manages all visual output.
 */
export default function DashboardCatchAllPage({ params }: CatchAllPageProps) {
  const { catchAll } = use(params);
  const router = useRouter();
  const { tabs, openTab, setActiveTab } = useTabStore();
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    // Reconstruct the pathname from the catchAll segments
    const pathname = '/' + (catchAll ?? []).join('/');

    const descriptor = resolveTabFromPathname(pathname);

    if (!descriptor) {
      router.replace('/dashboard');
      return;
    }

    if (tabs[descriptor.id]) {
      setActiveTab(descriptor.id);
    } else {
      openTab({
        id: descriptor.id,
        title: descriptor.title,
        type: descriptor.type,
        href: descriptor.href,
        ...(descriptor.metadata ? { metadata: descriptor.metadata } : {}),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

'use client';

import { lazy, Suspense, use, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTabStore } from '@/stores/tab-store';
import { resolveTabFromPathname } from '@/lib/tab-route-resolver';
import { getActiveInstanceIdFromCookie, buildInstancePath } from '@/lib/instance-routes';
import { featureFlags } from '@/lib/feature-flags';

const PageTabContent = lazy(() =>
  import('@/components/tabs/page-tab-content').then((m) => ({
    default: m.PageTabContent,
  })),
);

interface CatchAllPageProps {
  params: Promise<{ catchAll: string[] }>;
}

export default function DashboardCatchAllPage({ params }: CatchAllPageProps) {
  const { catchAll } = use(params);
  const router = useRouter();
  const { tabs, openTab, setActiveTab } = useTabStore();
  const handledRef = useRef(false);

  const pathname = '/' + (catchAll ?? []).join('/');
  const descriptor = resolveTabFromPathname(pathname);

  useEffect(() => {
    if (featureFlags.newLayout) return;
    if (handledRef.current) return;
    handledRef.current = true;

    if (!descriptor) {
      router.replace('/dashboard');
      const iid = getActiveInstanceIdFromCookie();
      router.replace(iid ? buildInstancePath(iid, '/dashboard') : '/dashboard');
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

  if (featureFlags.newLayout) {
    if (!descriptor) {
      if (typeof window !== 'undefined') {
        const iid = getActiveInstanceIdFromCookie();
        router.replace(iid ? buildInstancePath(iid, '/dashboard') : '/dashboard');
      }
      return null;
    }
    return (
      <Suspense fallback={null}>
        <PageTabContent href={descriptor.href} />
      </Suspense>
    );
  }

  return null;
}

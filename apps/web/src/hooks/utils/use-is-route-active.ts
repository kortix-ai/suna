'use client';

import { useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { normalizeAppPathname } from '@/lib/instance-routes';

function normalizeRoute(path: string): string {
  const cleanPath = path.split('?')[0]?.split('#')[0] || path;
  return decodeURIComponent(normalizeAppPathname(cleanPath));
}

export function useIsRouteActive(expectedPath: string) {
  const pathname = usePathname() ?? '';

  const activePath = useMemo(() => normalizeRoute(pathname), [pathname]);
  const targetPath = useMemo(() => normalizeRoute(expectedPath), [expectedPath]);

  return activePath === targetPath;
}

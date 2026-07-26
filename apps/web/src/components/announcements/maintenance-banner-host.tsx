'use client';

import { useMaintenanceConfig } from '@/hooks/edge-flags';
import { isMaintenanceProductRoute } from '@/lib/maintenance-client';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

import { MaintenanceBanner } from './maintenance-banner';

/**
 * Global mount point for the maintenance / incident banner.
 *
 * Reads the live maintenance config (polled via {@link useMaintenanceConfig})
 * and renders {@link MaintenanceBanner} for the `info`, `warning`, and
 * `critical` levels. `none` renders nothing and `blocking` is handled upstream
 * by middleware (redirect to `/maintenance`), so this is safe to mount once,
 * app-wide. Without this host the admin-configured banner never reaches users.
 */
export function MaintenanceBannerHost() {
  const { data: config } = useMaintenanceConfig();
  const pathname = usePathname();

  useEffect(() => {
    if (config?.level !== 'blocking' || !isMaintenanceProductRoute(pathname)) return;

    const from = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/maintenance?from=${encodeURIComponent(from)}`);
  }, [config?.level, pathname]);

  if (!config) return null;
  return <MaintenanceBanner config={config} />;
}

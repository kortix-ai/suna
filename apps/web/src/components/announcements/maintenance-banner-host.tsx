'use client';

import { useMaintenanceConfig } from '@/hooks/edge-flags';

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
  if (!config) return null;
  return <MaintenanceBanner config={config} />;
}

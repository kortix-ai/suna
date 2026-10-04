'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar';
import { useDrives } from '@/hooks/drives/use-drives';
import { useIsMobile } from '@/hooks/utils';
import { useTranslations } from '@/i18n/use-translations';
import { useFeatureFlag } from '@kortix/sdk/react';
import { HardDrivesIcon } from '@phosphor-icons/react';
import { useParams, usePathname } from 'next/navigation';
import { useCallback } from 'react';

/**
 * Drive entry: the caller's drives, the company drives this project uses and
 * the project's agent drives. Same row contract as Files beside it — a
 * hover-prefetching Link, never router.push. Shown once the project turns on
 * the `drives` feature flag; loading counts as off.
 */
export function ProjectDriveNavItem() {
  const t = useTranslations('sidebar');
  const pathname = usePathname();
  const params = useParams<{ id: string }>();
  const projectId = params?.id;
  const isMobile = useIsMobile();
  const { setOpenMobile } = useSidebar();
  const drivesGate = useFeatureFlag(projectId, 'drives');
  const tDrives = useTranslations('drives');
  // Open conflict copies across the caller's drives: the row's only badge.
  const drives = useDrives(projectId, drivesGate.enabled);
  const conflicts = (drives.data ?? []).reduce((sum, drive) => sum + (drive.openConflicts ?? 0), 0);
  const isActive = !!pathname && /^\/projects\/[^/]+\/drive(\/|$)/.test(pathname);

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  if (!projectId || !drivesGate.enabled) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={t('drive')}
        className="group/menu-button text-sidebar-foreground relative"
      >
        <HoverPrefetchLink href={`/projects/${projectId}/drive`} prefetch onClick={handleClick}>
          <HardDrivesIcon />
          {t('drive')}
          {conflicts > 0 ? (
            <span
              className="text-kortix-orange ml-auto text-xs font-medium tabular-nums"
              aria-label={tDrives('conflictCount', { count: conflicts })}
            >
              {conflicts}
            </span>
          ) : null}
        </HoverPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
